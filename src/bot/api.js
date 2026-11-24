// Bot API plumbing shared by every handler:
//   * default parse_mode "HTML" and disabled link previews (handlers always escape user text with escapeTg)
//   * flood control: a 429 answer is retried after `retry_after` (bounded)
//   * a 403 "bot was blocked by the user" on a private chat marks the tg user as blocked
import { GrammyError, HttpError } from 'grammy';
import { markTgBlocked } from '../services/tgUsers.js';

/** Methods whose text/caption is HTML unless the caller says otherwise. */
const HTML_METHODS = new Set([
  'sendMessage', 'editMessageText', 'sendPhoto', 'sendDocument', 'sendVideo', 'sendAnimation', 'sendAudio', 'sendVoice',
  'editMessageCaption', 'copyMessage',
]);
const PREVIEW_METHODS = new Set(['sendMessage', 'editMessageText']);

/** Longest pause (seconds) we are willing to sit out before retrying a flood-limited call. */
export const MAX_FLOOD_WAIT_SEC = 15;
const FLOOD_RETRIES = 2;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True for descriptions that mean "this private chat can no longer be written to". */
export function isBlockedDescription(code, description = '') {
  if (code === 403) return /blocked by the user|user is deactivated|bot can't initiate|bot was kicked/i.test(description);
  return code === 400 && /chat not found|user not found|PEER_ID_INVALID/i.test(description);
}

/** True when an error thrown by grammY or lib/telegramApi means the user blocked the bot. */
export function isBlockedError(err) {
  if (err instanceof GrammyError) return isBlockedDescription(err.error_code, err.description);
  if (err && typeof err.code === 'number' && typeof err.description === 'string') return isBlockedDescription(err.code, err.description);
  return false;
}

/** Network-level failure (Telegram unreachable) as opposed to an API error. */
export const isNetworkError = (err) => err instanceof HttpError;

const isPrivateChatId = (id) => Number.isSafeInteger(Number(id)) && Number(id) > 0;

/**
 * Install the transformers on an Api instance (bot.api). grammY copies them to the per-update
 * `ctx.api`, so they apply to every call the bot makes.
 * @param {import('grammy').Api} api
 * @param {{ sleepFn?: (ms: number) => Promise<void> }} [options] sleepFn is replaceable in tests
 */
export function installTransformers(api, { sleepFn = sleep } = {}) {
  api.config.use(async (prev, method, payload, signal) => {
    let p = payload;
    if (p && typeof p === 'object') {
      if (HTML_METHODS.has(method) && p.parse_mode === undefined) p = { ...p, parse_mode: 'HTML' };
      if (PREVIEW_METHODS.has(method) && p.link_preview_options === undefined) p = { ...p, link_preview_options: { is_disabled: true } };
    }
    let res = await prev(method, p, signal);
    for (let attempt = 0; attempt < FLOOD_RETRIES && !res.ok && res.error_code === 429; attempt += 1) {
      const wait = Number(res.parameters?.retry_after) || 1;
      if (wait > MAX_FLOOD_WAIT_SEC) break;
      await sleepFn(wait * 1000 + 100);
      res = await prev(method, p, signal);
    }
    if (!res.ok && p && isPrivateChatId(p.chat_id) && isBlockedDescription(res.error_code, res.description)) {
      try {
        markTgBlocked(Number(p.chat_id), true);
      } catch { /* the user may be unknown — nothing to mark */ }
    }
    return res;
  });
}

/**
 * Flood-safe fan-out: run `send(item)` for every item at ~`perSecond` messages per second
 * (Telegram allows about 30/s to different chats). Never throws; returns { sent, failed }.
 * Blocked users are marked by the transformer above (grammY) or by the caller (lib/telegramApi).
 * @template T
 * @param {T[]} items
 * @param {(item: T) => Promise<unknown>} send resolves truthy when delivered
 * @param {{ perSecond?: number, shouldStop?: () => boolean }} [options]
 */
export async function sendToMany(items, send, { perSecond = 20, shouldStop = () => false } = {}) {
  const gap = Math.max(0, Math.round(1000 / perSecond));
  let sent = 0;
  let failed = 0;
  for (const item of items) {
    if (shouldStop()) break;
    try {
      if (await send(item)) sent += 1;
      else failed += 1;
    } catch (err) {
      failed += 1;
      const retryAfter = Number(err?.parameters?.retry_after);
      if (retryAfter > 0 && retryAfter <= MAX_FLOOD_WAIT_SEC) await sleep(retryAfter * 1000);
    }
    if (gap) await sleep(gap);
  }
  return { sent, failed };
}
