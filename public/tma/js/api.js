// JSON client of /api/tma. Auth: the raw Telegram initData in the Authorization header (no cookies).
import { tg } from './tg.js';

export class ApiError extends Error {
  constructor(code, message, status = 0, details = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
  /** Per-field messages of a validation error: { name: '…', phone: '…' } */
  get fields() {
    return (this.details && this.details.fields) || {};
  }
}

const TIMEOUT_MS = 20000;

/**
 * @param {string} path e.g. "/cart/items"
 * @param {{ method?: string, body?: object, timeoutMs?: number }} [options]
 * @returns {Promise<object>} the response body (always has ok: true)
 * @throws {ApiError}
 */
export async function api(path, { method = 'GET', body, timeoutMs = TIMEOUT_MS } = {}) {
  const headers = { Accept: 'application/json' };
  if (tg.initData) headers.Authorization = `tma ${tg.initData}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`/api/tma${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (err) {
    throw new ApiError('network', 'Нет соединения. Проверьте интернет и попробуйте ещё раз.');
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try {
    data = await response.json();
  } catch { /* not JSON */ }

  if (!response.ok || !data || data.ok !== true) {
    const fallback = response.status === 429 ? 'Слишком много запросов. Подождите немного.' : 'Что-то пошло не так. Попробуйте ещё раз.';
    throw new ApiError((data && data.error) || `http_${response.status}`, (data && data.message) || fallback, response.status, data && data.details);
  }
  return data;
}

export const get = (path) => api(path);
export const post = (path, body = {}) => api(path, { method: 'POST', body });
export const put = (path, body = {}) => api(path, { method: 'PUT', body });
export const del = (path) => api(path, { method: 'DELETE' });
