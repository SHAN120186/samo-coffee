// Flash messages stored in a short-lived signed cookie (no server-side session needed).
// Usage in a route:  req.flash('success', 'Сохранено');  res.redirect('/admin/products');
// Usage in a view:   <% flash.forEach(f => { %> <div class="alert alert--<%= f.type %>"><%= f.message %></div> <% }) %>
import { config } from '../config.js';

export const FLASH_COOKIE = 'sc_flash';
const TYPES = new Set(['success', 'error', 'info', 'warning']);

export function flashMiddleware() {
  return function flash(req, res, next) {
    let incoming = [];
    const raw = req.signedCookies?.[FLASH_COOKIE];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) incoming = parsed.filter((f) => f && TYPES.has(f.type)).slice(0, 5);
      } catch { /* ignore broken cookie */ }
    }
    const outgoing = [];
    const cookieOptions = { httpOnly: true, signed: true, sameSite: 'lax', secure: config.isHttps, path: '/' };

    /** Queue a message for the NEXT rendered page. */
    req.flash = (type, message) => {
      outgoing.push({ type: TYPES.has(type) ? type : 'info', message: String(message).slice(0, 400) });
      res.cookie(FLASH_COOKIE, JSON.stringify(outgoing), { ...cookieOptions, maxAge: 60_000 });
    };

    // Messages are consumed lazily: only a view that reads `flash` clears the cookie,
    // so redirects and JSON responses in between do not swallow them.
    let consumed = false;
    Object.defineProperty(res.locals, 'flash', {
      enumerable: true,
      configurable: true,
      get() {
        if (!consumed && incoming.length && !res.headersSent) {
          consumed = true;
          if (!outgoing.length) res.clearCookie(FLASH_COOKIE, cookieOptions);
        }
        return incoming;
      },
    });
    next();
  };
}
