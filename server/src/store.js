/* Requêtes SQL. Règle de fusion : « la dernière écriture gagne » sur updated_at (ms).
 * Chaque écriture d'un utilisateur est sérialisée par un verrou consultatif, ce qui garantit
 * que les numéros de version sont validés dans l'ordre et que le curseur de synchro ne saute rien. */

export function createStore(db) {
  const { t, tx, pool } = db;
  const seq = `nextval(${pgLiteral(`${quoteForRegclass(db.schema)}.change_seq`)})`;

  const lockUser = (c, userId) => c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['radar-immo-user:' + userId]);

  const touched = new Map(); // userId → dernière mise à jour de last_seen_at (ms)
  async function ensureUser(userId) {
    const last = touched.get(userId);
    if (last && Date.now() - last < 5 * 60 * 1000) return;
    await pool.query(
      `INSERT INTO ${t('users')} (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET last_seen_at = now()`,
      [userId]
    );
    if (touched.size > 50000) touched.clear();
    touched.set(userId, Date.now());
  }

  // ───────────── Critères
  async function getSettings(userId, c = pool) {
    const { rows } = await c.query(`SELECT data, updated_at, version FROM ${t('settings')} WHERE user_id = $1`, [userId]);
    return rows[0] ? { data: rows[0].data, updatedAt: Number(rows[0].updated_at), version: Number(rows[0].version) } : null;
  }

  /** Écrit les critères si updatedAt est plus récent que la version stockée. Renvoie true si appliqué. */
  async function putSettingsTx(c, userId, data, updatedAt) {
    const { rowCount } = await c.query(
      `INSERT INTO ${t('settings')} (user_id, data, updated_at, version) VALUES ($1, $2, $3, ${seq})
       ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at, version = ${seq}
       WHERE ${t('settings')}.updated_at < EXCLUDED.updated_at`,
      [userId, JSON.stringify(data), updatedAt]
    );
    return rowCount > 0;
  }

  async function putSettings(userId, data, updatedAt) {
    return tx(async (c) => {
      await lockUser(c, userId);
      const applied = await putSettingsTx(c, userId, data, updatedAt);
      return { applied, current: await getSettings(userId, c) };
    });
  }

  // ───────────── Annonces
  async function upsertListingTx(c, userId, { id, data, deleted, updatedAt }) {
    const { rowCount } = await c.query(
      `INSERT INTO ${t('listings')} (user_id, id, data, deleted, updated_at, version) VALUES ($1, $2, $3, $4, $5, ${seq})
       ON CONFLICT (user_id, id) DO UPDATE SET data = EXCLUDED.data, deleted = EXCLUDED.deleted,
         updated_at = EXCLUDED.updated_at, version = ${seq}
       WHERE ${t('listings')}.updated_at < EXCLUDED.updated_at`,
      [userId, id, JSON.stringify(deleted ? {} : data), !!deleted, updatedAt]
    );
    return rowCount > 0;
  }

  const toItem = (r) => Object.assign({}, r.data, { id: r.id, updatedAt: Number(r.updated_at) });

  async function listListings(userId, { saved, status, limit, offset }) {
    const where = ['user_id = $1', 'NOT deleted'];
    const args = [userId];
    if (saved != null) { args.push(saved); where.push(`saved = $${args.length}`); }
    if (status) { args.push(status); where.push(`status = $${args.length}`); }
    const cond = where.join(' AND ');
    const [{ rows }, count] = await Promise.all([
      pool.query(
        `SELECT id, data, updated_at FROM ${t('listings')} WHERE ${cond}
         ORDER BY updated_at DESC, id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
        [...args, limit, offset]
      ),
      pool.query(`SELECT count(*)::int AS n FROM ${t('listings')} WHERE ${cond}`, args)
    ]);
    return { items: rows.map(toItem), total: count.rows[0].n };
  }

  async function getListing(userId, id, c = pool) {
    const { rows } = await c.query(
      `SELECT id, data, updated_at FROM ${t('listings')} WHERE user_id = $1 AND id = $2 AND NOT deleted`, [userId, id]
    );
    return rows[0] ? toItem(rows[0]) : null;
  }

  /** Fusionne des champs de suivi dans une annonce existante (horodatage serveur). */
  async function patchListing(userId, id, patch) {
    return tx(async (c) => {
      await lockUser(c, userId);
      const { rows } = await c.query(
        `UPDATE ${t('listings')} SET data = data || $3::jsonb,
           updated_at = GREATEST($4::bigint, updated_at + 1), version = ${seq}
         WHERE user_id = $1 AND id = $2 AND NOT deleted RETURNING id, data, updated_at`,
        [userId, id, JSON.stringify(patch), Date.now()]
      );
      return rows[0] ? toItem(rows[0]) : null;
    });
  }

  async function deleteListing(userId, id) {
    return tx(async (c) => {
      await lockUser(c, userId);
      const { rowCount } = await c.query(
        `UPDATE ${t('listings')} SET data = '{}'::jsonb, deleted = true,
           updated_at = GREATEST($3::bigint, updated_at + 1), version = ${seq}
         WHERE user_id = $1 AND id = $2 AND NOT deleted`,
        [userId, id, Date.now()]
      );
      return rowCount > 0;
    });
  }

  /** Efface les données d'un utilisateur. Les annonces deviennent des tombes pour que
   *  la suppression se propage aux autres appareils synchronisés. */
  async function wipe(userId) {
    return tx(async (c) => {
      await lockUser(c, userId);
      const now = Date.now();
      await c.query(
        `UPDATE ${t('listings')} SET data = '{}'::jsonb, deleted = true,
           updated_at = GREATEST($2::bigint, updated_at + 1), version = ${seq}
         WHERE user_id = $1 AND NOT deleted`,
        [userId, now]
      );
      await c.query(`DELETE FROM ${t('settings')} WHERE user_id = $1`, [userId]);
    });
  }

  async function exportAll(userId) {
    const [settings, { rows }] = await Promise.all([
      getSettings(userId),
      pool.query(`SELECT id, data, updated_at FROM ${t('listings')} WHERE user_id = $1 AND NOT deleted ORDER BY id`, [userId])
    ]);
    const listings = {};
    rows.forEach((r) => { listings[r.id] = toItem(r); });
    return { settings: settings ? settings.data : null, settingsUpdatedAt: settings ? settings.updatedAt : null, listings };
  }

  // ───────────── Synchronisation
  /**
   * Applique les changements poussés par un appareil puis renvoie ceux qu'il n'a pas encore vus.
   * @param {object} push { settings?: {data, updatedAt}, listings: [{id, updatedAt, deleted?, data?}] }
   * @param {number} since curseur renvoyé par la synchro précédente (0 la première fois)
   */
  async function sync(userId, push, since, pullLimit) {
    return tx(async (c) => {
      await lockUser(c, userId);
      let settingsApplied = null;
      if (push.settings) settingsApplied = await putSettingsTx(c, userId, push.settings.data, push.settings.updatedAt);
      const applied = [], ignored = [];
      for (const l of push.listings) ((await upsertListingTx(c, userId, l)) ? applied : ignored).push(l.id);

      const { rows } = await c.query(
        `SELECT id, data, deleted, updated_at, version FROM ${t('listings')}
         WHERE user_id = $1 AND version > $2 ORDER BY version LIMIT $3`,
        [userId, since, pullLimit + 1]
      );
      const hasMore = rows.length > pullLimit;
      const page = rows.slice(0, pullLimit);
      const s = await getSettings(userId, c);
      const { rows: maxRows } = await c.query(
        `SELECT GREATEST(
           (SELECT max(version) FROM ${t('listings')} WHERE user_id = $1),
           (SELECT max(version) FROM ${t('settings')} WHERE user_id = $1)) AS v`,
        [userId]
      );
      const cursor = hasMore ? Number(page[page.length - 1].version) : Math.max(since, Number(maxRows[0].v || 0));
      return {
        cursor,
        hasMore,
        settings: s && s.version > since ? { data: s.data, updatedAt: s.updatedAt } : null,
        listings: page.map((r) => ({
          id: r.id, updatedAt: Number(r.updated_at), deleted: r.deleted, data: r.deleted ? null : r.data
        })),
        applied: { settings: settingsApplied, listings: applied.length, ignored: ignored.length }
      };
    });
  }

  return { ensureUser, getSettings, putSettings, listListings, getListing, patchListing, deleteListing, wipe, exportAll, sync };
}

// nextval() attend un nom de séquence sous forme de texte : on le construit à partir du schéma déjà validé.
function quoteForRegclass(schema) { return '"' + schema.replace(/"/g, '""') + '"'; }
function pgLiteral(s) { return "'" + s.replace(/'/g, "''") + "'"; }
