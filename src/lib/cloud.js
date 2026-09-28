/* Radar Immo — compte et synchronisation avec l'API Radar Immo (facultatif).
 * Sans connexion, l'extension fonctionne comme avant, entièrement en local.
 * Une fois connecté, les critères et les annonces sont synchronisés avec l'API :
 * chaque enregistrement porte un horodatage `updatedAt`, la dernière écriture gagne.
 * Expose globalThis.RadarCloud (et module.exports sous Node pour les tests). */
(function (root) {
  'use strict';

  // Valeurs par défaut, remplacées au build par RADAR_API_URL et RADAR_LOGIN_URL (voir scripts/build.mjs).
  const DEFAULT_API_URL = '';
  const DEFAULT_LOGIN_URL = '';

  const KEY = 'cloud';
  const PUSH_CHUNK = 200;

  const ext = (typeof globalThis.browser !== 'undefined' && globalThis.browser.storage) ? globalThis.browser : (typeof globalThis.chrome !== 'undefined' ? globalThis.chrome : null);
  const local = ext && ext.storage && ext.storage.local;

  class CloudError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
  }

  // ───────────────────────── État local de la connexion (clé « cloud », jamais exportée)
  async function getState() {
    const { [KEY]: s } = await local.get(KEY);
    return Object.assign({ apiUrl: '', loginUrl: '', token: null, userId: null, cursor: 0, lastPushAt: 0, lastSyncAt: 0, status: 'off', lastError: null }, s || {});
  }
  async function setState(patch) {
    const s = Object.assign(await getState(), patch);
    await local.set({ [KEY]: s });
    return s;
  }
  const trimSlash = (u) => String(u || '').trim().replace(/\/+$/, '');
  const apiUrlOf = (s) => trimSlash(s.apiUrl || DEFAULT_API_URL);
  const loginUrlOf = (s) => String(s.loginUrl || DEFAULT_LOGIN_URL).trim();

  // ───────────────────────── Appels HTTP
  async function request(apiUrl, token, path, { method = 'GET', body } = {}) {
    if (!apiUrl) throw new CloudError(0, 'no_api_url', 'Adresse de l\'API non configurée');
    let res;
    try {
      res = await fetch(apiUrl + path, {
        method,
        headers: Object.assign({ Authorization: 'Bearer ' + token }, body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      throw new CloudError(0, 'network', 'Serveur injoignable');
    }
    if (res.status === 204) return null;
    let data = null;
    try { data = await res.json(); } catch (e) { /* corps vide */ }
    if (!res.ok) throw new CloudError(res.status, (data && data.error) || 'http_' + res.status, (data && data.message) || 'Erreur ' + res.status);
    return data;
  }

  // ───────────────────────── Connexion
  function randomState() {
    const a = new Uint8Array(16);
    globalThis.crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** URL de la page de connexion du front-end, qui renverra le jeton vers auth/callback.html. */
  async function startLogin() {
    const s = await getState();
    const base = loginUrlOf(s);
    if (!base) throw new CloudError(0, 'no_login_url', 'Adresse de la page de connexion non configurée');
    const state = randomState();
    await setState({ pendingState: state, pendingAt: Date.now() });
    const u = new URL(base);
    u.searchParams.set('redirect_uri', ext.runtime.getURL('auth/callback.html'));
    u.searchParams.set('state', state);
    u.searchParams.set('client', 'radar-immo-extension');
    return u.toString();
  }

  /** Vérifie le jeton auprès de l'API puis l'enregistre. */
  async function connectWithToken(token, overrides = {}) {
    token = String(token || '').trim().replace(/^Bearer\s+/i, ''); // copié depuis l'en-tête Authorization
    if (!token) throw new CloudError(0, 'missing_token', 'Jeton manquant');
    const s = await getState();
    const apiUrl = trimSlash(overrides.apiUrl) || apiUrlOf(s);
    const me = await request(apiUrl, token, '/v1/me');
    const sameUser = s.userId && s.userId === me.userId;
    return setState({
      token, userId: me.userId, status: 'ok', lastError: null, connectedAt: Date.now(),
      pendingState: null, pendingAt: null,
      // Nouveau compte (ou premier branchement) : on renvoie tout et on récupère tout.
      cursor: sameUser ? s.cursor : 0, lastPushAt: sameUser ? s.lastPushAt : 0
    });
  }

  /** Appelé par auth/callback.html avec les paramètres du fragment d'URL. */
  async function completeLogin({ token, state }) {
    const s = await getState();
    if (!s.pendingState || state !== s.pendingState || Date.now() - (s.pendingAt || 0) > 15 * 60 * 1000)
      throw new CloudError(0, 'bad_state', 'Demande de connexion inconnue ou expirée. Relance la connexion depuis le tableau de bord.');
    return connectWithToken(token);
  }

  async function disconnect() {
    return setState({ token: null, userId: null, status: 'off', lastError: null, cursor: 0, lastPushAt: 0 });
  }

  async function wipeRemote() {
    const s = await getState();
    if (!s.token) return;
    await request(apiUrlOf(s), s.token, '/v1/data', { method: 'DELETE' });
  }

  // ───────────────────────── Fusion (fonctions pures, testées)
  const stripTs = (rec) => { const o = Object.assign({}, rec); delete o.updatedAt; return o; };
  const tsOf = (rec) => rec.updatedAt || rec.lastSeen || rec.firstSeen || 1;

  /** Changements locaux à pousser depuis `since` (ms). */
  function collectChanges({ listings = {}, deleted = {}, settings, settingsUpdatedAt }, since) {
    const out = [];
    Object.keys(listings).forEach((id) => {
      const rec = listings[id];
      if (rec && tsOf(rec) >= since) out.push({ id, updatedAt: tsOf(rec), data: stripTs(rec) });
    });
    Object.keys(deleted).forEach((id) => {
      if (!listings[id] && deleted[id] >= since) out.push({ id, updatedAt: deleted[id], deleted: true });
    });
    const pushSettings = settings && (settingsUpdatedAt || 0) >= since && settingsUpdatedAt ? { data: settings, updatedAt: settingsUpdatedAt } : null;
    return { listings: out, settings: pushSettings };
  }

  /** Applique les changements reçus du serveur sur l'état local. Ne modifie pas `cur`. */
  function applyRemote(cur, remoteListings, remoteSettings) {
    const listings = Object.assign({}, cur.listings || {});
    const deleted = Object.assign({}, cur.deleted || {});
    let settings = cur.settings, settingsUpdatedAt = cur.settingsUpdatedAt || 0;
    let changedListings = false, changedDeleted = false, changedSettings = false;
    (remoteListings || []).forEach((r) => {
      const l = listings[r.id];
      const localTs = l ? tsOf(l) : (deleted[r.id] || 0);
      if (r.updatedAt <= localTs) return; // la version locale est au moins aussi récente
      if (r.deleted) {
        if (l) { delete listings[r.id]; changedListings = true; }
      } else {
        listings[r.id] = Object.assign({}, r.data, { id: r.id, updatedAt: r.updatedAt });
        changedListings = true;
      }
      if (deleted[r.id]) { delete deleted[r.id]; changedDeleted = true; }
    });
    if (remoteSettings && remoteSettings.updatedAt > settingsUpdatedAt) {
      settings = remoteSettings.data; settingsUpdatedAt = remoteSettings.updatedAt; changedSettings = true;
    }
    return { listings, deleted, settings, settingsUpdatedAt, changedListings, changedDeleted, changedSettings };
  }

  const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

  // ───────────────────────── Synchronisation
  let running = null, again = false;

  /** Lance une synchro (une seule à la fois). `onlyIfChanges` : ne rien faire s'il n'y a rien à pousser. */
  function sync(opts = {}) {
    if (running) { again = again || !opts.onlyIfChanges; return running; }
    running = (async () => {
      try {
        let r = await syncOnce(opts);
        while (again) { again = false; r = await syncOnce({}); }
        return r;
      } finally { running = null; }
    })();
    return running;
  }

  async function syncOnce({ onlyIfChanges } = {}) {
    const s = await getState();
    const apiUrl = apiUrlOf(s);
    if (!s.token || !apiUrl) return { skipped: true };
    const startedAt = Date.now();
    const snap = await local.get(['listings', 'deleted', 'settings', 'settingsUpdatedAt']);
    const changes = collectChanges(snap, s.lastPushAt || 0);
    if (onlyIfChanges && !changes.listings.length && !changes.settings) return { skipped: true };

    try {
      let since = s.cursor || 0, hasMore = false, remoteSettings = null;
      const pulled = [];
      const chunks = changes.listings.length ? chunk(changes.listings, PUSH_CHUNK) : [[]];
      for (let i = 0; i < chunks.length; i++) {
        const res = await request(apiUrl, s.token, '/v1/sync', { method: 'POST', body: { since, settings: i === 0 ? changes.settings : null, listings: chunks[i] } });
        pulled.push(...res.listings); if (res.settings) remoteSettings = res.settings;
        since = res.cursor; hasMore = res.hasMore;
      }
      while (hasMore) {
        const res = await request(apiUrl, s.token, '/v1/sync', { method: 'POST', body: { since } });
        pulled.push(...res.listings); if (res.settings) remoteSettings = res.settings;
        since = res.cursor; hasMore = res.hasMore;
      }

      // Relecture juste avant d'écrire, pour ne pas écraser une modification faite pendant la synchro.
      const fresh = await local.get(['listings', 'deleted', 'settings', 'settingsUpdatedAt']);
      const m = applyRemote(fresh, pulled, remoteSettings);
      // Les suppressions poussées sont désormais connues du serveur.
      changes.listings.filter((c) => c.deleted).forEach((c) => {
        if (m.deleted[c.id] === c.updatedAt) { delete m.deleted[c.id]; m.changedDeleted = true; }
      });
      const write = {};
      if (m.changedListings) write.listings = m.listings;
      if (m.changedDeleted) write.deleted = m.deleted;
      if (m.changedSettings) { write.settings = m.settings; write.settingsUpdatedAt = m.settingsUpdatedAt; }
      if (Object.keys(write).length) await local.set(write);

      await setState({ cursor: since, lastPushAt: startedAt, lastSyncAt: Date.now(), status: 'ok', lastError: null });
      return { pushed: changes.listings.length, pulled: pulled.length };
    } catch (e) {
      const expired = e.status === 401 || e.status === 403;
      await setState(expired ? { status: 'expired', token: null, lastError: e.message } : { status: 'error', lastError: e.message });
      throw e;
    }
  }

  const api = {
    DEFAULT_API_URL, DEFAULT_LOGIN_URL, CloudError,
    getState, setState, startLogin, completeLogin, connectWithToken, disconnect, wipeRemote, sync,
    collectChanges, applyRemote, apiUrlOf, loginUrlOf
  };
  root.RadarCloud = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
