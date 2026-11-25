// Telegram users known to the bot / Mini App (tg_users table) + bot conversation state.
import { all, get, run, now, parseJson } from '../db/index.js';

const hydrate = (row) => (row ? { ...row, state_data: parseJson(row.state_data, {}) } : null);

export function getTgUser(id) {
  return hydrate(get('SELECT * FROM tg_users WHERE id = ?', Number(id)));
}

/**
 * Register or refresh a Telegram user.
 * @param {{ id: number, username?: string, first_name?: string, last_name?: string, language_code?: string }} tgUser Telegram User object
 * @param {{ chatId?: number, startParam?: string, source?: 'bot'|'tma' }} [meta]
 *   chatId — private chat id (set by the bot; the Mini App does not know it, the user id is used)
 *   startParam — deep-link payload, stored only the first time
 * @returns {{ user: object, isNew: boolean }}
 */
export function upsertTgUser(tgUser, { chatId = null, startParam = null, source = 'bot' } = {}) {
  const id = Number(tgUser.id);
  const existing = get('SELECT * FROM tg_users WHERE id = ?', id);
  const ts = now();
  if (!existing) {
    run(
      `INSERT INTO tg_users (id, chat_id, username, first_name, last_name, language_code, start_param, source, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, chatId ?? id, tgUser.username || null, tgUser.first_name || '', tgUser.last_name || '',
      tgUser.language_code || null, startParam || null, source === 'tma' ? 'tma' : 'bot', ts, ts,
    );
    return { user: getTgUser(id), isNew: true };
  }
  run(
    `UPDATE tg_users SET chat_id = ?, username = ?, first_name = ?, last_name = ?, language_code = ?,
       start_param = COALESCE(start_param, ?), is_blocked = CASE WHEN ? THEN 0 ELSE is_blocked END, is_demo = 0, last_seen_at = ? WHERE id = ?`,
    chatId ?? existing.chat_id ?? id, tgUser.username || existing.username, tgUser.first_name || existing.first_name,
    tgUser.last_name ?? existing.last_name, tgUser.language_code || existing.language_code,
    startParam || null, source === 'bot' ? 1 : 0, ts, id,
  );
  return { user: getTgUser(id), isNew: false };
}

/** Set the bot conversation state ('' = idle, 'support' = feedback mode, ...). */
export function setTgState(id, state = '', data = {}) {
  run('UPDATE tg_users SET state = ?, state_data = ?, last_seen_at = ? WHERE id = ?', String(state), JSON.stringify(data ?? {}), now(), Number(id));
  return getTgUser(id);
}

/** Mark that the user blocked the bot (or unblocked it). */
export function markTgBlocked(id, blocked = true) {
  run('UPDATE tg_users SET is_blocked = ? WHERE id = ?', blocked ? 1 : 0, Number(id));
}

/**
 * May the bot write to this Telegram user? Not when the user blocked the bot, and never to the
 * made-up users of the demo seed (is_demo) — their ids may belong to real strangers.
 */
export function isReachable(id) {
  const row = id ? get('SELECT is_blocked, is_demo FROM tg_users WHERE id = ?', Number(id)) : null;
  return Boolean(row) && !row.is_blocked && !row.is_demo;
}

/** True for a user created by the demo seed (never write to them). Unknown users are not demo users. */
export function isDemoUser(id) {
  return Boolean(id && get('SELECT 1 AS x FROM tg_users WHERE id = ? AND is_demo = 1', Number(id)));
}

/**
 * Recipients of a broadcast after `afterId`, in id order: users who have not blocked the bot,
 * demo users excluded. Paged, so a broadcast can continue from a stored cursor.
 * @returns {Array<{ id: number, chat_id: number|null }>}
 */
export function broadcastAudience(afterId = 0, limit = 200) {
  return all('SELECT id, chat_id FROM tg_users WHERE is_blocked = 0 AND is_demo = 0 AND id > ? ORDER BY id LIMIT ?', Number(afterId) || 0, Number(limit));
}

/** How many recipients broadcastAudience() still has after `afterId`. */
export function countBroadcastAudience(afterId = 0) {
  return get('SELECT COUNT(*) AS n FROM tg_users WHERE is_blocked = 0 AND is_demo = 0 AND id > ?', Number(afterId) || 0).n;
}

/** Users for the admin list. activeOnly skips users who blocked the bot. */
export function listTgUsers({ activeOnly = false, limit = 100000, offset = 0 } = {}) {
  return all(
    `SELECT * FROM tg_users ${activeOnly ? 'WHERE is_blocked = 0' : ''} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    Number(limit), Number(offset),
  ).map(hydrate);
}

/**
 * { total, active, blocked, demo } — `active` = users the bot can write to (the broadcast audience):
 * not blocked and not created by the demo seed.
 */
export function countTgUsers() {
  const r = get(`SELECT COUNT(*) AS total, COALESCE(SUM(is_blocked), 0) AS blocked,
                        COALESCE(SUM(CASE WHEN is_demo = 1 AND is_blocked = 0 THEN 1 ELSE 0 END), 0) AS demo FROM tg_users`);
  return { total: r.total, blocked: r.blocked, demo: r.demo, active: r.total - r.blocked - r.demo };
}

/** Human display name: "Имя Фамилия" or "@username" or "id123". */
export function tgDisplayName(u) {
  if (!u) return '';
  const full = `${u.first_name || ''} ${u.last_name || ''}`.trim();
  return full || (u.username ? `@${u.username}` : `id${u.id}`);
}
