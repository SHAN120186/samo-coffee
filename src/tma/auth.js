// Mini App authentication.
// The client sends the raw Telegram.WebApp.initData in `Authorization: tma <initData>`; it is validated
// with lib/initData.js (HMAC-SHA256 signed with the bot token + auth_date freshness). The API never
// reads cookies. Dev preview (TMA_DEV_AUTH=1, non-production only) authenticates a fixed demo user.
import { config } from '../config.js';
import { resolveTmaUser } from '../lib/initData.js';
import { clean } from '../lib/escape.js';
import * as tgUsers from '../services/tgUsers.js';
import * as customers from '../services/customers.js';

const REASON_MESSAGES = {
  expired: 'Сессия устарела. Закройте мини-приложение и откройте его заново.',
  bad_hash: 'Не удалось проверить подпись Telegram. Откройте приложение из бота ещё раз.',
  no_token: 'Мини-приложение ещё не подключено к боту. Попробуйте позже.',
  no_user: 'Telegram не передал данные пользователя. Откройте приложение из чата с ботом.',
};
const DEFAULT_MESSAGE = 'Откройте мини-приложение из Telegram-бота.';

/** Telegram users whose tg_users / customers rows were refreshed recently (id → timestamp). */
const touched = new Map();
const TOUCH_INTERVAL_MS = 60_000;
const TOUCH_MAX_ENTRIES = 5000;

/** Only the fields we store; everything is length-limited (the payload is signed, but still external). */
function normalizeUser(raw) {
  return {
    id: raw.id,
    first_name: clean(raw.first_name, 64),
    last_name: clean(raw.last_name, 64),
    username: /^[A-Za-z0-9_]{3,32}$/.test(String(raw.username || '')) ? String(raw.username) : '',
    language_code: clean(raw.language_code, 8),
  };
}

export function displayName(user) {
  return `${user.first_name || ''} ${user.last_name || ''}`.trim() || (user.username ? `@${user.username}` : '');
}

/** Register / refresh the Telegram user and make sure a customer row is linked to it. */
function touchUser(user, startParam) {
  const last = touched.get(user.id) || 0;
  if (Date.now() - last < TOUCH_INTERVAL_MS) return;
  if (touched.size >= TOUCH_MAX_ENTRIES) touched.clear();
  tgUsers.upsertTgUser(user, { startParam: clean(startParam, 64) || null, source: 'tma' });
  if (!customers.getCustomerByTgUserId(user.id)) {
    customers.upsertCustomer({ name: displayName(user), tgUserId: user.id, tgUsername: user.username || undefined, source: 'tma' });
  }
  touched.set(user.id, Date.now());
}

/** Public bot link for the "open in Telegram" hint of the 401 screen. */
export const botUrl = () => (config.bot.username ? `https://t.me/${config.bot.username}` : '');

/**
 * Express middleware: requires a valid Mini App user.
 * Sets req.tma = { user, dev, startParam, cartRef }.
 */
export function requireTmaUser(req, res, next) {
  const auth = resolveTmaUser(req);
  if (!auth.user) {
    return res.status(401).json({
      ok: false,
      error: 'unauthorized',
      message: REASON_MESSAGES[auth.reason] || DEFAULT_MESSAGE,
      details: { reason: auth.reason, botUrl: botUrl() },
    });
  }
  try {
    const user = normalizeUser(auth.user);
    touchUser(user, auth.startParam);
    req.tma = { user, dev: Boolean(auth.dev), startParam: auth.startParam || '', cartRef: { tgUserId: user.id } };
    return next();
  } catch (err) {
    return next(err);
  }
}

/** Test hook: forget the "recently refreshed" marks. */
export function resetTouchCache() {
  touched.clear();
}
