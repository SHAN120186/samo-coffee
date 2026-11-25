// Feedback threads from the site form, the bot and the Mini App — one inbox.
//
// Lifecycle
//   incoming message  → stored (direction 'in') → forwarded to ADMIN_CHAT_ID; the id of that admin-chat
//                       message is saved in feedback_messages.admin_chat_message_id
//   admin answers     → from the panel (reply(threadId, { adminId })) or by REPLYING to the forwarded
//                       message in the admin chat (bot: findThreadByAdminMessageId(reply_to.message_id) → reply());
//                       the id of the staff answer is stored the same way, so a follow-up written as a
//                       reply to one's own answer (or to the bot's "✅ Ответ доставлен · обращение #N")
//                       reaches the same thread
//   reply()           → stored (direction 'out') → delivered to the user through the bot when the thread
//                       has tg_chat_id (bot / Mini App threads); site threads are answered by e-mail/phone manually
import { all, get, run, tx, now } from '../db/index.js';
import { config } from '../config.js';
import * as tg from '../lib/telegramApi.js';
import { escapeTg, clean, truncate } from '../lib/escape.js';
import { AppError, notFound } from '../lib/errors.js';
import { emit } from '../lib/bus.js';
import * as analytics from './analytics.js';
import * as settings from './settings.js';
import { markTgBlocked, tgDisplayName } from './tgUsers.js';

export const FEEDBACK_CHANNELS = ['site', 'bot', 'tma'];
export const FEEDBACK_CHANNEL_LABELS = { site: 'Сайт', bot: 'Telegram-бот', tma: 'Мини-приложение' };
export const FEEDBACK_STATUS_LABELS = { open: 'Ждёт ответа', answered: 'Отвечено', closed: 'Закрыто' };
export const MAX_MESSAGE_LENGTH = 4000;

const hydrateThread = (row) => (row ? {
  ...row,
  channel_label: FEEDBACK_CHANNEL_LABELS[row.channel] || row.channel,
  status_label: FEEDBACK_STATUS_LABELS[row.status] || row.status,
  /** replies can be delivered automatically through the bot */
  can_deliver: Boolean(row.tg_chat_id),
} : null);

function adminNotificationHtml(thread, text) {
  const who = [thread.name, thread.contact].filter(Boolean).map(escapeTg).join(' · ') || 'Без имени';
  const hint = thread.tg_chat_id
    ? 'Ответьте на это сообщение (reply) — клиент получит ответ в Telegram.'
    : 'Клиент написал с сайта — свяжитесь по указанному контакту или ответьте в админ-панели.';
  return [
    `💬 <b>Обращение #${thread.id}</b> · ${FEEDBACK_CHANNEL_LABELS[thread.channel]}`,
    `👤 ${who}`,
    thread.subject ? `Тема: ${escapeTg(thread.subject)}` : null,
    '',
    escapeTg(truncate(text, 3500)),
    '',
    `<i>${hint}</i>`,
  ].filter((l) => l !== null).join('\n');
}

/** Forward an incoming message to the admin chat and remember the notification id for reply mapping. */
async function forwardToAdmins(thread, message) {
  if (!tg.isConfigured() || !config.bot.adminChatId) return null;
  const sent = await tg.trySendMessage(config.bot.adminChatId, adminNotificationHtml(thread, message.text));
  if (sent?.message_id) setAdminMessageId(message.id, sent.message_id);
  return sent;
}

function insertMessage(threadId, { direction, text, adminId = null, via = '', tgMessageId = null }) {
  const ts = now();
  const { lastInsertRowid } = run(
    `INSERT INTO feedback_messages (thread_id, direction, text, admin_id, via, tg_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    threadId, direction, text, adminId, via, tgMessageId, ts,
  );
  if (direction === 'in') {
    run(`UPDATE feedback_threads SET status = 'open', unread = unread + 1, last_message_at = ? WHERE id = ?`, ts, threadId);
  } else {
    run(`UPDATE feedback_threads SET status = 'answered', unread = 0, last_message_at = ? WHERE id = ?`, ts, threadId);
  }
  return get('SELECT * FROM feedback_messages WHERE id = ?', Number(lastInsertRowid));
}

function normalizeText(text) {
  const t = clean(text, MAX_MESSAGE_LENGTH);
  if (!t) throw new AppError('validation', 'Напишите сообщение', 422, { fields: { text: 'Напишите сообщение' } });
  return t;
}

/**
 * Start a new thread with its first incoming message (site form, Mini App form).
 * @param {object} p
 * @param {'site'|'bot'|'tma'} p.channel
 * @param {string} p.text
 * @param {string} [p.name] @param {string} [p.contact] e-mail / phone / @username @param {string} [p.subject]
 * @param {number} [p.customerId]
 * @param {number} [p.tgUserId] @param {number} [p.tgChatId] chat where replies are delivered (defaults to tgUserId)
 * @param {number} [p.tgMessageId] @param {string} [p.sessionId] analytics session
 * @param {boolean} [p.notify] forward to the admin chat (default true)
 * @returns {Promise<{ thread: object, message: object }>}
 * @throws AppError 'validation'
 */
export async function createThread(p) {
  const channel = FEEDBACK_CHANNELS.includes(p.channel) ? p.channel : 'site';
  const text = normalizeText(p.text);
  const { thread, message } = tx(() => {
    const ts = now();
    const { lastInsertRowid } = run(
      `INSERT INTO feedback_threads (channel, customer_id, tg_user_id, tg_chat_id, name, contact, subject, created_at, last_message_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      channel, p.customerId ?? null, p.tgUserId ?? null, p.tgChatId ?? p.tgUserId ?? null,
      clean(p.name, 120), clean(p.contact, 160), clean(p.subject, 200), ts, ts,
    );
    const id = Number(lastInsertRowid);
    const msg = insertMessage(id, { direction: 'in', text, tgMessageId: p.tgMessageId ?? null });
    return { thread: getThreadRow(id), message: msg };
  });
  analytics.trackEvent('feedback', { channel, sessionId: p.sessionId, tgUserId: p.tgUserId, meta: { thread_id: thread.id } });
  if (p.notify !== false) await forwardToAdmins(thread, message);
  emit('feedback.thread', { thread, message });
  emit('feedback.message', { thread, message });
  return { thread: getThreadRow(thread.id), message: get('SELECT * FROM feedback_messages WHERE id = ?', message.id) };
}

/**
 * Add an incoming message to an existing thread (reopens it).
 * @param {number} threadId
 * @param {{ text: string, tgMessageId?: number, notify?: boolean }} p
 * @returns {Promise<object>} message row
 */
export async function addIncoming(threadId, p) {
  const thread = getThreadRow(threadId);
  if (!thread) throw notFound('Обращение');
  const message = insertMessage(thread.id, { direction: 'in', text: normalizeText(p.text), tgMessageId: p.tgMessageId ?? null });
  const fresh = getThreadRow(thread.id);
  if (p.notify !== false) await forwardToAdmins(fresh, message);
  emit('feedback.message', { thread: fresh, message });
  return get('SELECT * FROM feedback_messages WHERE id = ?', message.id);
}

/**
 * Store a message a Telegram user wrote to the bot in support mode: appends to the user's latest
 * not-closed bot thread or opens a new one, then forwards to the admin chat.
 * @param {object} p
 * @param {{ id: number, username?: string, first_name?: string, last_name?: string }} p.tgUser
 * @param {number} [p.chatId] defaults to tgUser.id
 * @param {string} p.text
 * @param {number} [p.tgMessageId]
 * @param {'bot'|'tma'} [p.channel] default 'bot'
 * @param {boolean} [p.notify] default true; pass false when the bot forwards the original message itself
 *        (then call setAdminMessageId(message.id, forwarded.message_id))
 * @returns {Promise<{ thread: object, message: object, isNew: boolean }>}
 */
export async function receiveFromTelegram(p) {
  const channel = p.channel === 'tma' ? 'tma' : 'bot';
  const existing = get(
    `SELECT id FROM feedback_threads WHERE tg_user_id = ? AND channel = ? AND status <> 'closed' ORDER BY id DESC LIMIT 1`,
    Number(p.tgUser.id), channel);
  if (existing) {
    const message = await addIncoming(existing.id, { text: p.text, tgMessageId: p.tgMessageId, notify: p.notify });
    return { thread: getThreadRow(existing.id), message, isNew: false };
  }
  const customer = get('SELECT id FROM customers WHERE tg_user_id = ?', Number(p.tgUser.id));
  const created = await createThread({
    channel,
    text: p.text,
    name: tgDisplayName(p.tgUser),
    contact: p.tgUser.username ? `@${p.tgUser.username}` : `tg id ${p.tgUser.id}`,
    customerId: customer?.id,
    tgUserId: p.tgUser.id,
    tgChatId: p.chatId ?? p.tgUser.id,
    tgMessageId: p.tgMessageId,
    notify: p.notify,
  });
  return { ...created, isNew: true };
}

/**
 * Answer a thread. Stores the outgoing message and, when the thread belongs to a Telegram user,
 * delivers it through the bot.
 * @param {number} threadId
 * @param {{ text: string, adminId?: number|null, via?: 'panel'|'telegram' }} p
 * @returns {Promise<{ message: object, delivered: boolean, deliverable: boolean, error?: string }>}
 *   deliverable=false → site thread (no Telegram chat): answer by e-mail/phone.
 */
export async function reply(threadId, p) {
  const thread = getThreadRow(threadId);
  if (!thread) throw notFound('Обращение');
  const text = normalizeText(p.text);
  const message = insertMessage(thread.id, { direction: 'out', text, adminId: p.adminId ?? null, via: p.via === 'telegram' ? 'telegram' : 'panel' });

  let delivered = false;
  let error;
  const deliverable = Boolean(thread.tg_chat_id);
  if (deliverable) {
    if (!tg.isConfigured()) {
      error = 'Бот не настроен (BOT_TOKEN) — ответ сохранён, но не отправлен.';
    } else {
      try {
        const sent = await tg.sendMessage(thread.tg_chat_id, `💬 <b>Ответ ${escapeTg(settings.get('site_name', 'Samo Coffee'))}</b>\n\n${escapeTg(text)}`);
        run('UPDATE feedback_messages SET delivered = 1, tg_message_id = ? WHERE id = ?', sent?.message_id ?? null, message.id);
        delivered = true;
      } catch (err) {
        if (err.isBlocked && thread.tg_user_id) markTgBlocked(thread.tg_user_id, true);
        error = err.isBlocked ? 'Пользователь заблокировал бота — ответ не доставлен.' : 'Не удалось отправить ответ в Telegram.';
        if (!config.isTest) console.warn(`[feedback] reply delivery failed: ${err.message}`);
      }
    }
  }
  const fresh = getThreadRow(thread.id);
  const stored = get('SELECT * FROM feedback_messages WHERE id = ?', message.id);
  emit('feedback.message', { thread: fresh, message: stored });
  return { message: stored, delivered, deliverable, ...(error ? { error } : {}) };
}

/** Remember which admin-chat message represents a stored message (reply mapping). */
export function setAdminMessageId(messageId, adminChatMessageId) {
  run('UPDATE feedback_messages SET admin_chat_message_id = ? WHERE id = ?', Number(adminChatMessageId), Number(messageId));
}

/**
 * The stored message that a message of the admin chat stands for: the forwarded customer message
 * (direction 'in') or a staff answer written in the chat (direction 'out'), with its thread.
 * @returns {{ thread: object, message: object } | null}
 */
export function findMessageByAdminMessageId(adminChatMessageId) {
  const message = get('SELECT * FROM feedback_messages WHERE admin_chat_message_id = ? ORDER BY id DESC LIMIT 1', Number(adminChatMessageId));
  const thread = message ? getThreadRow(message.thread_id) : null;
  return thread ? { thread, message } : null;
}

/** Thread whose forwarded notification has this message id in the admin chat, or null. */
export function findThreadByAdminMessageId(adminChatMessageId) {
  const row = get('SELECT thread_id FROM feedback_messages WHERE admin_chat_message_id = ? ORDER BY id DESC LIMIT 1', Number(adminChatMessageId));
  return row ? getThreadRow(row.thread_id) : null;
}

function getThreadRow(id) {
  return hydrateThread(get('SELECT * FROM feedback_threads WHERE id = ?', Number(id)));
}

/** Thread with messages[] (oldest first; each "out" message has admin_name) or null. */
export function getThread(id) {
  const thread = getThreadRow(id);
  if (!thread) return null;
  const messages = all(
    `SELECT m.*, a.name AS admin_name FROM feedback_messages m LEFT JOIN admins a ON a.id = m.admin_id WHERE m.thread_id = ? ORDER BY m.id`, thread.id);
  return { ...thread, messages };
}

/**
 * Inbox list, most recent activity first. Each item has last_text / last_direction / messages_count.
 * @param {{ status?: 'open'|'answered'|'closed', channel?: string, search?: string, tgUserId?: number, limit?: number, offset?: number }} [f]
 * @returns {{ items: object[], total: number }}
 */
export function listThreads(f = {}) {
  const where = [];
  const params = [];
  if (f.status && FEEDBACK_STATUS_LABELS[f.status]) { where.push('t.status = ?'); params.push(f.status); }
  if (f.channel && FEEDBACK_CHANNELS.includes(f.channel)) { where.push('t.channel = ?'); params.push(f.channel); }
  if (f.tgUserId) { where.push('t.tg_user_id = ?'); params.push(Number(f.tgUserId)); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  let rows = all(
    `SELECT t.*,
            (SELECT text FROM feedback_messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_text,
            (SELECT direction FROM feedback_messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_direction,
            (SELECT COUNT(*) FROM feedback_messages m WHERE m.thread_id = t.id) AS messages_count
       FROM feedback_threads t ${w} ORDER BY t.last_message_at DESC, t.id DESC`, ...params);
  const s = String(f.search || '').toLocaleLowerCase('ru').trim();
  if (s) rows = rows.filter((r) => `${r.name} ${r.contact} ${r.subject} ${r.last_text || ''}`.toLocaleLowerCase('ru').includes(s));
  const offset = Number(f.offset) || 0;
  return { items: rows.slice(offset, offset + (Number(f.limit) || 50)).map(hydrateThread), total: rows.length };
}

/** Threads of a Telegram user with messages[] (Mini App "my requests"). */
export function listForTgUser(tgUserId, limit = 10) {
  return all('SELECT id FROM feedback_threads WHERE tg_user_id = ? ORDER BY last_message_at DESC LIMIT ?', Number(tgUserId), Number(limit))
    .map((r) => getThread(r.id));
}

/** Reset the unread counter (an admin opened the thread). */
export function markRead(id) {
  run('UPDATE feedback_threads SET unread = 0 WHERE id = ?', Number(id));
}

/** 'open' | 'answered' | 'closed' */
export function setThreadStatus(id, status) {
  if (!FEEDBACK_STATUS_LABELS[status]) throw new AppError('validation', 'Неизвестный статус', 422);
  run('UPDATE feedback_threads SET status = ?, unread = CASE WHEN ? = \'closed\' THEN 0 ELSE unread END WHERE id = ?', status, status, Number(id));
  return getThreadRow(id);
}

export function deleteThread(id) {
  return run('DELETE FROM feedback_threads WHERE id = ?', Number(id)).changes > 0;
}

/** { open, answered, closed, unread (threads with unread messages) } — for the sidebar badge. */
export function counts() {
  const out = { open: 0, answered: 0, closed: 0, unread: 0 };
  for (const r of all('SELECT status, COUNT(*) AS n FROM feedback_threads GROUP BY status')) out[r.status] = r.n;
  out.unread = get('SELECT COUNT(*) AS n FROM feedback_threads WHERE unread > 0').n;
  return out;
}
