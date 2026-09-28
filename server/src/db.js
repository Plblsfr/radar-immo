/* Accès PostgreSQL. Toutes les tables vivent dans un schéma dédié (DB_SCHEMA),
 * sur la même base que le backend principal : les noms sont toujours qualifiés,
 * ce qui reste compatible avec un pooler (PgBouncer) en mode transaction. */
import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

export const quoteIdent = (s) => '"' + String(s).replace(/"/g, '""') + '"';

export function createDb(cfg) {
  const pool = new pg.Pool({
    connectionString: cfg.databaseUrl,
    max: cfg.dbPoolMax,
    ssl: cfg.dbSsl ? { rejectUnauthorized: false } : undefined,
    application_name: 'radar-immo-server'
  });
  const schema = quoteIdent(cfg.dbSchema);
  /** Nom de table qualifié : t('listings') → "radar_immo"."listings" */
  const t = (name) => `${schema}.${quoteIdent(name)}`;

  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async function migrate(log = console) {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    return tx(async (c) => {
      // Un seul migrateur à la fois, même avec plusieurs instances qui démarrent ensemble.
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['radar-immo-migrate:' + cfg.dbSchema]);
      // Le schéma peut avoir été créé par un administrateur (sql/grants.sql) : on ne le crée
      // que s'il manque, car CREATE SCHEMA exige le droit CREATE sur toute la base.
      const exists = await c.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [cfg.dbSchema]);
      if (!exists.rowCount) await c.query(`CREATE SCHEMA ${schema}`);
      await c.query(`CREATE TABLE IF NOT EXISTS ${t('schema_migrations')} (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const { rows } = await c.query(`SELECT name FROM ${t('schema_migrations')}`);
      const done = new Set(rows.map((r) => r.name));
      const applied = [];
      for (const f of files) {
        if (done.has(f)) continue;
        const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/:schema\b/g, schema);
        await c.query(sql);
        await c.query(`INSERT INTO ${t('schema_migrations')} (name) VALUES ($1)`, [f]);
        applied.push(f);
        log.info?.(`Migration appliquée : ${f}`);
      }
      return applied;
    });
  }

  return { pool, t, tx, migrate, schema: cfg.dbSchema, close: () => pool.end() };
}
