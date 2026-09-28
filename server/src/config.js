/* Configuration lue dans les variables d'environnement (voir .env.example). */

const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;

const int = (v, def) => {
  if (v == null || v === '') return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Nombre entier attendu, reçu « ${v} »`);
  return n;
};
const bool = (v, def) => (v == null || v === '' ? def : /^(1|true|yes|oui|on)$/i.test(v));
const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

export function loadConfig(env = process.env) {
  const cfg = {
    host: env.HOST || '0.0.0.0',
    port: int(env.PORT, 3000),
    logLevel: env.LOG_LEVEL || 'info',
    trustProxy: bool(env.TRUST_PROXY, false),

    databaseUrl: env.DATABASE_URL || '',
    dbSchema: env.DB_SCHEMA || 'radar_immo',
    dbPoolMax: int(env.DB_POOL_MAX, 10),
    dbSsl: bool(env.DB_SSL, false),
    migrateOnStart: bool(env.MIGRATE_ON_START, true),

    auth: {
      // Route GET du backend d'authentification. 2xx = jeton valide, 4xx = refusé, 5xx = indisponible.
      verifyUrl: env.AUTH_VERIFY_URL || '',
      headerName: env.AUTH_HEADER_NAME || 'Authorization',
      headerPrefix: env.AUTH_HEADER_PREFIX ?? 'Bearer ',
      timeoutMs: int(env.AUTH_TIMEOUT_MS, 3000),
      cacheTtlMs: int(env.AUTH_CACHE_TTL_MS, 30000),
      cacheMax: int(env.AUTH_CACHE_MAX, 10000),
      // Où trouver l'identifiant de l'utilisateur dans la réponse 2xx (chemins séparés par des virgules).
      // À défaut, le claim « sub » du jeton s'il s'agit d'un JWT.
      userIdPaths: list(env.AUTH_USER_ID_PATHS || 'id,userId,user_id,sub,user.id,data.id'),
      userIdFromJwt: bool(env.AUTH_USER_ID_FROM_JWT, true)
    },

    cors: {
      origins: list(env.CORS_ORIGINS),
      allowExtensions: bool(env.CORS_ALLOW_EXTENSIONS, true),
      extensionIds: list(env.CORS_EXTENSION_IDS)
    },

    limits: {
      bodyBytes: int(env.BODY_LIMIT_BYTES, 5 * 1024 * 1024),
      listingBytes: int(env.LISTING_MAX_BYTES, 64 * 1024),
      settingsBytes: int(env.SETTINGS_MAX_BYTES, 256 * 1024),
      syncPushMax: int(env.SYNC_PUSH_MAX, 500),
      syncPullMax: int(env.SYNC_PULL_MAX, 500)
    }
  };

  const errors = [];
  if (!cfg.databaseUrl) errors.push('DATABASE_URL est obligatoire');
  if (!cfg.auth.verifyUrl) errors.push('AUTH_VERIFY_URL est obligatoire');
  if (!SCHEMA_RE.test(cfg.dbSchema)) errors.push(`DB_SCHEMA invalide : « ${cfg.dbSchema} » (minuscules, chiffres et _ uniquement)`);
  if (errors.length) throw new Error('Configuration invalide :\n - ' + errors.join('\n - '));
  return cfg;
}
