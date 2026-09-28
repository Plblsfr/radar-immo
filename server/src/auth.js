/* Authentification déléguée : le jeton reçu du client est transmis tel quel,
 * dans un en-tête, à une route GET du backend d'authentification.
 *   2xx        → jeton valide (l'identifiant utilisateur est lu dans la réponse ou dans le JWT)
 *   4xx        → jeton refusé (401 / 403 renvoyé au client)
 *   5xx, délai → backend d'authentification indisponible (503 renvoyé au client) */
import { createHash } from 'node:crypto';

export class AuthError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

const getPath = (o, path) => path.split('.').reduce((x, k) => (x != null && typeof x === 'object' ? x[k] : undefined), o);

/** Lit le claim « sub » d'un JWT, sans vérifier la signature (c'est le rôle du backend d'authentification). */
export function jwtSubject(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const sub = payload && (payload.sub ?? payload.user_id ?? payload.userId);
    return sub == null ? null : String(sub);
  } catch {
    return null;
  }
}

/** Extrait le jeton de l'en-tête Authorization: Bearer <jeton>. */
export function bearerToken(header) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(String(header || ''));
  return m ? m[1] : null;
}

export function createAuthClient(authCfg, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const cache = new Map(); // sha256(jeton) → { userId, expires }
  const hash = (token) => createHash('sha256').update(token).digest('hex');

  function remember(key, value) {
    if (cache.size >= authCfg.cacheMax) cache.delete(cache.keys().next().value); // éviction du plus ancien
    cache.set(key, value);
  }

  // Journalisation : jamais le jeton, seulement une empreinte courte pour recouper les requêtes.
  const fingerprint = (token) => hash(token).slice(0, 12);
  const looksLikeJwt = (token) => String(token).split('.').length === 3;
  async function excerpt(res) {
    try { return (await res.text()).replace(/\s+/g, ' ').slice(0, 300); } catch { return ''; }
  }

  async function callAuthBackend(token, log) {
    const ctx = {
      authUrl: authCfg.verifyUrl, authHeader: authCfg.headerName, authPrefix: JSON.stringify(authCfg.headerPrefix),
      token: { sha256: fingerprint(token), length: String(token).length, jwt: looksLikeJwt(token) }
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), authCfg.timeoutMs);
    const started = Date.now();
    let res;
    try {
      res = await fetchImpl(authCfg.verifyUrl, {
        method: 'GET',
        headers: { [authCfg.headerName]: `${authCfg.headerPrefix}${token}`, accept: 'application/json' },
        signal: ctrl.signal,
        redirect: 'manual'
      });
    } catch (e) {
      const timeout = ctrl.signal.aborted;
      log?.warn({ ...ctx, ms: Date.now() - started, err: e.message, cause: e.cause && (e.cause.code || e.cause.message) },
        timeout ? `backend d'authentification : pas de réponse en ${authCfg.timeoutMs} ms` : 'backend d\'authentification injoignable (DNS, réseau, TLS ?)');
      throw new AuthError(503, 'auth_unavailable', 'Le service d\'authentification ne répond pas');
    } finally {
      clearTimeout(timer);
    }
    const ms = Date.now() - started;
    if (res.status >= 200 && res.status < 300) {
      let body = null;
      const text = await res.text().catch(() => '');
      try { body = text ? JSON.parse(text) : null; } catch { /* réponse non JSON : acceptée */ }
      log?.info({ ...ctx, status: res.status, ms, bodyKeys: body && typeof body === 'object' ? Object.keys(body) : typeof body },
        'backend d\'authentification : jeton accepté');
      return body;
    }
    const detail = { ...ctx, status: res.status, ms, location: res.headers.get('location') || undefined, body: await excerpt(res) };
    if (res.status >= 300 && res.status < 400) {
      // Une redirection n'est pas une validation : souvent une URL en http redirigée vers https,
      // ou une route protégée qui renvoie vers une page de connexion.
      log?.warn(detail, 'backend d\'authentification : redirection au lieu d\'une réponse (vérifie AUTH_VERIFY_URL : https ? bon chemin ?)');
      throw new AuthError(503, 'auth_unavailable', 'Le service d\'authentification est mal configuré');
    }
    if (res.status === 404 || res.status === 405) {
      log?.warn(detail, `backend d'authentification : route introuvable (${res.status}), vérifie AUTH_VERIFY_URL`);
      throw new AuthError(503, 'auth_unavailable', 'Le service d\'authentification est mal configuré');
    }
    if (res.status === 403) {
      log?.warn(detail, 'backend d\'authentification : accès refusé (403)');
      throw new AuthError(403, 'forbidden', 'Accès refusé');
    }
    if (res.status >= 400 && res.status < 500) {
      log?.warn(detail, `backend d'authentification : jeton refusé (${res.status})`);
      throw new AuthError(401, 'invalid_token', 'Jeton invalide ou expiré');
    }
    log?.warn(detail, `backend d'authentification : erreur ${res.status}`);
    throw new AuthError(503, 'auth_unavailable', 'Le service d\'authentification est indisponible');
  }

  function userIdFrom(body, token) {
    if (body && typeof body === 'object') {
      for (const p of authCfg.userIdPaths) {
        const v = getPath(body, p);
        if (v != null && v !== '' && (typeof v === 'string' || typeof v === 'number')) return String(v);
      }
    }
    return authCfg.userIdFromJwt ? jwtSubject(token) : null;
  }

  /** Renvoie { userId } ou lève une AuthError. `log` : logger de la requête (facultatif). */
  async function verify(token, log) {
    if (!token) throw new AuthError(401, 'missing_token', 'Jeton manquant');
    const key = hash(token);
    const hit = cache.get(key);
    if (hit && hit.expires > now()) {
      log?.debug({ token: { sha256: fingerprint(token) }, cached: hit.error ? hit.error.code : 'ok' }, 'authentification : réponse en cache');
      if (hit.error) throw hit.error;
      return { userId: hit.userId };
    }
    if (hit) cache.delete(key);

    let body;
    try {
      body = await callAuthBackend(token, log);
    } catch (e) {
      // Les refus sont mis en cache brièvement ; l'indisponibilité ne l'est jamais.
      if (e instanceof AuthError && e.statusCode !== 503) remember(key, { error: e, expires: now() + Math.min(5000, authCfg.cacheTtlMs) });
      throw e;
    }
    const userId = userIdFrom(body, token);
    if (!userId || userId.length > 200) {
      log?.error({ token: { sha256: fingerprint(token), jwt: looksLikeJwt(token) }, userIdPaths: authCfg.userIdPaths, bodyKeys: body && typeof body === 'object' ? Object.keys(body) : typeof body },
        'identifiant utilisateur introuvable dans la réponse du backend d\'authentification (voir AUTH_USER_ID_PATHS)');
      throw new AuthError(502, 'auth_no_user_id', 'Impossible d\'identifier l\'utilisateur');
    }
    log?.info({ userId }, 'authentification réussie');
    if (authCfg.cacheTtlMs > 0) remember(key, { userId, expires: now() + authCfg.cacheTtlMs });
    return { userId };
  }

  return { verify, clearCache: () => cache.clear() };
}
