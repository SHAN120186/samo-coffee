// CSRF protection: signed double-submit token.
//  * a random secret lives in the signed HttpOnly cookie "sc_csrf"
//  * the token rendered into forms is "<salt>.<HMAC(secret, salt)>"
//  * unsafe requests must send it as body field `_csrf`, query `?_csrf=` or header `X-CSRF-Token`
// app.js installs csrfProtection() globally (API/webhook prefixes are excluded), so module
// routers only have to render <%- csrfField %> inside every <form method="post">.
import crypto from 'node:crypto';
import { config } from '../config.js';

export const CSRF_COOKIE = 'sc_csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const sign = (secret, salt) =>
  crypto.createHmac('sha256', `${config.sessionSecret}:${secret}`).update(salt).digest('base64url');

/** Create a token for a secret. */
export function createToken(secret) {
  const salt = crypto.randomBytes(9).toString('base64url');
  return `${salt}.${sign(secret, salt)}`;
}

/** Constant-time token check. */
export function verifyToken(secret, token) {
  if (!secret || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const salt = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(secret, salt));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export function newSecret() {
  return crypto.randomBytes(18).toString('base64url');
}

/** Token sent with the request (body field, query string or header). */
export function tokenFromRequest(req) {
  return (
    (req.body && typeof req.body === 'object' && req.body._csrf) ||
    (req.query && req.query._csrf) ||
    req.get('x-csrf-token') ||
    ''
  );
}

/**
 * Express middleware. Requires cookie-parser (with secret) and body parsers to run before it.
 * Sets req.csrfToken(), res.locals.csrfToken and res.locals.csrfField (ready-made hidden input).
 * options.ignore: array of RegExp / string prefixes tested against req.path — those requests are
 * not verified (webhooks, token-authenticated APIs).
 *
 * multipart/form-data: the body is not parsed yet when this middleware runs, so put the token into
 * the form action — action="/admin/media?_csrf=<%= csrfToken %>" — or send the X-CSRF-Token header.
 */
export function csrfProtection({ ignore = [] } = {}) {
  const isIgnored = (p) => ignore.some((rule) => (rule instanceof RegExp ? rule.test(p) : p.startsWith(rule)));
  return function csrf(req, res, next) {
    const ignored = isIgnored(req.path);
    let secret = req.signedCookies?.[CSRF_COOKIE];
    // Token-authenticated endpoints (API, webhooks) stay cookie-free.
    if (!secret && !ignored) {
      secret = newSecret();
      res.cookie(CSRF_COOKIE, secret, {
        httpOnly: true,
        signed: true,
        sameSite: 'lax',
        secure: config.isHttps,
        path: '/',
        maxAge: 30 * 24 * 3600 * 1000,
      });
    }
    let cached;
    req.csrfToken = () => (secret ? (cached ??= createToken(secret)) : '');
    Object.defineProperty(res.locals, 'csrfToken', { get: () => req.csrfToken(), enumerable: true, configurable: true });
    Object.defineProperty(res.locals, 'csrfField', {
      get: () => `<input type="hidden" name="_csrf" value="${req.csrfToken()}">`,
      enumerable: true,
      configurable: true,
    });

    if (SAFE_METHODS.has(req.method) || ignored) return next();
    if (verifyToken(req.signedCookies?.[CSRF_COOKIE], tokenFromRequest(req))) return next();

    const err = new Error('Сессия формы устарела. Обновите страницу и попробуйте ещё раз.');
    err.status = 403;
    err.code = 'EBADCSRFTOKEN';
    return next(err);
  };
}
