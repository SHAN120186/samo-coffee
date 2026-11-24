// Telegram WebApp initData validation (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
//   secret_key = HMAC_SHA256(key = "WebAppData", message = bot_token)
//   hash       = hex(HMAC_SHA256(key = secret_key, message = data_check_string))
// data_check_string = all fields except `hash`, sorted by key, "key=value" joined with "\n".
import crypto from 'node:crypto';
import { config } from '../config.js';

const secretKey = (botToken) => crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();

function dataCheckString(params) {
  return [...params.entries()]
    .filter(([k]) => k !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

/**
 * Validate a raw initData string.
 * @param {string} initData raw query string from Telegram.WebApp.initData
 * @param {string} botToken
 * @param {{ maxAgeSeconds?: number, now?: number }} [options] maxAgeSeconds=0 disables the freshness check
 * @returns {{ ok: true, user: object|null, data: object } | { ok: false, reason: 'empty'|'no_token'|'no_hash'|'bad_hash'|'no_auth_date'|'expired'|'bad_user' }}
 */
export function validateInitData(initData, botToken, { maxAgeSeconds = config.tma.initDataMaxAge, now = Date.now() } = {}) {
  if (!initData || typeof initData !== 'string') return { ok: false, reason: 'empty' };
  if (!botToken) return { ok: false, reason: 'no_token' };
  if (initData.length > 8192) return { ok: false, reason: 'bad_hash' };

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return { ok: false, reason: 'no_hash' };

  const expected = crypto.createHmac('sha256', secretKey(botToken)).update(dataCheckString(params)).digest();
  const given = Buffer.from(hash, 'hex');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad_hash' };
  }

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || authDate <= 0) return { ok: false, reason: 'no_auth_date' };
  if (maxAgeSeconds > 0) {
    const age = Math.floor(now / 1000) - authDate;
    if (age > maxAgeSeconds || age < -300) return { ok: false, reason: 'expired' };
  }

  let user = null;
  if (params.has('user')) {
    try {
      user = JSON.parse(params.get('user'));
    } catch {
      return { ok: false, reason: 'bad_user' };
    }
    if (!user || !Number.isSafeInteger(user.id)) return { ok: false, reason: 'bad_user' };
  }

  const data = Object.fromEntries(params.entries());
  delete data.hash;
  return { ok: true, user, data: { ...data, auth_date: authDate, start_param: params.get('start_param') || '' } };
}

/**
 * Build a correctly signed initData string (tests, dev tooling).
 * signInitData({ user: { id: 1, first_name: 'A' }, auth_date?: number, start_param?: string }, token)
 */
export function signInitData(fields, botToken) {
  const params = new URLSearchParams();
  const data = { auth_date: Math.floor(Date.now() / 1000), ...fields };
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    params.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  params.set('hash', crypto.createHmac('sha256', secretKey(botToken)).update(dataCheckString(params)).digest('hex'));
  return params.toString();
}

/** Demo user used by the browser "dev preview" of the Mini App (TMA_DEV_AUTH=1, non-production). */
export const DEV_TMA_USER = Object.freeze({
  id: 700000001,
  first_name: 'Демо',
  last_name: 'Гость',
  username: 'samo_demo',
  language_code: 'ru',
});

/**
 * Resolve the Mini App user of an HTTP request.
 * The client sends the raw initData in the header  `Authorization: tma <initData>`
 * (fallback: header `X-Telegram-Init-Data`).
 * Dev preview: when config.tma.devAuth is on and no initData is sent, DEV_TMA_USER is returned.
 * @returns {{ user: object, dev: boolean, startParam: string } | { user: null, reason: string }}
 */
export function resolveTmaUser(req) {
  const auth = req.get('authorization') || '';
  const raw = auth.toLowerCase().startsWith('tma ') ? auth.slice(4).trim() : req.get('x-telegram-init-data') || '';
  if (raw) {
    const result = validateInitData(raw, config.bot.token);
    if (result.ok && result.user) return { user: result.user, dev: false, startParam: result.data.start_param };
    if (!config.tma.devAuth) return { user: null, reason: result.ok ? 'no_user' : result.reason };
  }
  if (config.tma.devAuth) return { user: { ...DEV_TMA_USER }, dev: true, startParam: '' };
  return { user: null, reason: 'empty' };
}
