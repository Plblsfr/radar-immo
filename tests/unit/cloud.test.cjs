/* Tests de la synchronisation (src/lib/cloud.js) et du suivi des modifications (src/lib/radar.js).
 * Le stockage de l'extension et l'API sont simulés en mémoire. */
'use strict';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── Stockage « storage.local » simulé, installé avant de charger les modules
const mem = {};
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
globalThis.chrome = {
  storage: { local: {
    async get(keys) {
      const ks = keys == null ? Object.keys(mem) : Array.isArray(keys) ? keys : [keys];
      const out = {}; ks.forEach((k) => { if (k in mem) out[k] = clone(mem[k]); }); return out;
    },
    async set(o) { Object.keys(o).forEach((k) => { mem[k] = clone(o[k]); }); },
    async clear() { Object.keys(mem).forEach((k) => delete mem[k]); }
  } },
  runtime: { getURL: (p) => 'chrome-extension://abc/' + p }
};
const R = require('../../src/lib/radar.js');
const C = require('../../src/lib/cloud.js');
const reset = () => Object.keys(mem).forEach((k) => delete mem[k]);

// ── Serveur simulé : même règle que l'API (dernière écriture gagnante, curseur de version)
function fakeServer() {
  const rows = new Map(); let settings = null, version = 0;
  const calls = [];
  const auth = { valid: 'tok', refresh: 'rt-1', refreshStatus: 200, refreshCalls: 0 };
  globalThis.fetch = async (url, opt) => {
    const json = (status, data) => ({ ok: status < 300, status, json: async () => data });
    const body = opt.body ? JSON.parse(opt.body) : null;
    if (url === 'https://auth.test/auth/extension/refresh') {
      auth.refreshCalls++;
      if (auth.refreshStatus !== 200 || body.refreshToken !== auth.refresh) return json(auth.refreshStatus === 200 ? 401 : auth.refreshStatus, {});
      auth.valid = 'tok-' + auth.refreshCalls; auth.refresh = 'rt-' + (auth.refreshCalls + 1);
      return json(200, { access_token: auth.valid, refresh_token: auth.refresh, expires_in: 900 });
    }
    const path = url.replace('https://api.test', '');
    calls.push({ path, body, auth: opt.headers.Authorization });
    if (opt.headers.Authorization !== 'Bearer ' + auth.valid) return json(401, { error: 'invalid_token', message: 'Jeton invalide' });
    if (path === '/v1/me') return json(200, { userId: 'u1' });
    if (path === '/v1/sync') {
      if (body.settings && (!settings || settings.updatedAt < body.settings.updatedAt)) settings = Object.assign({}, body.settings, { version: ++version });
      (body.listings || []).forEach((l) => {
        const cur = rows.get(l.id);
        if (!cur || cur.updatedAt < l.updatedAt) rows.set(l.id, { id: l.id, updatedAt: l.updatedAt, deleted: !!l.deleted, data: l.deleted ? null : l.data, version: ++version });
      });
      const since = body.since || 0;
      const list = [...rows.values()].filter((r) => r.version > since).sort((a, b) => a.version - b.version);
      return json(200, { cursor: version, hasMore: false, settings: settings && settings.version > since ? { data: settings.data, updatedAt: settings.updatedAt } : null, listings: list.map(({ version: v, ...r }) => r) });
    }
    return json(404, {});
  };
  return { rows, calls, auth, get settings() { return settings; }, put(id, updatedAt, data) { rows.set(id, { id, updatedAt, deleted: false, data, version: ++version }); } };
}

describe('saveListings : suivi des modifications', () => {
  beforeEach(reset);
  test('date les annonces nouvelles ou modifiées, pas les autres', async () => {
    await R.saveListings({ a: { id: 'a', price: 1 }, b: { id: 'b', price: 2 } });
    const t1 = mem.listings.a.updatedAt;
    assert.ok(t1 > 0);
    mem.listings.a.updatedAt = 5; mem.listings.b.updatedAt = 5;
    const all = await R.getListings();
    all.b.price = 3;
    await R.saveListings(all);
    assert.equal(mem.listings.a.updatedAt, 5, 'inchangée');
    assert.ok(mem.listings.b.updatedAt > 5, 'modifiée');
  });
  test('garde une tombe pour les annonces supprimées, et la retire si l\'annonce revient', async () => {
    await R.saveListings({ a: { id: 'a' }, b: { id: 'b' } });
    await R.saveListings({ a: { id: 'a' } });
    assert.ok(mem.deleted.b > 0);
    await R.saveListings({ a: { id: 'a' }, b: { id: 'b' } });
    assert.equal(mem.deleted.b, undefined);
  });
  test('saveSettings date les critères', async () => {
    await R.saveSettings({ city: 'X' });
    assert.ok(mem.settingsUpdatedAt > 0);
    await R.saveSettings({ city: 'Y' }, { updatedAt: 42 });
    assert.equal(mem.settingsUpdatedAt, 42);
  });
});

describe('collectChanges / applyRemote', () => {
  test('ne pousse que ce qui a changé depuis la dernière synchro', () => {
    const c = C.collectChanges({
      listings: { a: { id: 'a', updatedAt: 100 }, b: { id: 'b', updatedAt: 300 }, old: { id: 'old', lastSeen: 50 } },
      deleted: { d: 250 }, settings: { city: 'X' }, settingsUpdatedAt: 100
    }, 200);
    assert.deepEqual(c.listings.map((l) => l.id), ['b', 'd']);
    assert.equal(c.listings[1].deleted, true);
    assert.equal(c.listings[0].data.updatedAt, undefined, 'updatedAt voyage à part');
    assert.equal(c.settings, null);
    assert.equal(C.collectChanges({ listings: { old: { id: 'old', lastSeen: 50 } } }, 0).listings.length, 1, 'première synchro : tout part');
  });
  test('la version la plus récente gagne, dans les deux sens', () => {
    const cur = { listings: { a: { id: 'a', price: 1, updatedAt: 100 }, b: { id: 'b', price: 1, updatedAt: 500 } }, deleted: { c: 400 }, settings: { city: 'L' }, settingsUpdatedAt: 10 };
    const m = C.applyRemote(cur, [
      { id: 'a', updatedAt: 200, data: { price: 2 } },          // plus récente → appliquée
      { id: 'b', updatedAt: 300, data: { price: 9 } },          // plus ancienne → ignorée
      { id: 'c', updatedAt: 300, data: { price: 9 } },          // supprimée localement après → ignorée
      { id: 'n', updatedAt: 1, data: { price: 5 } },            // nouvelle
      { id: 'a2', updatedAt: 1, deleted: true, data: null }     // tombe d'une annonce inconnue
    ], { data: { city: 'R' }, updatedAt: 20 });
    assert.equal(m.listings.a.price, 2); assert.equal(m.listings.a.updatedAt, 200);
    assert.equal(m.listings.b.price, 1);
    assert.equal(m.listings.c, undefined);
    assert.equal(m.listings.n.price, 5);
    assert.equal(m.settings.city, 'R');
    assert.equal(cur.listings.a.price, 1, 'l\'état d\'origine n\'est pas modifié');
  });
});

describe('sync', () => {
  beforeEach(reset);
  test('premier branchement : pousse le local, récupère le distant, puis ne renvoie que les nouveautés', async () => {
    const srv = fakeServer();
    srv.put('pap:9', 50, { id: 'pap:9', price: 90000, saved: true });
    await R.saveSettings({ city: 'Rennes' });
    await R.saveListings({ 'lbc:1': { id: 'lbc:1', price: 150000 } });
    await C.setState({ apiUrl: 'https://api.test/' });
    await C.connectWithToken('tok');
    const r = await C.sync();
    assert.equal(r.pushed, 1);
    assert.deepEqual(Object.keys(mem.listings).sort(), ['lbc:1', 'pap:9']);
    assert.equal(srv.settings.data.city, 'Rennes');
    const st = await C.getState();
    assert.equal(st.status, 'ok'); assert.ok(st.cursor > 0);

    // Rien n'a changé : rien n'est poussé
    const again = await C.sync();
    assert.equal(again.pushed, 0);
    assert.equal((await C.sync({ onlyIfChanges: true })).skipped, true);

    // Une suppression locale part en tombe puis la tombe est oubliée
    const all = await R.getListings(); delete all['lbc:1']; await R.saveListings(all);
    await C.sync();
    assert.equal(srv.rows.get('lbc:1').deleted, true);
    assert.equal(mem.deleted['lbc:1'], undefined);

    // Une modification faite ailleurs (application web) arrive dans l'extension
    srv.put('pap:9', Date.now() + 1000, { id: 'pap:9', price: 90000, saved: true, status: 'visit' });
    await C.sync();
    assert.equal(mem.listings['pap:9'].status, 'visit');
  });

  test('jeton refusé : état « expiré », jeton oublié, données locales conservées', async () => {
    fakeServer();
    await R.saveListings({ a: { id: 'a' } });
    await C.setState({ apiUrl: 'https://api.test', token: 'périmé', userId: 'u1', status: 'ok' });
    await assert.rejects(C.sync(), (e) => e.status === 401);
    const st = await C.getState();
    assert.equal(st.status, 'expired'); assert.equal(st.token, null);
    assert.ok(mem.listings.a);
  });

  test('jeton expiré : renouvelé automatiquement puis la requête est rejouée', async () => {
    const srv = fakeServer();
    await C.setState({ apiUrl: 'https://api.test', authUrl: 'https://auth.test' });
    await C.connectWithToken('tok', { refreshToken: 'rt-1', expiresIn: 900 });
    srv.auth.valid = 'expiré'; // le jeton en main n'est plus accepté par le serveur
    const r = await C.sync();
    assert.equal(r.pushed, 0);
    const st = await C.getState();
    assert.equal(st.status, 'ok'); assert.equal(st.token, 'tok-1'); assert.equal(st.refreshToken, 'rt-2');
    assert.ok(st.tokenExpiresAt > Date.now());
    assert.equal(srv.auth.refreshCalls, 1);
  });

  test('jeton bientôt expiré : renouvelé avant l\'appel', async () => {
    const srv = fakeServer();
    await C.setState({ apiUrl: 'https://api.test', authUrl: 'https://auth.test' });
    await C.connectWithToken('tok', { refreshToken: 'rt-1', expiresIn: 30 }); // expire dans 30 s < marge d'1 min
    srv.auth.valid = 'tok-1';
    await C.sync();
    assert.equal((await C.getState()).token, 'tok-1');
    assert.ok(srv.calls.filter((c) => c.path === '/v1/sync').every((c) => c.auth === 'Bearer tok-1'), 'aucun appel avec l\'ancien jeton');
  });

  test('renouvellement refusé : session expirée, visible dans l\'état', async () => {
    const srv = fakeServer();
    await C.setState({ apiUrl: 'https://api.test', authUrl: 'https://auth.test' });
    await C.connectWithToken('tok', { refreshToken: 'rt-1' });
    srv.auth.valid = 'expiré'; srv.auth.refreshStatus = 401;
    await assert.rejects(C.sync(), (e) => e.status === 401);
    const st = await C.getState();
    assert.equal(st.status, 'expired'); assert.equal(st.token, null); assert.equal(st.refreshToken, null);
  });

  test('backend d\'authentification en panne pendant le renouvellement : on garde le jeton de renouvellement', async () => {
    const srv = fakeServer();
    await C.setState({ apiUrl: 'https://api.test', authUrl: 'https://auth.test' });
    await C.connectWithToken('tok', { refreshToken: 'rt-1' });
    srv.auth.valid = 'expiré'; srv.auth.refreshStatus = 503;
    await assert.rejects(C.sync());
    const st = await C.getState();
    assert.equal(st.refreshToken, 'rt-1', 'le prochain essai pourra renouveler');
    srv.auth.refreshStatus = 200;
    await C.sync();
    assert.equal((await C.getState()).status, 'ok');
  });

  test('URL de connexion (chemin fixe) et de renouvellement (chemin configurable)', () => {
    assert.equal(C.loginUrlOf({ appUrl: 'https://plbls.fr/' }), 'https://plbls.fr/connexion-extension');
    assert.equal(C.loginUrlOf({ appUrl: 'https://plbls.fr/autre' }), 'https://plbls.fr/connexion-extension', 'chemin de connexion fixe');
    assert.equal(C.refreshUrlOf({ authUrl: 'https://api.plbls.fr' }), 'https://api.plbls.fr/auth/extension/refresh', 'domaine seul : chemin par défaut');
    assert.equal(C.refreshUrlOf({ authUrl: 'https://api.plbls.fr/' }), 'https://api.plbls.fr/auth/extension/refresh');
    assert.equal(C.refreshUrlOf({ authUrl: 'https://auth.plbls.fr/v2/token/refresh/' }), 'https://auth.plbls.fr/v2/token/refresh', 'chemin personnalisé respecté');
    assert.equal(C.refreshUrlOf({ authUrl: 'ftp://x' }), '');
    assert.equal(C.loginUrlOf({ loginUrl: 'https://plbls.fr/connexion-extension' }), 'https://plbls.fr/connexion-extension', 'ancien réglage repris');
    assert.equal(C.refreshUrlOf({ authUrl: 'pas une url' }), '');
    assert.equal(C.loginUrlOf({}), '');
  });

  test('non connecté : aucune requête', async () => {
    const srv = fakeServer();
    assert.equal((await C.sync()).skipped, true);
    assert.equal(srv.calls.length, 0);
  });

  test('connexion via la page du front-end : state vérifié', async () => {
    fakeServer();
    await C.setState({ apiUrl: 'https://api.test', appUrl: 'https://app.test/chemin-ignore' });
    const url = new URL(await C.startLogin());
    assert.equal(url.origin + url.pathname, 'https://app.test/connexion-extension');
    assert.equal(url.searchParams.get('redirect_uri'), 'chrome-extension://abc/auth/callback.html');
    await assert.rejects(C.completeLogin({ token: 'tok', state: 'faux' }), (e) => e.code === 'bad_state');
    const s = await C.completeLogin({ token: 'tok', state: url.searchParams.get('state') });
    assert.equal(s.userId, 'u1'); assert.equal(s.pendingState, null);
  });
});
