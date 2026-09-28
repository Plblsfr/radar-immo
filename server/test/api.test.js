/* Tests de l'API avec une vraie base PostgreSQL et un faux backend d'authentification.
 * Nécessite TEST_DATABASE_URL (ex. postgres://postgres@localhost:5432/radar_test) ; sinon, ignorés.
 * Chaque exécution utilise son propre schéma, supprimé à la fin. */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { createStore } from '../src/store.js';
import { createAuthClient } from '../src/auth.js';
import { buildApp, isAllowedOrigin } from '../src/app.js';

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = DB_URL ? false : 'TEST_DATABASE_URL non défini';

let app, db, authServer, authCalls = 0;
const schema = 'radar_test_' + process.pid;
const H = (user) => ({ authorization: `Bearer good-${user}` });

describe('API', { skip }, () => {
  before(async () => {
    // Faux backend d'authentification : « good-<id> » valide, « expired » refusé, « boom » en panne.
    authServer = createServer((req, res) => {
      authCalls++;
      const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (req.method !== 'GET' || req.url !== '/verify') { res.writeHead(404); return res.end(); }
      if (tok.startsWith('good-')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: tok.slice(5), email: 'x@y.z' })); }
      if (tok === 'boom') { res.writeHead(502); return res.end(); }
      res.writeHead(401); res.end();
    });
    await new Promise((r) => authServer.listen(0, '127.0.0.1', r));
    const config = loadConfig({
      DATABASE_URL: DB_URL, DB_SCHEMA: schema,
      AUTH_VERIFY_URL: `http://127.0.0.1:${authServer.address().port}/verify`,
      CORS_ORIGINS: 'https://app.example.fr', SYNC_PULL_MAX: '3'
    });
    db = createDb(config);
    await db.migrate({});
    assert.deepEqual(await db.migrate({}), [], 'les migrations sont idempotentes');
    app = buildApp({ config, db, store: createStore(db), authClient: createAuthClient(config.auth), logger: false });
    await app.ready();
  });

  after(async () => {
    await app?.close();
    await db?.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db?.close();
    authServer?.close();
  });

  test('les tables sont dans le schéma dédié', async () => {
    const { rows } = await db.pool.query('SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1', [schema]);
    assert.deepEqual(rows.map((r) => r.table_name), ['listings', 'schema_migrations', 'settings', 'users']);
  });

  test('santé', async () => {
    assert.equal((await app.inject('/health')).statusCode, 200);
    assert.equal((await app.inject('/health/ready')).json().database, 'ok');
  });

  test('authentification : absent → 401, refusé → 401, backend en panne → 503, valide → 200', async () => {
    let r = await app.inject('/v1/me');
    assert.equal(r.statusCode, 401); assert.equal(r.json().error, 'missing_token');
    r = await app.inject({ url: '/v1/me', headers: { authorization: 'Bearer expired' } });
    assert.equal(r.statusCode, 401); assert.equal(r.json().error, 'invalid_token');
    r = await app.inject({ url: '/v1/me', headers: { authorization: 'Bearer boom' } });
    assert.equal(r.statusCode, 503); assert.equal(r.json().error, 'auth_unavailable');
    const before = authCalls;
    r = await app.inject({ url: '/v1/me', headers: H('alice') });
    assert.equal(r.statusCode, 200); assert.deepEqual(r.json(), { userId: 'alice' });
    await app.inject({ url: '/v1/me', headers: H('alice') });
    assert.equal(authCalls - before, 1, 'le second appel utilise le cache');
  });

  test('CORS : front-end et extensions autorisés, autres origines refusées', async () => {
    const pre = (origin) => app.inject({ method: 'OPTIONS', url: '/v1/me', headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
    assert.equal((await pre('https://app.example.fr')).headers['access-control-allow-origin'], 'https://app.example.fr');
    assert.equal((await pre('chrome-extension://abcdef')).headers['access-control-allow-origin'], 'chrome-extension://abcdef');
    assert.equal((await pre('https://evil.example')).headers['access-control-allow-origin'], undefined);
    assert.equal(isAllowedOrigin('chrome-extension://zzz', { origins: [], allowExtensions: true, extensionIds: ['abc'] }), false);
    assert.equal(isAllowedOrigin('moz-extension://123-456', { origins: [], allowExtensions: true, extensionIds: ['abc'] }), true);
  });

  test('critères : lecture vide, écriture, conflit si plus ancien', async () => {
    let r = await app.inject({ url: '/v1/settings', headers: H('bob') });
    assert.deepEqual(r.json(), { data: null, updatedAt: null });
    r = await app.inject({ method: 'PUT', url: '/v1/settings', headers: H('bob'), payload: { data: { city: 'Nantes' }, updatedAt: 2000 } });
    assert.equal(r.statusCode, 200); assert.equal(r.json().data.city, 'Nantes');
    r = await app.inject({ method: 'PUT', url: '/v1/settings', headers: H('bob'), payload: { data: { city: 'Brest' }, updatedAt: 1000 } });
    assert.equal(r.statusCode, 409); assert.equal(r.json().current.data.city, 'Nantes');
    r = await app.inject({ method: 'PUT', url: '/v1/settings', headers: H('bob'), payload: { data: { city: 'Lyon' } } });
    assert.equal(r.json().data.city, 'Lyon');
    r = await app.inject({ method: 'PUT', url: '/v1/settings', headers: H('bob'), payload: { data: 'x' } });
    assert.equal(r.statusCode, 400);
  });

  test('synchronisation entre deux appareils, dernière écriture gagnante et suppressions', async () => {
    const sync = (payload) => app.inject({ method: 'POST', url: '/v1/sync', headers: H('carol'), payload }).then((r) => { assert.equal(r.statusCode, 200, r.body); return r.json(); });
    // Appareil A pousse 2 annonces et ses critères
    let a = await sync({ since: 0, settings: { data: { city: 'Rennes' }, updatedAt: 100 }, listings: [
      { id: 'leboncoin:1', updatedAt: 100, data: { price: 150000, saved: true, status: 'new' } },
      { id: 'pap:2', updatedAt: 100, data: { price: 99000 } }
    ] });
    assert.deepEqual(a.applied, { settings: true, listings: 2, ignored: 0 });
    // Appareil B récupère tout depuis zéro
    let b = await sync({ since: 0 });
    assert.equal(b.listings.length, 2); assert.equal(b.settings.data.city, 'Rennes');
    assert.equal(b.listings[0].data.id, 'leboncoin:1');
    // B modifie une annonce (plus récente) ; A pousse une version plus ancienne → ignorée
    b = await sync({ since: b.cursor, listings: [{ id: 'leboncoin:1', updatedAt: 300, data: { price: 145000, saved: true } }] });
    assert.equal(b.applied.listings, 1);
    const stale = await sync({ since: a.cursor, listings: [{ id: 'leboncoin:1', updatedAt: 200, data: { price: 1 } }] });
    assert.equal(stale.applied.ignored, 1);
    assert.equal(stale.listings.find((l) => l.id === 'leboncoin:1').data.price, 145000, 'A reçoit la version de B');
    // Suppression propagée comme une tombe
    await sync({ since: 0, listings: [{ id: 'pap:2', updatedAt: 400, deleted: true }] });
    const after = await sync({ since: stale.cursor });
    assert.deepEqual(after.listings.map((l) => [l.id, l.deleted, l.data]), [['pap:2', true, null]]);
    // Rien de neuf → réponse vide, curseur stable
    const idle = await sync({ since: after.cursor });
    assert.equal(idle.listings.length, 0); assert.equal(idle.settings, null); assert.equal(idle.cursor, after.cursor);
  });

  test('synchronisation paginée (hasMore)', async () => {
    const listings = Array.from({ length: 7 }, (_, i) => ({ id: 'site:' + i, updatedAt: 10, data: { price: i } }));
    const H2 = H('dave');
    await app.inject({ method: 'POST', url: '/v1/sync', headers: H2, payload: { listings } });
    const seen = []; let since = 0, more = true, pages = 0;
    while (more) {
      const r = (await app.inject({ method: 'POST', url: '/v1/sync', headers: H2, payload: { since } })).json();
      seen.push(...r.listings.map((l) => l.id)); since = r.cursor; more = r.hasMore; pages++;
    }
    assert.equal(pages, 3); assert.equal(new Set(seen).size, 7);
  });

  test('horodatages dans le futur ramenés à maintenant + 5 min', async () => {
    const far = Date.now() + 365 * 24 * 3600e3;
    const r = (await app.inject({ method: 'POST', url: '/v1/sync', headers: H('erin'), payload: { listings: [{ id: 'x:1', updatedAt: far, data: {} }] } })).json();
    assert.ok(r.listings[0].updatedAt < Date.now() + 6 * 60e3);
  });

  test('isolation : un utilisateur ne voit jamais les données d\'un autre', async () => {
    const r = await app.inject({ url: '/v1/listings/leboncoin:1', headers: H('mallory') });
    assert.equal(r.statusCode, 404);
    const s = (await app.inject({ method: 'POST', url: '/v1/sync', headers: H('mallory'), payload: {} })).json();
    assert.equal(s.listings.length, 0);
  });

  test('API du front-end : liste, filtre, détail, modification, suppression', async () => {
    const h = H('carol');
    let r = await app.inject({ url: '/v1/listings?saved=true', headers: h });
    assert.equal(r.json().total, 1); assert.equal(r.json().items[0].id, 'leboncoin:1');
    r = await app.inject({ method: 'PATCH', url: '/v1/listings/' + encodeURIComponent('leboncoin:1'), headers: h, payload: { status: 'visit', notes: 'Visite samedi', checklist: { 0: true } } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().status, 'visit'); assert.equal(r.json().price, 145000, 'les autres champs sont conservés');
    assert.ok(r.json().updatedAt > 300);
    r = await app.inject({ url: '/v1/listings?status=visit', headers: h });
    assert.equal(r.json().total, 1);
    r = await app.inject({ method: 'PATCH', url: '/v1/listings/leboncoin:1', headers: h, payload: { status: 'nimporte' } });
    assert.equal(r.statusCode, 400);
    r = await app.inject({ method: 'PATCH', url: '/v1/listings/leboncoin:1', headers: h, payload: { price: 1 } });
    assert.equal(r.statusCode, 400, 'seuls les champs de suivi sont modifiables');
    // La modification est renvoyée à l'extension par la synchro
    const s = (await app.inject({ method: 'POST', url: '/v1/sync', headers: h, payload: { since: 0 } })).json();
    assert.equal(s.listings.find((l) => l.id === 'leboncoin:1').data.notes, 'Visite samedi');
    r = await app.inject({ method: 'DELETE', url: '/v1/listings/leboncoin:1', headers: h });
    assert.equal(r.statusCode, 204);
    r = await app.inject({ url: '/v1/listings/leboncoin:1', headers: h });
    assert.equal(r.statusCode, 404);
  });

  test('export et effacement complet', async () => {
    const h = H('frank');
    await app.inject({ method: 'POST', url: '/v1/sync', headers: h, payload: { settings: { data: { city: 'Caen' }, updatedAt: 5 }, listings: [{ id: 'a:1', updatedAt: 5, data: { saved: true } }] } });
    let r = (await app.inject({ url: '/v1/export', headers: h })).json();
    assert.equal(r.settings.city, 'Caen'); assert.deepEqual(Object.keys(r.listings), ['a:1']);
    assert.equal((await app.inject({ method: 'DELETE', url: '/v1/data', headers: h })).statusCode, 204);
    r = (await app.inject({ url: '/v1/export', headers: h })).json();
    assert.equal(r.settings, null); assert.deepEqual(r.listings, {});
    const s = (await app.inject({ method: 'POST', url: '/v1/sync', headers: h, payload: { since: 0 } })).json();
    assert.deepEqual(s.listings.map((l) => l.deleted), [true], 'la suppression se propage aux autres appareils');
  });

  test('limites de taille', async () => {
    const big = { description: 'x'.repeat(70 * 1024) };
    const r = await app.inject({ method: 'POST', url: '/v1/sync', headers: H('gina'), payload: { listings: [{ id: 'b:1', updatedAt: 1, data: big }] } });
    assert.equal(r.statusCode, 413);
  });
});
