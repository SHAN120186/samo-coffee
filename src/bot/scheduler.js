// Subscription housekeeping for Telegram users. One pass ("tick") every hour:
//   1. subscriptions whose paid period ended are marked expired (subscriptions.expireDue)
//   2. customers with a Telegram account are reminded REMIND_DAYS days before the period ends
//   3. customers whose subscription has just expired are told so (once)
//
// Safe on restart and on overlapping runs: what was already sent is remembered per user in
// tg_users.state_data (memo), keyed by subscription id + period end, so a renewed subscription gets
// a new reminder for its new period and nobody gets the same reminder twice.
// Messages are sent only in the daytime of the business timezone.
import { config } from '../config.js';
import * as tg from '../lib/telegramApi.js';
import * as subscriptions from '../services/subscriptions.js';
import * as tgUsers from '../services/tgUsers.js';
import { formatSum } from '../lib/money.js';
import { sendToMany } from './api.js';
import { getMemo, patchMemo } from './state.js';
import * as texts from './texts.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const REMIND_DAYS = 3;
/** Do not write about an expiry that happened long ago (bot was off, user unblocked us later…). */
const EXPIRED_NOTICE_WINDOW = 3 * DAY;
const QUIET_BEFORE_HOUR = 9;
const QUIET_FROM_HOUR = 21;
const SCAN_LIMIT = 10_000;

let interval = null;
let firstRun = null;
let running = false;

/** Local hour (0–23) in the business timezone. */
const localHour = (ms) => new Date(ms + config.tzOffsetMinutes * 60_000).getUTCHours();
export const isQuietTime = (ms) => {
  const hour = localHour(ms);
  return hour < QUIET_BEFORE_HOUR || hour >= QUIET_FROM_HOUR;
};

/** Send a scheduled message; resolves true when delivered, false when the user can no longer be reached. */
async function deliver(userId, html, replyMarkup) {
  try {
    await tg.sendMessage(userId, html, replyMarkup ? { reply_markup: replyMarkup } : {});
    return true;
  } catch (err) {
    if (err.isBlocked) {
      tgUsers.markTgBlocked(userId, true);
      return false;
    }
    throw err; // flood limit / network: sendToMany waits when needed; the reminder is retried on the next tick
  }
}

/** Telegram users we may write to: known to the bot, not blocked, not a made-up user of the demo seed. */
const reachable = (userId) => tgUsers.isReachable(userId);

/**
 * Remember that a notice about this subscription period was sent. The marks of the user's OTHER
 * subscriptions are kept (the memo patch replaces the whole map, so it is merged here); marks of
 * periods that ended long ago are dropped.
 */
function remember(userId, key, sub, now) {
  const marks = Object.entries(getMemo(userId)[key] || {})
    .filter(([, end]) => now - Date.parse(end) <= EXPIRED_NOTICE_WINDOW + DAY);
  patchMemo(userId, { [key]: { ...Object.fromEntries(marks), [sub.id]: sub.current_period_end } });
}

/**
 * One housekeeping pass.
 * @param {{ now?: number, force?: boolean }} [options] force — ignore the quiet hours (tests, manual runs)
 * @returns {Promise<{ expired: number, reminded: number, expiredNotified: number, skipped?: 'busy'|'quiet'|'disabled' }>}
 */
export async function tick({ now = Date.now(), force = false } = {}) {
  const result = { expired: 0, reminded: 0, expiredNotified: 0 };
  if (running) return { ...result, skipped: 'busy' };
  running = true;
  try {
    result.expired = subscriptions.expireDue();
    if (!tg.isConfigured()) return { ...result, skipped: 'disabled' };
    if (!force && isQuietTime(now)) return { ...result, skipped: 'quiet' };

    // ── reminders: the paid period ends within REMIND_DAYS days
    const ending = subscriptions.listSubscriptions({ status: 'active', limit: SCAN_LIMIT }).items.filter((s) => {
      const end = Date.parse(s.current_period_end);
      return s.customer_tg_user_id && end > now && end - now <= REMIND_DAYS * DAY;
    });
    const reminders = await sendToMany(ending, async (sub) => {
      const userId = sub.customer_tg_user_id;
      if (!reachable(userId)) return false;
      if (getMemo(userId).subReminded?.[sub.id] === sub.current_period_end) return false;
      const delivered = await deliver(userId, texts.subscriptionExpiring(sub), {
        inline_keyboard: [
          [{ text: `🔁 Продлить на ${texts.periodLabel(sub.plan_period_days)} · ${formatSum(sub.plan_price)}`, callback_data: 'renew!' }],
          [{ text: 'Моя подписка', callback_data: 'subscription!' }],
        ],
      });
      // remembered even when the user blocked the bot: there is nobody to remind
      remember(userId, 'subReminded', sub, now);
      return delivered;
    });
    result.reminded = reminders.sent;

    // ── the subscription has just expired
    const lapsed = subscriptions.listSubscriptions({ status: 'expired', limit: SCAN_LIMIT }).items.filter((s) => {
      const end = Date.parse(s.current_period_end);
      return s.customer_tg_user_id && end <= now && now - end <= EXPIRED_NOTICE_WINDOW;
    });
    const notices = await sendToMany(lapsed, async (sub) => {
      const userId = sub.customer_tg_user_id;
      if (!reachable(userId)) return false;
      if (getMemo(userId).subExpired?.[sub.id] === sub.current_period_end) return false;
      if (subscriptions.getCurrentForTgUser(userId)) {
        // the customer already has another subscription — nothing to announce
        remember(userId, 'subExpired', sub, now);
        return false;
      }
      const delivered = await deliver(userId, texts.subscriptionExpired(sub), {
        inline_keyboard: [
          [{ text: `🔁 Оформить заново · ${formatSum(sub.plan_price)}`, callback_data: `sub:${sub.plan_id}!` }],
          [{ text: 'Все планы', callback_data: 'plans!' }],
        ],
      });
      remember(userId, 'subExpired', sub, now);
      return delivered;
    });
    result.expiredNotified = notices.sent;
    return result;
  } finally {
    running = false;
  }
}

/** Start the hourly pass. The first one runs shortly after boot, so a restart never skips a day. */
export function startScheduler({ intervalMs = HOUR, initialDelayMs = 45_000 } = {}) {
  if (interval) return;
  const run = () => tick().catch((err) => console.error('[bot] scheduler pass failed:', err?.message || err));
  firstRun = setTimeout(run, initialDelayMs);
  firstRun.unref();
  interval = setInterval(run, intervalMs);
  interval.unref();
}

export function stopScheduler() {
  clearTimeout(firstRun);
  clearInterval(interval);
  firstRun = null;
  interval = null;
}
