/* Requêtes SQL. Règle de fusion : « la dernière écriture gagne » sur updated_at (ms).
 * Chaque écriture d'un utilisateur est sérialisée par un verrou consultatif, ce qui garantit
 * que les numéros de version sont validés dans l'ordre et que le curseur de synchro ne saute rien. */

import { newShareToken } from './share.js';

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
      await c.query(`UPDATE ${t('shares')} SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
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

  // ───────────── Partage public
  const toShare = (r) => ({
    token: r.token, listingId: r.listing_id, message: r.message, includeNotes: r.include_notes,
    createdAt: r.created_at.getTime(), expiresAt: r.expires_at ? r.expires_at.getTime() : null,
    views: r.views, lastViewedAt: r.last_viewed_at ? r.last_viewed_at.getTime() : null
  });

  /** Crée le lien de partage d'une annonce, ou met à jour ses options s'il existe déjà. null si l'annonce est inconnue. */
  async function createShare(userId, listingId, { message = null, includeNotes = false, expiresAt = null }) {
    return tx(async (c) => {
      await lockUser(c, userId);
      const { rowCount } = await c.query(`SELECT 1 FROM ${t('listings')} WHERE user_id = $1 AND id = $2 AND NOT deleted`, [userId, listingId]);
      if (!rowCount) return null;
      // Un lien expiré ne compte plus comme actif : on le clôt pour pouvoir en créer un neuf.
      await c.query(
        `UPDATE ${t('shares')} SET revoked_at = now() WHERE user_id = $1 AND listing_id = $2 AND revoked_at IS NULL AND expires_at <= now()`,
        [userId, listingId]
      );
      const exp = expiresAt ? new Date(expiresAt) : null;
      const upd = await c.query(
        `UPDATE ${t('shares')} SET message = $3, include_notes = $4, expires_at = $5
         WHERE user_id = $1 AND listing_id = $2 AND revoked_at IS NULL RETURNING *`,
        [userId, listingId, message, includeNotes, exp]
      );
      if (upd.rows[0]) return toShare(upd.rows[0]);
      const { rows } = await c.query(
        `INSERT INTO ${t('shares')} (token, user_id, listing_id, message, include_notes, expires_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [newShareToken(), userId, listingId, message, includeNotes, exp]
      );
      return toShare(rows[0]);
    });
  }

  async function listShares(userId, listingId) {
    const args = [userId];
    let cond = 'user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())';
    if (listingId) { args.push(listingId); cond += ' AND listing_id = $2'; }
    const { rows } = await pool.query(`SELECT * FROM ${t('shares')} WHERE ${cond} ORDER BY created_at DESC`, args);
    return rows.map(toShare);
  }

  async function revokeShare(userId, token) {
    const { rowCount } = await pool.query(
      `UPDATE ${t('shares')} SET revoked_at = now() WHERE user_id = $1 AND token = $2 AND revoked_at IS NULL`, [userId, token]
    );
    return rowCount > 0;
  }

  /** Lien public : annonce courante + options, et compte la consultation. null si inconnu, expiré, désactivé ou annonce supprimée. */
  async function viewShare(token) {
    const { rows } = await pool.query(
      `WITH s AS (
         UPDATE ${t('shares')} SET views = views + 1, last_viewed_at = now()
         WHERE token = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
           AND EXISTS (SELECT 1 FROM ${t('listings')} l WHERE l.user_id = ${t('shares')}.user_id AND l.id = ${t('shares')}.listing_id AND NOT l.deleted)
         RETURNING *)
       SELECT s.*, l.data FROM s JOIN ${t('listings')} l ON l.user_id = s.user_id AND l.id = s.listing_id`,
      [token]
    );
    return rows[0] ? { share: toShare(rows[0]), data: rows[0].data } : null;
  }

  return { ensureUser, getSettings, putSettings, listListings, getListing, patchListing, deleteListing, wipe, exportAll, sync,
    createShare, listShares, revokeShare, viewShare };
}

// nextval() attend un nom de séquence sous forme de texte : on le construit à partir du schéma déjà validé.
function quoteForRegclass(schema) { return '"' + schema.replace(/"/g, '""') + '"'; }
function pgLiteral(s) { return "'" + s.replace(/'/g, "''") + "'"; }
