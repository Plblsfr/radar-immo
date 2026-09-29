/* Radar Immo — compte et synchronisation avec l'API Radar Immo (facultatif).
 * Sans connexion, l'extension fonctionne comme avant, entièrement en local.
 * Une fois connecté, les critères et les annonces sont synchronisés avec l'API :
 * chaque enregistrement porte un horodatage `updatedAt`, la dernière écriture gagne.
 * Expose globalThis.RadarCloud (et module.exports sous Node pour les tests). */
(function (root) {
  'use strict';

  // Domaines par défaut, remplacés au build par RADAR_API_URL, RADAR_APP_URL et RADAR_AUTH_URL (voir scripts/build.mjs).
  // Seuls les domaines sont configurables : les chemins sont fixes.
  const DEFAULT_API_URL = '';   // API Radar Immo, ex. https://radar-api.plbls.fr
  const DEFAULT_APP_URL = '';   // application web, ex. https://plbls.fr
  const DEFAULT_AUTH_URL = '';  // backend d'authentification, ex. https://api.plbls.fr
  const LOGIN_PATH = '/connexion-extension';
  const REFRESH_PATH = '/api/auth/extension/refresh';
  const REFRESH_MARGIN = 60 * 1000; // renouvelle le jeton une minute avant son expiration

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
    return Object.assign({ apiUrl: '', appUrl: '', authUrl: '', token: null, refreshToken: null, tokenExpiresAt: null, userId: null,
      cursor: 0, lastPushAt: 0, lastSyncAt: 0, status: 'off', lastError: null }, s || {});
  }
  async function setState(patch) {
    const s = Object.assign(await getState(), patch);
    await local.set({ [KEY]: s });
    return s;
  }
  const trimSlash = (u) => String(u || '').trim().replace(/\/+$/, '');
  const apiUrlOf = (s) => trimSlash(s.apiUrl || DEFAULT_API_URL);
  /** Ne garde que l'origine (https://domaine[:port]) : un chemin saisi par erreur est ignoré. */
  const originOf = (u) => { try { return u ? new URL(String(u).trim()).origin : ''; } catch (e) { return ''; } };
  // loginUrl / refreshUrl : anciens réglages (URL complètes), repris pour leur domaine.
  const appUrlOf = (s) => originOf(s.appUrl || s.loginUrl || DEFAULT_APP_URL);
  const authUrlOf = (s) => originOf(s.authUrl || s.refreshUrl || DEFAULT_AUTH_URL);
  const loginUrlOf = (s) => { const o = appUrlOf(s); return o ? o + LOGIN_PATH : ''; };
  const refreshUrlOf = (s) => { const o = authUrlOf(s); return o ? o + REFRESH_PATH : ''; };

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
    if (!base) throw new CloudError(0, 'no_login_url', 'Adresse de l\'application web non configurée');
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
    const { refreshToken = null, expiresIn = null } = overrides;
    token = String(token || '').trim().replace(/^Bearer\s+/i, ''); // copié depuis l'en-tête Authorization
    if (!token) throw new CloudError(0, 'missing_token', 'Jeton manquant');
    const s = await getState();
    const apiUrl = trimSlash(overrides.apiUrl) || apiUrlOf(s);
    const me = await request(apiUrl, token, '/v1/me');
    const sameUser = s.userId && s.userId === me.userId;
    return setState({
      token, userId: me.userId, status: 'ok', lastError: null, connectedAt: Date.now(),
      refreshToken: refreshToken || null, tokenExpiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
      pendingState: null, pendingAt: null,
      // Nouveau compte (ou premier branchement) : on renvoie tout et on récupère tout.
      cursor: sameUser ? s.cursor : 0, lastPushAt: sameUser ? s.lastPushAt : 0
    });
  }

  /** Appelé par auth/callback.html avec les paramètres du fragment d'URL. */
  async function completeLogin({ token, state, refreshToken, expiresIn }) {
    const s = await getState();
    if (!s.pendingState || state !== s.pendingState || Date.now() - (s.pendingAt || 0) > 15 * 60 * 1000)
      throw new CloudError(0, 'bad_state', 'Demande de connexion inconnue ou expirée. Relance la connexion depuis le tableau de bord.');
    return connectWithToken(token, { refreshToken, expiresIn: +expiresIn || null });
  }

  async function disconnect() {
    return setState({ token: null, refreshToken: null, tokenExpiresAt: null, userId: null, status: 'off', lastError: null, cursor: 0, lastPushAt: 0 });
  }

  // ───────────────────────── Session : renouvellement automatique du jeton
  // Contrat attendu du backend d'authentification (<serveur d'authentification> + REFRESH_PATH) :
  //   POST <url>  { "refreshToken": "…" }
  //   200 → { "accessToken", "refreshToken"?, "expiresIn"? (secondes) }  (snake_case accepté aussi)
  //   4xx → session terminée ; 5xx ou réseau → nouvel essai plus tard.
  const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return null; };
  let refreshing = null;

  function refreshSession() {
    if (!refreshing) refreshing = (async () => {
      const s = await getState();
      const url = refreshUrlOf(s);
      if (!s.refreshToken || !url) return false;
      let res;
      try {
        res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ refreshToken: s.refreshToken, refresh_token: s.refreshToken }) });
      } catch (e) {
        throw new CloudError(0, 'network', 'Service de connexion injoignable');
      }
      if (res.status >= 400 && res.status < 500) {
        await setState({ refreshToken: null });
        return false;
      }
      if (!res.ok) throw new CloudError(res.status, 'refresh_failed', 'Renouvellement de la session impossible pour le moment');
      const data = await res.json().catch(() => null);
      const token = pick(data, 'accessToken', 'access_token', 'token');
      if (!token) return false;
      const expiresIn = +pick(data, 'expiresIn', 'expires_in') || 0;
      await setState({
        token, refreshToken: pick(data, 'refreshToken', 'refresh_token') || s.refreshToken,
        tokenExpiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : null, status: 'ok', lastError: null
      });
      return true;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  async function markExpired(message) {
    await setState({ status: 'expired', token: null, tokenExpiresAt: null, lastError: message || 'Session expirée' });
  }

  /** Appel authentifié : renouvelle le jeton s'il arrive à expiration, et une fois de plus sur un 401. */
  async function call(path, opts) {
    let s = await getState();
    if (!s.token && s.refreshToken && await refreshSession().catch(() => false)) s = await getState();
    if (!s.token) throw new CloudError(401, 'not_connected', s.status === 'expired' ? 'Session expirée : reconnecte-toi' : 'Connecte-toi à ton compte');
    if (s.tokenExpiresAt && Date.now() > s.tokenExpiresAt - REFRESH_MARGIN && s.refreshToken) {
      if (await refreshSession().catch(() => false)) s = await getState();
    }
    try {
      return await request(apiUrlOf(s), s.token, path, opts);
    } catch (e) {
      if (e.status !== 401) throw e;
      if (await refreshSession().catch(() => false)) {
        const s2 = await getState();
        try { return await request(apiUrlOf(s2), s2.token, path, opts); } catch (e2) { if (e2.status !== 401) throw e2; }
      }
      await markExpired(e.message);
      throw e;
    }
  }

  async function wipeRemote() {
    const s = await getState();
    if (!s.token) return;
    await call('/v1/data', { method: 'DELETE' });
  }

  // ───────────────────────── Partage public d'une annonce
  const authed = call;
  /** Crée (ou met à jour) le lien public d'une annonce. Synchronise d'abord, pour que le serveur la connaisse. */
  async function createShare(listingId, { message, includeNotes, expiresInDays } = {}) {
    await sync();
    return authed('/v1/shares', { method: 'POST', body: { listingId, message: message || null, includeNotes: !!includeNotes, expiresInDays: expiresInDays || null } });
  }
  async function getShare(listingId) {
    const r = await authed('/v1/shares?listingId=' + encodeURIComponent(listingId));
    return (r && r.items && r.items[0]) || null;
  }
  async function revokeShare(token) {
    await authed('/v1/shares/' + encodeURIComponent(token), { method: 'DELETE' });
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
    if ((!s.token && !s.refreshToken) || !apiUrlOf(s)) return { skipped: true };
    const startedAt = Date.now();
    const snap = await local.get(['listings', 'deleted', 'settings', 'settingsUpdatedAt']);
    const changes = collectChanges(snap, s.lastPushAt || 0);
    if (onlyIfChanges && !changes.listings.length && !changes.settings) return { skipped: true };

    try {
      let since = s.cursor || 0, hasMore = false, remoteSettings = null;
      const pulled = [];
      const chunks = changes.listings.length ? chunk(changes.listings, PUSH_CHUNK) : [[]];
      for (let i = 0; i < chunks.length; i++) {
        const res = await call('/v1/sync', { method: 'POST', body: { since, settings: i === 0 ? changes.settings : null, listings: chunks[i] } });
        pulled.push(...res.listings); if (res.settings) remoteSettings = res.settings;
        since = res.cursor; hasMore = res.hasMore;
      }
      while (hasMore) {
        const res = await call('/v1/sync', { method: 'POST', body: { since } });
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
      // 401 : call() a déjà tenté le renouvellement puis marqué la session expirée.
      if (e.status !== 401) await setState({ status: 'error', lastError: e.message });
      throw e;
    }
  }

  const api = {
    DEFAULT_API_URL, DEFAULT_APP_URL, DEFAULT_AUTH_URL, LOGIN_PATH, REFRESH_PATH, CloudError,
    getState, setState, startLogin, completeLogin, connectWithToken, disconnect, wipeRemote, sync, refreshSession,
    createShare, getShare, revokeShare,
    collectChanges, applyRemote, apiUrlOf, appUrlOf, authUrlOf, loginUrlOf, refreshUrlOf
  };
  root.RadarCloud = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
