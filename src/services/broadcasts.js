// Broadcast messages to bot users (records + a throttled, resumable sender).
//
// Lifecycle:  draft ──► sending ──► done
//                          │ ▲
//                          ▼ │ "Продолжить" in the panel / automatic resume at boot
//                        failed          (stopped by an error that is the same for every recipient,
//                                         or because Telegram could not be reached)
//
// The sender walks the recipients in tg_users.id order and stores, after EVERY recipient, the last
// id it has processed (`cursor`) together with the counters. So:
//   • a restart / deploy in the middle of a send does not lose it: the row stays 'sending' and
//     resumeInterrupted() (called at boot) continues from the cursor — nobody is skipped and nobody
//     gets the message twice (at most the one recipient that was in flight);
//   • a flood limit (429) pauses and retries the SAME recipient instead of dropping them;
//   • an error that every recipient would get (malformed HTML, bad button URL, wrong token) stops
//     the send at once with status 'failed' and the Telegram description in `error`.
import { all, get, run, now } from '../db/index.js';
import * as tg from '../lib/telegramApi.js';
import { AppError } from '../lib/errors.js';
import { clean } from '../lib/escape.js';
import { broadcastAudience, countBroadcastAudience, markTgBlocked } from './tgUsers.js';

export const BROADCAST_STATUS_LABELS = { draft: 'Черновик', sending: 'Отправляется', done: 'Отправлено', failed: 'Остановлена' };

/** Longest single pause (seconds) while Telegram asks us to slow down. */
export const MAX_FLOOD_WAIT_SEC = 60;
/** Attempts per recipient for flood limits and network / 5xx failures. */
const MAX_ATTEMPTS = 4;
const PAGE = 200;

/** Broadcasts that THIS process is sending right now. */
const active = new Set();
let stopping = false;

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

/**
 * Telegram's HTML subset must be well formed: every tag closed, in the right order. Returns a
 * Russian message for the first problem, or '' when the markup is balanced.
 * (An unbalanced tag makes sendMessage fail with 400 for EVERY recipient.)
 */
export function htmlProblem(text) {
  const stack = [];
  for (const m of String(text ?? '').matchAll(/<(\/?)([a-z][a-z0-9-]*)(?:\s[^<>]*)?>/gi)) {
    const name = m[2].toLowerCase();
    if (!m[1]) stack.push(name);
    else if (stack.pop() !== name) return `Тег </${name}> закрыт не на своём месте — проверьте разметку`;
  }
  return stack.length ? `Тег <${stack.at(-1)}> не закрыт — добавьте </${stack.at(-1)}>` : '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True while this process is sending the broadcast. */
export const isSending = (id) => active.has(Number(id));

/**
 * May the broadcast be started / continued from the panel?
 * A draft; a stopped ('failed') one; or one that is 'sending' in the database but not in this
 * process (the previous process died in the middle).
 */
export function canSend(b) {
  if (!b || active.has(b.id)) return false;
  return b.status === 'draft' || b.status === 'failed' || b.status === 'sending';
}

/** Errors that have nothing to do with the message: this chat cannot be written to. */
const RECIPIENT_ERRORS = /chat not found|user not found|peer_id_invalid|deactivated|blocked|can't initiate|was kicked|not a member|have no rights|not enough rights|chat_write_forbidden|chat was deleted|upgraded to a supergroup/i;

/**
 * Send to one recipient. → 'sent' | 'failed' (this recipient only) | { stop: string } (the whole
 * broadcast must stop: every other recipient would fail the same way / Telegram is unavailable).
 */
async function deliver(b, user, extra, { sleepFn, maxFloodWaitSec }) {
  const chatId = user.chat_id || user.id;
  for (let attempt = 1; ; attempt += 1) {
    try {
      if (b.image && /^https:\/\//.test(b.image)) {
        await tg.call('sendPhoto', { chat_id: chatId, photo: b.image, caption: b.text, parse_mode: 'HTML', ...extra });
      } else {
        await tg.sendMessage(chatId, b.text, extra);
      }
      return 'sent';
    } catch (err) {
      const description = String(err.description || err.message || '');
      if (err.isBlocked || ((err.code === 400 || err.code === 403) && RECIPIENT_ERRORS.test(description))) {
        if (err.isBlocked) markTgBlocked(user.id, true);
        return 'failed';
      }
      const flood = err.code === 429;
      const transient = flood || err.code === -1 || err.code >= 500;
      if (transient && attempt < MAX_ATTEMPTS && !stopping) {
        // flood limit: wait as long as Telegram asks (bounded) and try the SAME recipient again
        const wait = flood ? Math.min(Number(err.parameters?.retry_after) || 1, maxFloodWaitSec) * 1000 + 100 : attempt * 1000;
        await sleepFn(wait);
        continue;
      }
      if (flood) return { stop: 'Telegram ограничил частоту отправки (429). Продолжите рассылку позже — она начнётся с того же получателя.' };
      if (transient) return { stop: `Telegram недоступен: ${description}. Продолжите рассылку позже — она начнётся с того же получателя.` };
      // 400 / 401 / 404 …: the request itself is wrong, so it is wrong for everybody
      return { stop: `Telegram отклонил сообщение: ${description}` };
    }
  }
}

/**
 * Send a broadcast to every user the bot can write to (~20 messages/second). A draft starts from
 * the first recipient; a stopped or interrupted one continues after the last recipient it processed.
 * Resolves with the updated row when the send finished, stopped ('failed') or was interrupted by
 * shutdown (still 'sending'); safe to run without awaiting — progress is saved after every recipient.
 * @param {number} id
 * @param {{ delayMs?: number, maxFloodWaitSec?: number, sleepFn?: (ms: number) => Promise<void> }} [options]
 * @throws AppError 'not_found' | 'bot_disabled' | 'bad_state' (already sent / being sent right now)
 */
export async function sendBroadcast(id, { delayMs = 50, maxFloodWaitSec = MAX_FLOOD_WAIT_SEC, sleepFn = sleep } = {}) {
  const b = getBroadcast(id);
  if (!b) throw new AppError('not_found', 'Рассылка не найдена', 404);
  if (!tg.isConfigured()) throw new AppError('bot_disabled', 'Бот не настроен: укажите BOT_TOKEN', 409);
  if (active.has(b.id)) throw new AppError('bad_state', 'Эта рассылка уже отправляется', 409);
  if (!canSend(b)) throw new AppError('bad_state', 'Эта рассылка уже отправлялась', 409);

  active.add(b.id);
  try {
    const fresh = b.status === 'draft';
    let sent = fresh ? 0 : b.sent;
    let failed = fresh ? 0 : b.failed;
    let cursor = fresh ? 0 : b.cursor;
    const save = () => run('UPDATE broadcasts SET sent = ?, failed = ?, cursor = ? WHERE id = ?', sent, failed, cursor, b.id);
    run(`UPDATE broadcasts SET status = 'sending', total = ?, sent = ?, failed = ?, cursor = ?, error = '', finished_at = NULL WHERE id = ?`,
      sent + failed + countBroadcastAudience(cursor), sent, failed, cursor, b.id);
    const extra = b.button_text && /^https:\/\//.test(b.button_url)
      ? { reply_markup: { inline_keyboard: [[{ text: b.button_text, url: b.button_url }]] } }
      : {};

    for (;;) {
      const page = broadcastAudience(cursor, PAGE);
      if (!page.length) break;
      for (const user of page) {
        // shutdown: leave the row 'sending' with its cursor — the next boot continues from here
        if (stopping) return getBroadcast(b.id);
        const outcome = await deliver(b, user, extra, { sleepFn, maxFloodWaitSec });
        if (typeof outcome === 'object') {
          if (stopping) return getBroadcast(b.id);
          run(`UPDATE broadcasts SET status = 'failed', error = ?, sent = ?, failed = ?, cursor = ?, finished_at = ? WHERE id = ?`,
            String(outcome.stop).slice(0, 500), sent, failed, cursor, now(), b.id);
          return getBroadcast(b.id);
        }
        if (outcome === 'sent') sent += 1;
        else failed += 1;
        cursor = user.id;
        save();
        if (delayMs) await sleepFn(delayMs);
      }
    }
    run(`UPDATE broadcasts SET status = 'done', sent = ?, failed = ?, cursor = ?, finished_at = ? WHERE id = ?`, sent, failed, cursor, now(), b.id);
    return getBroadcast(b.id);
  } finally {
    active.delete(b.id);
  }
}

/**
 * Continue the broadcasts that a previous process left in 'sending' (restart, deploy, crash).
 * Called once at boot; runs in the background.
 * @returns {number[]} ids that are being resumed
 */
export function resumeInterrupted(options = {}) {
  if (!tg.isConfigured()) return [];
  const rows = all(`SELECT id, sent, failed, total FROM broadcasts WHERE status = 'sending' ORDER BY id`).filter((b) => !active.has(b.id));
  for (const b of rows) {
    console.log(`[broadcast] #${b.id} was interrupted (${b.sent + b.failed} of ${b.total} processed) — continuing`);
    sendBroadcast(b.id, options).catch((err) => console.error(`[broadcast] #${b.id} could not be resumed:`, err?.message || err));
  }
  return rows.map((b) => b.id);
}

/**
 * Graceful shutdown: ask the running sends to stop after the current recipient and wait for them.
 * Their rows stay 'sending' with the cursor saved, so resumeInterrupted() picks them up at the next boot.
 */
export async function stopSending({ timeoutMs = 3000 } = {}) {
  stopping = true;
  const deadline = Date.now() + timeoutMs;
  while (active.size && Date.now() < deadline) await sleep(25);
  return active.size === 0;
}

/** Test hook: allow sending again after stopSending(). */
export function resetSending() {
  stopping = false;
}
