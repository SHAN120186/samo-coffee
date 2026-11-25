// Helpers for the Mini App API tests. Import AFTER ./helpers/env-telegram.js (config is read on import).
import { signInitData } from '../src/lib/initData.js';
import { BOT_TOKEN } from './helpers/env-telegram.js';

let seq = 0;

/** A fresh Telegram user (unique id per call, so rate limits and carts never collide between tests). */
export function tgUser(overrides = {}) {
  seq += 1;
  return { id: 810000000 + seq * 7 + (process.pid % 1000) * 1000, first_name: 'Камила', last_name: 'Юсупова', username: `kamila_${seq}`, language_code: 'ru', ...overrides };
}

/** Raw initData signed like Telegram does it. */
export function initDataFor(user, fields = {}, token = BOT_TOKEN) {
  return signInitData({ user, ...fields }, token);
}

/**
 * Minimal JSON client of /api/tma for one Telegram user.
 * call(method, path, body) → { status, body, headers }
 */
export function tmaClient(baseUrl, user, { initData } = {}) {
  const raw = initData === undefined ? (user ? initDataFor(user) : '') : initData;
  async function call(method, path, body) {
    const res = await fetch(`${baseUrl}/api/tma${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(raw ? { authorization: `tma ${raw}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch { /* not JSON */ }
    return { status: res.status, body: json, text, headers: res.headers };
  }
  return {
    user,
    get: (path) => call('GET', path),
    post: (path, body = {}) => call('POST', path, body),
    put: (path, body = {}) => call('PUT', path, body),
    del: (path) => call('DELETE', path),
  };
}

export const CHECKOUT = {
  customer: { name: 'Камила Юсупова', phone: '+998 90 123 45 67' },
  delivery: { method: 'courier', address: 'Ташкент, ул. Афросиаб, 14' },
  comment: 'Помол под воронку',
};
