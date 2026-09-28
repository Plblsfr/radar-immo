/* Tests de l'authentification déléguée (sans base de données). */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthClient, jwtSubject, bearerToken, AuthError } from '../src/auth.js';

const cfg = (over = {}) => ({
  verifyUrl: 'http://auth.test/verify', headerName: 'Authorization', headerPrefix: 'Bearer ',
  timeoutMs: 200, cacheTtlMs: 30000, cacheMax: 100, userIdPaths: ['id', 'user.id'], userIdFromJwt: true, ...over
});
const jsonRes = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const jwt = (payload) => ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');

describe('bearerToken / jwtSubject', () => {
  test('extrait le jeton Bearer', () => {
    assert.equal(bearerToken('Bearer abc.def'), 'abc.def');
    assert.equal(bearerToken('bearer   xyz'), 'xyz');
    assert.equal(bearerToken('Basic abc'), null);
    assert.equal(bearerToken(undefined), null);
  });
  test('lit le sub d\'un JWT', () => {
    assert.equal(jwtSubject(jwt({ sub: 'u-42' })), 'u-42');
    assert.equal(jwtSubject('pas-un-jwt'), null);
  });
});

describe('createAuthClient', () => {
  test('2xx : transmet le jeton en en-tête et lit l\'identifiant dans la réponse', async () => {
    let seen;
    const auth = createAuthClient(cfg(), { fetchImpl: async (url, opt) => { seen = { url, opt }; return jsonRes(200, { user: { id: 7 } }); } });
    assert.deepEqual(await auth.verify('tok'), { userId: '7' });
    assert.equal(seen.url, 'http://auth.test/verify');
    assert.equal(seen.opt.method, 'GET');
    assert.equal(seen.opt.headers.Authorization, 'Bearer tok');
  });

  test('en-tête et préfixe configurables', async () => {
    let headers;
    const auth = createAuthClient(cfg({ headerName: 'X-Auth-Token', headerPrefix: '' }), { fetchImpl: async (u, o) => { headers = o.headers; return jsonRes(204); } });
    assert.deepEqual(await auth.verify(jwt({ sub: 'abc' })), { userId: 'abc' });
    assert.equal(headers['X-Auth-Token'], jwt({ sub: 'abc' }));
  });

  test('2xx sans identifiant exploitable → 502', async () => {
    const auth = createAuthClient(cfg(), { fetchImpl: async () => jsonRes(200, { ok: true }) });
    await assert.rejects(auth.verify('opaque'), (e) => e instanceof AuthError && e.statusCode === 502);
  });

  test('401/404 → 401, 403 → 403', async () => {
    for (const [status, expected] of [[401, 401], [404, 401], [422, 401], [403, 403]]) {
      const auth = createAuthClient(cfg(), { fetchImpl: async () => jsonRes(status, { error: 'x' }) });
      await assert.rejects(auth.verify('t'), (e) => e.statusCode === expected);
    }
  });

  test('5xx, erreur réseau ou délai → 503, jamais mis en cache', async () => {
    let calls = 0;
    const auth = createAuthClient(cfg(), { fetchImpl: async () => { calls++; return jsonRes(500); } });
    await assert.rejects(auth.verify('t'), (e) => e.statusCode === 503);
    await assert.rejects(auth.verify('t'), (e) => e.statusCode === 503);
    assert.equal(calls, 2);
    const down = createAuthClient(cfg(), { fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    await assert.rejects(down.verify('t'), (e) => e.statusCode === 503);
    const slow = createAuthClient(cfg({ timeoutMs: 20 }), {
      fetchImpl: (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted'))))
    });
    await assert.rejects(slow.verify('t'), (e) => e.statusCode === 503);
  });

  test('met en cache les jetons valides jusqu\'à expiration', async () => {
    let calls = 0, clock = 1000;
    const auth = createAuthClient(cfg({ cacheTtlMs: 1000 }), { now: () => clock, fetchImpl: async () => { calls++; return jsonRes(200, { id: 'u1' }); } });
    await auth.verify('t'); await auth.verify('t');
    assert.equal(calls, 1);
    clock += 1001;
    await auth.verify('t');
    assert.equal(calls, 2);
  });

  test('jeton absent → 401 sans appel', async () => {
    const auth = createAuthClient(cfg(), { fetchImpl: async () => assert.fail('ne doit pas appeler') });
    await assert.rejects(auth.verify(''), (e) => e.statusCode === 401);
  });
});
