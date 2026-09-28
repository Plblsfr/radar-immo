/* Application HTTP (Fastify). Construite sans effet de bord pour pouvoir être testée avec app.inject(). */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { AuthError, bearerToken } from './auth.js';
import { publicView, renderSharePage, renderNotFound, SHARE_TOKEN_RE } from './share.js';

const STATUSES = ['new', 'contact', 'visit', 'visited', 'offer', 'rejected'];
const FIVE_MIN = 5 * 60 * 1000;

export function isAllowedOrigin(origin, corsCfg) {
  if (!origin) return true; // requêtes sans Origin (curl, serveur à serveur)
  if (corsCfg.origins.includes('*') || corsCfg.origins.includes(origin)) return true;
  const m = /^(chrome-extension|moz-extension|safari-web-extension):\/\/([^/]+)$/.exec(origin);
  if (m && corsCfg.allowExtensions) {
    // Les identifiants Firefox (moz-extension) sont aléatoires par installation : on ne peut pas les lister.
    if (m[1] === 'chrome-extension' && corsCfg.extensionIds.length) return corsCfg.extensionIds.includes(m[2]);
    return true;
  }
  return false;
}

export function buildApp({ config, store, authClient, db, logger = true }) {
  const app = Fastify({
    logger: logger === true ? { level: config.logLevel, redact: ['req.headers.authorization'] } : logger,
    bodyLimit: config.limits.bodyBytes,
    trustProxy: config.trustProxy,
    routerOptions: { maxParamLength: 500 },
    ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array', useDefaults: true } }
  });

  const corsBase = { methods: ['GET', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'], allowedHeaders: ['Authorization', 'Content-Type'], maxAge: 600 };
  app.register(cors, {
    // Les pages et données de partage sont publiques : lisibles depuis n'importe quelle origine.
    delegator: (req, cb) => cb(null, Object.assign({}, corsBase,
      req.url.startsWith('/public/') ? { origin: '*', methods: ['GET'] } : { origin: isAllowedOrigin(req.headers.origin, config.cors) }))
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AuthError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    if (err.validation) return reply.code(400).send({ error: 'invalid_request', message: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.code || 'bad_request', message: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'internal_error', message: 'Erreur interne' });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: 'not_found', message: 'Route inconnue' }));

  const fail = (reply, code, error, message) => reply.code(code).send({ error, message });
  const clampTs = (ts) => Math.min(ts, Date.now() + FIVE_MIN);
  const size = (o) => Buffer.byteLength(JSON.stringify(o));

  // ───────────── Santé (sans authentification)
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (req, reply) => {
    try { await db.pool.query('SELECT 1'); return { status: 'ok', database: 'ok' }; } catch (e) {
      req.log.error(e); return reply.code(503).send({ status: 'error', database: 'unreachable' });
    }
  });

  // ───────────── Partage public (sans authentification)
  const shareUrl = (req, token) => (config.shareUrlPrefix || `${req.protocol}://${req.host}/s/`) + token;
  const noIndex = (reply) => reply.header('X-Robots-Tag', 'noindex, nofollow').header('Referrer-Policy', 'no-referrer').header('Cache-Control', 'no-store');

  app.get('/public/shares/:token', async (req, reply) => {
    noIndex(reply);
    const found = SHARE_TOKEN_RE.test(req.params.token) ? await store.viewShare(req.params.token) : null;
    if (!found) return fail(reply, 404, 'not_found', 'Lien de partage inconnu, expiré ou désactivé');
    return publicView(found.data, found.share);
  });

  app.get('/s/:token', async (req, reply) => {
    noIndex(reply).type('text/html; charset=utf-8')
      .header('Content-Security-Policy', "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    const found = SHARE_TOKEN_RE.test(req.params.token) ? await store.viewShare(req.params.token) : null;
    const { status, html } = found ? renderSharePage(publicView(found.data, found.share), { url: shareUrl(req, req.params.token) }) : renderNotFound();
    return reply.code(status).send(html);
  });

  // ───────────── API authentifiée
  app.register(async (api) => {
    api.decorateRequest('userId', null);
    api.addHook('onRequest', async (req) => {
      if (req.method === 'OPTIONS') return;
      const header = req.headers.authorization;
      const token = bearerToken(header);
      if (!token) {
        // Jamais la valeur de l'en-tête : seulement sa forme, pour diagnostiquer (« Bearer Bearer … », jeton vide…).
        req.log.warn({ origin: req.headers.origin, authorization: header ? { length: header.length, scheme: String(header).split(/\s+/)[0], parts: String(header).trim().split(/\s+/).length } : 'absent' },
          'requête sans jeton Bearer valide');
        throw new AuthError(401, 'missing_token', 'En-tête Authorization: Bearer <jeton> manquant');
      }
      const { userId } = await authClient.verify(token, req.log);
      req.userId = userId;
      await store.ensureUser(userId);
    });

    api.get('/me', async (req) => ({ userId: req.userId }));

    // Critères de recherche (objet « settings » de l'extension, stocké tel quel)
    api.get('/settings', async (req) => {
      const s = await store.getSettings(req.userId);
      return s ? { data: s.data, updatedAt: s.updatedAt } : { data: null, updatedAt: null };
    });

    api.put('/settings', {
      schema: {
        body: {
          type: 'object', required: ['data'], additionalProperties: false,
          properties: { data: { type: 'object' }, updatedAt: { type: 'integer', minimum: 1 } }
        }
      }
    }, async (req, reply) => {
      const { data } = req.body;
      if (size(data) > config.limits.settingsBytes) return fail(reply, 413, 'too_large', 'Critères trop volumineux');
      const updatedAt = clampTs(req.body.updatedAt || Date.now());
      const { applied, current } = await store.putSettings(req.userId, data, updatedAt);
      if (!applied) return reply.code(409).send({ error: 'conflict', message: 'Une version plus récente existe', current });
      return { data: current.data, updatedAt: current.updatedAt };
    });

    // Annonces
    api.get('/listings', {
      schema: {
        querystring: {
          type: 'object', additionalProperties: false,
          properties: {
            saved: { type: 'boolean' },
            status: { type: 'string', enum: STATUSES },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            offset: { type: 'integer', minimum: 0, default: 0 }
          }
        }
      }
    }, async (req) => store.listListings(req.userId, req.query));

    api.get('/listings/:id', async (req, reply) => {
      const item = await store.getListing(req.userId, req.params.id);
      return item || fail(reply, 404, 'not_found', 'Annonce introuvable');
    });

    api.patch('/listings/:id', {
      schema: {
        body: {
          type: 'object', additionalProperties: false, minProperties: 1,
          properties: {
            status: { type: 'string', enum: STATUSES },
            notes: { type: 'string', maxLength: 20000 },
            saved: { type: 'boolean' },
            checklist: { type: 'object', additionalProperties: { type: 'boolean' } },
            overrides: { type: 'object' }
          }
        }
      }
    }, async (req, reply) => {
      if (req.body.overrides && size(req.body.overrides) > 16 * 1024) return fail(reply, 413, 'too_large', 'Corrections trop volumineuses');
      const item = await store.patchListing(req.userId, req.params.id, req.body);
      return item || fail(reply, 404, 'not_found', 'Annonce introuvable');
    });

    api.delete('/listings/:id', async (req, reply) => {
      const ok = await store.deleteListing(req.userId, req.params.id);
      return ok ? reply.code(204).send() : fail(reply, 404, 'not_found', 'Annonce introuvable');
    });

    // Synchronisation de l'extension
    api.post('/sync', {
      schema: {
        body: {
          type: 'object', additionalProperties: false,
          properties: {
            since: { type: 'integer', minimum: 0, default: 0 },
            settings: {
              type: ['object', 'null'], required: ['data', 'updatedAt'], additionalProperties: false,
              properties: { data: { type: 'object' }, updatedAt: { type: 'integer', minimum: 1 } }
            },
            listings: {
              type: 'array', default: [], maxItems: config.limits.syncPushMax,
              items: {
                type: 'object', required: ['id', 'updatedAt'], additionalProperties: false,
                properties: {
                  id: { type: 'string', minLength: 1, maxLength: 300 },
                  updatedAt: { type: 'integer', minimum: 1 },
                  deleted: { type: 'boolean', default: false },
                  data: { type: ['object', 'null'] }
                }
              }
            }
          }
        }
      }
    }, async (req, reply) => {
      const b = req.body;
      if (b.settings && size(b.settings.data) > config.limits.settingsBytes) return fail(reply, 413, 'too_large', 'Critères trop volumineux');
      const listings = [];
      for (const l of b.listings) {
        if (!l.deleted) {
          if (!l.data) return fail(reply, 400, 'invalid_request', `Annonce ${l.id} : « data » manquant`);
          if (size(l.data) > config.limits.listingBytes) return fail(reply, 413, 'too_large', `Annonce ${l.id} trop volumineuse`);
          if (l.data.saved != null && typeof l.data.saved !== 'boolean') l.data.saved = !!l.data.saved;
          l.data.id = l.id;
        }
        listings.push({ id: l.id, data: l.data, deleted: l.deleted, updatedAt: clampTs(l.updatedAt) });
      }
      const settings = b.settings ? { data: b.settings.data, updatedAt: clampTs(b.settings.updatedAt) } : null;
      return store.sync(req.userId, { settings, listings }, b.since, config.limits.syncPullMax);
    });

    // Liens de partage
    const withUrl = (req, sh) => Object.assign(sh, { url: shareUrl(req, sh.token) });
    api.post('/shares', {
      schema: {
        body: {
          type: 'object', required: ['listingId'], additionalProperties: false,
          properties: {
            listingId: { type: 'string', minLength: 1, maxLength: 300 },
            message: { type: ['string', 'null'], maxLength: 1000 },
            includeNotes: { type: 'boolean', default: false },
            expiresInDays: { type: ['integer', 'null'], minimum: 1, maximum: 365 }
          }
        }
      }
    }, async (req, reply) => {
      const b = req.body;
      const share = await store.createShare(req.userId, b.listingId, {
        message: b.message && b.message.trim() ? b.message.trim() : null,
        includeNotes: b.includeNotes,
        expiresAt: b.expiresInDays ? Date.now() + b.expiresInDays * 86400000 : null
      });
      if (!share) return fail(reply, 404, 'not_found', 'Annonce introuvable : synchronise-la avant de la partager');
      return reply.code(201).send(withUrl(req, share));
    });
    api.get('/shares', {
      schema: { querystring: { type: 'object', additionalProperties: false, properties: { listingId: { type: 'string', maxLength: 300 } } } }
    }, async (req) => ({ items: (await store.listShares(req.userId, req.query.listingId)).map((sh) => withUrl(req, sh)) }));
    api.delete('/shares/:token', async (req, reply) => {
      const ok = await store.revokeShare(req.userId, req.params.token);
      return ok ? reply.code(204).send() : fail(reply, 404, 'not_found', 'Lien introuvable');
    });

    // Export et effacement de toutes les données du compte
    api.get('/export', async (req) => store.exportAll(req.userId));
    api.delete('/data', async (req, reply) => { await store.wipe(req.userId); return reply.code(204).send(); });
  }, { prefix: '/v1' });

  return app;
}
