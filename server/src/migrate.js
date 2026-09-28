/* Applique les migrations en attente puis s'arrête : npm run migrate */
import { loadConfig } from './config.js';
import { createDb } from './db.js';

const env = { ...process.env, AUTH_VERIFY_URL: process.env.AUTH_VERIFY_URL || 'http://inutile-pour-les-migrations' };
const db = createDb(loadConfig(env));
try {
  const applied = await db.migrate(console);
  console.log(applied.length ? `${applied.length} migration(s) appliquée(s)` : 'Base à jour');
} finally {
  await db.close();
}
