// Broadcast messages to bot users (records + a simple throttled sender).
import { all, get, run, now } from '../db/index.js';
import * as tg from '../lib/telegramApi.js';
import { AppError } from '../lib/errors.js';
import { clean } from '../lib/escape.js';
import { listTgUsers, markTgBlocked } from './tgUsers.js';

export const BROADCAST_STATUS_LABELS = { draft: 'Черновик', sending: 'Отправляется', done: 'Отправлено', failed: 'Ошибка' };

export function getBroadcast(id) {
  return get('SELECT * FROM broadcasts WHERE id = ?', Number(id));
}

/** Newest first. */
export function listBroadcasts(limit = 30) {
  return all('SELECT * FROM broadcasts ORDER BY id DESC LIMIT ?', Number(limit));
}

/** data: { text* (Telegram HTML allowed), image (public https URL), button_text, button_url }, adminId */
export function createBroadcast(data, adminId = null) {
  const text = clean(data.text, 3500);
  if (!text) throw new AppError('validation', 'Напишите текст рассылки', 422);
  const { lastInsertRowid } = run(
    'INSERT INTO broadcasts (text, image, button_text, button_url, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    text, clean(data.image, 500), clean(data.button_text, 60), clean(data.button_url, 500), adminId, now());
  return getBroadcast(Number(lastInsertRowid));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Send a draft broadcast to every user who has not blocked the bot (~20 messages/second).
 * Resolves when finished with the updated row; safe to run without awaiting (progress is saved in the row).
 * @throws AppError 'bot_disabled' | 'bad_state'
 */
export async function sendBroadcast(id, { delayMs = 50 } = {}) {
  const b = getBroadcast(id);
  if (!b) throw new AppError('not_found', 'Рассылка не найдена', 404);
  if (!tg.isConfigured()) throw new AppError('bot_disabled', 'Бот не настроен: укажите BOT_TOKEN', 409);
  if (b.status !== 'draft') throw new AppError('bad_state', 'Эта рассылка уже отправлялась', 409);
  const users = listTgUsers({ activeOnly: true });
  run(`UPDATE broadcasts SET status = 'sending', total = ? WHERE id = ?`, users.length, b.id);
  const extra = b.button_text && /^https:\/\//.test(b.button_url)
    ? { reply_markup: { inline_keyboard: [[{ text: b.button_text, url: b.button_url }]] } }
    : {};
  let sent = 0;
  let failed = 0;
  for (const user of users) {
    try {
      if (b.image && /^https:\/\//.test(b.image)) {
        await tg.call('sendPhoto', { chat_id: user.chat_id || user.id, photo: b.image, caption: b.text, parse_mode: 'HTML', ...extra });
      } else {
        await tg.sendMessage(user.chat_id || user.id, b.text, extra);
      }
      sent += 1;
    } catch (err) {
      failed += 1;
      if (err.isBlocked) markTgBlocked(user.id, true);
      if (err.code === 429) await sleep(((err.parameters?.retry_after) || 1) * 1000);
    }
    if ((sent + failed) % 10 === 0) run('UPDATE broadcasts SET sent = ?, failed = ? WHERE id = ?', sent, failed, b.id);
    if (delayMs) await sleep(delayMs);
  }
  run(`UPDATE broadcasts SET status = 'done', sent = ?, failed = ?, finished_at = ? WHERE id = ?`, sent, failed, now(), b.id);
  return getBroadcast(b.id);
}
