// The ONLY place that talks to the Telegram Bot API over HTTP (besides grammY, which the BOT
// module must configure with the same root: new Bot(token, { client: { apiRoot: config.bot.apiRoot } })).
// Honors TELEGRAM_API_ROOT so tests can point it at a local fake Bot API server.
import { config } from '../config.js';

export class TelegramError extends Error {
  constructor(method, code, description, parameters) {
    super(`Telegram ${method} failed: ${code} ${description}`);
    this.name = 'TelegramError';
    this.method = method;
    this.code = code;
    this.description = description;
    this.parameters = parameters;
  }
  /** The user blocked the bot / chat does not exist — stop messaging this chat. */
  get isBlocked() {
    return this.code === 403 || /chat not found|user is deactivated/i.test(this.description || '');
  }
}

/** True when BOT_TOKEN is set. */
export function isConfigured() {
  return Boolean(config.bot.token);
}

/**
 * Call a Bot API method. Resolves with `result`; rejects with TelegramError.
 * @param {string} method e.g. "sendMessage"
 * @param {object} [params] JSON-serializable parameters
 * @param {{ token?: string, timeoutMs?: number }} [options]
 */
export async function call(method, params = {}, { token = config.bot.token, timeoutMs = 10_000 } = {}) {
  if (!token) throw new TelegramError(method, 0, 'bot is not configured (BOT_TOKEN is empty)');
  let response;
  try {
    response = await fetch(`${config.bot.apiRoot}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new TelegramError(method, -1, `network error: ${err.message}`);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new TelegramError(method, response.status, 'invalid JSON in Bot API response');
  }
  if (!data || data.ok !== true) {
    throw new TelegramError(method, data?.error_code ?? response.status, data?.description ?? 'unknown error', data?.parameters);
  }
  return data.result;
}

/**
 * Like call(), but never throws: resolves with null when the bot is not configured or the call
 * fails (the error is logged). Use for best-effort notifications.
 */
export async function safeCall(method, params = {}, options = {}) {
  if (!isConfigured()) return null;
  try {
    return await call(method, params, options);
  } catch (err) {
    if (!config.isTest) console.warn(`[telegram] ${err.message}`);
    return null;
  }
}

/** sendMessage with HTML parse mode and link previews off. Throws like call(). */
export function sendMessage(chatId, text, extra = {}) {
  return call('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...extra,
  });
}

/** Best-effort sendMessage: resolves with the sent Message or null. */
export function trySendMessage(chatId, text, extra = {}) {
  if (!chatId) return Promise.resolve(null);
  return safeCall('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...extra,
  });
}

/**
 * Create a Telegram Payments invoice link (used by the "telegram" payment provider and the Mini App).
 * `prices` amounts are in the smallest currency units (tiyin for UZS).
 */
export function createInvoiceLink({ title, description, payload, providerToken, currency = 'UZS', prices, ...rest }) {
  return call('createInvoiceLink', {
    title: String(title).slice(0, 32),
    description: String(description).slice(0, 255),
    payload,
    provider_token: providerToken,
    currency,
    prices,
    ...rest,
  });
}

export default { call, safeCall, sendMessage, trySendMessage, createInvoiceLink, isConfigured, TelegramError };
