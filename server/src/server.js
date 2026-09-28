/* Point d'entrée : node src/server.js */
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { createStore } from './store.js';
import { createAuthClient } from './auth.js';
import { buildApp } from './app.js';

const config = loadConfig();
const db = createDb(config);
const store = createStore(db);
const authClient = createAuthClient(config.auth);
const app = buildApp({ config, store, authClient, db });

app.log.info({
  auth: { verifyUrl: config.auth.verifyUrl, header: config.auth.headerName, prefix: JSON.stringify(config.auth.headerPrefix),
    timeoutMs: config.auth.timeoutMs, cacheTtlMs: config.auth.cacheTtlMs, userIdPaths: config.auth.userIdPaths, userIdFromJwt: config.auth.userIdFromJwt },
  db: { schema: config.dbSchema, host: (() => { try { return new URL(config.databaseUrl).host; } catch { return '?'; } })() },
  cors: config.cors
}, 'configuration');

if (config.migrateOnStart) await db.migrate(app.log);
await app.listen({ host: config.host, port: config.port });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, async () => {
    app.log.info(`${sig} reçu, arrêt en cours`);
    await app.close();
    await db.close();
    process.exit(0);
  });
}
