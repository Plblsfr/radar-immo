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

  async function callAuthBackend(token, log) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), authCfg.timeoutMs);
    let res;
    try {
      res = await fetchImpl(authCfg.verifyUrl, {
        method: 'GET',
        headers: { [authCfg.headerName]: `${authCfg.headerPrefix}${token}`, accept: 'application/json' },
        signal: ctrl.signal,
        redirect: 'manual'
      });
    } catch (e) {
      log?.warn({ err: e.message }, 'backend d\'authentification injoignable');
      throw new AuthError(503, 'auth_unavailable', 'Le service d\'authentification ne répond pas');
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 200 && res.status < 300) {
      let body = null;
      try { body = await res.json(); } catch { /* réponse vide ou non JSON : acceptée */ }
      return body;
    }
    // On vide le corps pour libérer la connexion.
    try { await res.arrayBuffer(); } catch { /* ignoré */ }
    if (res.status === 403) throw new AuthError(403, 'forbidden', 'Accès refusé');
    if (res.status >= 400 && res.status < 500) throw new AuthError(401, 'invalid_token', 'Jeton invalide ou expiré');
    log?.warn({ status: res.status }, 'réponse inattendue du backend d\'authentification');
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
      log?.error('identifiant utilisateur introuvable dans la réponse du backend d\'authentification (voir AUTH_USER_ID_PATHS)');
      throw new AuthError(502, 'auth_no_user_id', 'Impossible d\'identifier l\'utilisateur');
    }
    if (authCfg.cacheTtlMs > 0) remember(key, { userId, expires: now() + authCfg.cacheTtlMs });
    return { userId };
  }

  return { verify, clearCache: () => cache.clear() };
}
