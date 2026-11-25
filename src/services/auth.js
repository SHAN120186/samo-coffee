// Admin authentication: scrypt password hashes, DB-backed sessions, signed HttpOnly cookie.
import crypto from 'node:crypto';
import { all, get, run, now } from '../db/index.js';
import { config } from '../config.js';
import { AppError, notFound } from '../lib/errors.js';
import { RateLimiter } from '../lib/ratelimit.js';

export const ADMIN_COOKIE = 'sc_admin';
export const ADMIN_ROLES = { owner: 'Владелец', admin: 'Администратор', manager: 'Менеджер' };
export const MIN_PASSWORD_LENGTH = 8;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/** scrypt hash in the form "scrypt$N$r$p$<salt b64url>$<hash b64url>". */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

/** Constant-time password check against a stored hash. */
export function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  let actual;
  try {
    actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64url'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const publicAdmin = (row) => (row ? { id: row.id, email: row.email, name: row.name, role: row.role, role_label: ADMIN_ROLES[row.role] || row.role, active: row.active, created_at: row.created_at, last_login_at: row.last_login_at } : null);

/** Login attempts: 8 per 15 minutes per IP+e-mail. Use loginLimiter.hit(key) / .reset(key). */
export const loginLimiter = new RateLimiter({ windowMs: 15 * 60 * 1000, max: 8 });
/**
 * Failed logins per ACCOUNT from any address: 20 per 15 minutes. A client can change (or, behind a
 * misconfigured proxy, forge) its IP address, but not the account it is guessing the password of.
 * A browser that has logged into that account before (signed DEVICE_COOKIE) is exempt, so the
 * owner cannot be locked out of the panel by somebody who hammers the login form.
 */
export const accountLoginLimiter = new RateLimiter({ windowMs: 15 * 60 * 1000, max: 20 });
/** Signed cookie that remembers the account this browser has successfully logged into. */
export const DEVICE_COOKIE = 'sc_admin_dev';
// A dummy hash keeps the timing equal for unknown e-mails.
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));

/** Create the first admin from ADMIN_EMAIL / ADMIN_PASSWORD when the table is empty. */
export function ensureDefaultAdmin() {
  if (get('SELECT COUNT(*) AS n FROM admins').n > 0) return null;
  if (!config.admin.password) {
    console.warn('[auth] no admins exist and ADMIN_PASSWORD is empty — set it and restart to create the first admin');
    return null;
  }
  const { lastInsertRowid } = run('INSERT INTO admins (email, name, password_hash, role) VALUES (?, ?, ?, ?)',
    config.admin.email, 'Администратор', hashPassword(config.admin.password), 'owner');
  return getAdmin(Number(lastInsertRowid));
}

/**
 * Check credentials (rate limited) and open a session.
 * @param {string} email @param {string} password
 * @param {{ ip?: string, userAgent?: string, knownAccount?: string }} [o] knownAccount — value of the
 *   signed DEVICE_COOKIE (the e-mail this browser logged in with before)
 * @returns {{ ok: true, admin: object, token: string } | { ok: false, reason: 'rate_limited'|'invalid', retryAfterSec?: number }}
 */
export function login(email, password, { ip = '', userAgent = '', knownAccount = '' } = {}) {
  const account = String(email || '').trim().toLowerCase().slice(0, 100);
  const key = `${ip}|${account}`;
  const peek = loginLimiter.peek(key);
  if (!peek.allowed) return { ok: false, reason: 'rate_limited', retryAfterSec: peek.retryAfterSec };
  const trustedDevice = Boolean(account) && String(knownAccount || '').toLowerCase() === account;
  const accountPeek = accountLoginLimiter.peek(account);
  if (!accountPeek.allowed && !trustedDevice) return { ok: false, reason: 'rate_limited', retryAfterSec: accountPeek.retryAfterSec };

  const row = get('SELECT * FROM admins WHERE email = ? AND active = 1', account);
  const valid = verifyPassword(password, row ? row.password_hash : DUMMY_HASH) && Boolean(row);
  if (!valid) {
    loginLimiter.hit(key);
    accountLoginLimiter.hit(account);
    return { ok: false, reason: 'invalid' };
  }
  loginLimiter.reset(key);
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.admin.sessionDays * 86400000).toISOString();
  run('INSERT INTO admin_sessions (id, admin_id, ip, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)',
    sha256(token), row.id, String(ip).slice(0, 64), String(userAgent).slice(0, 255), expires);
  run('UPDATE admins SET last_login_at = ? WHERE id = ?', now(), row.id);
  run('DELETE FROM admin_sessions WHERE expires_at < ?', now());
  return { ok: true, admin: publicAdmin(row), token };
}

/** Admin for a session token, or null (unknown / expired / deactivated). */
export function getSessionAdmin(token) {
  if (!token || typeof token !== 'string') return null;
  const row = get(
    `SELECT a.* FROM admin_sessions s JOIN admins a ON a.id = s.admin_id WHERE s.id = ? AND s.expires_at > ? AND a.active = 1`,
    sha256(token), now());
  return publicAdmin(row);
}

export function logout(token) {
  if (token) run('DELETE FROM admin_sessions WHERE id = ?', sha256(String(token)));
}

/** Close all sessions of an admin (optionally keep the current one). */
export function logoutAll(adminId, exceptToken = null) {
  if (exceptToken) run('DELETE FROM admin_sessions WHERE admin_id = ? AND id <> ?', Number(adminId), sha256(exceptToken));
  else run('DELETE FROM admin_sessions WHERE admin_id = ?', Number(adminId));
}

const cookieOptions = () => ({ httpOnly: true, signed: true, sameSite: 'lax', secure: config.isHttps, path: '/' });

export function setSessionCookie(res, token) {
  res.cookie(ADMIN_COOKIE, token, { ...cookieOptions(), maxAge: config.admin.sessionDays * 86400000 });
}

export function clearSessionCookie(res) {
  res.clearCookie(ADMIN_COOKIE, cookieOptions());
}

/** Remember that this browser has logged into `email` (see accountLoginLimiter). Not a credential. */
export function setDeviceCookie(res, email) {
  res.cookie(DEVICE_COOKIE, String(email || '').toLowerCase(), { ...cookieOptions(), path: '/admin', maxAge: 365 * 86400000 });
}

/** Middleware: sets req.admin and res.locals.admin (null when not logged in). */
export function loadAdmin(req, res, next) {
  req.adminToken = req.signedCookies?.[ADMIN_COOKIE] || null;
  req.admin = getSessionAdmin(req.adminToken);
  res.locals.admin = req.admin;
  next();
}

/** Middleware: requires a logged-in admin. HTML → redirect to /admin/login?next=…, JSON/XHR → 401. */
export function requireAdmin(req, res, next) {
  if (req.admin === undefined) loadAdmin(req, res, () => {});
  if (req.admin) {
    res.set('Cache-Control', 'no-store');
    return next();
  }
  if (req.xhr || req.accepts(['html', 'json']) === 'json') {
    return res.status(401).json({ ok: false, error: 'unauthorized', message: 'Требуется вход в админ-панель' });
  }
  const nextUrl = req.method === 'GET' ? `?next=${encodeURIComponent(req.originalUrl)}` : '';
  return res.redirect(`/admin/login${nextUrl}`);
}

/** Middleware factory: allow only the listed roles, e.g. requireRole('owner', 'admin'). */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (req.admin && roles.includes(req.admin.role)) return next();
    const err = new AppError('forbidden', 'Недостаточно прав для этого действия', 403);
    return next(err);
  };
}

/** Sanitize a post-login redirect target: only local /admin paths are allowed. */
export function safeNext(target) {
  const t = String(target || '');
  return /^\/admin(\/[\w\-./?=&%]*)?$/.test(t) && !t.includes('//') ? t : '/admin';
}

// ─────────────────────────────── admin users

export function listAdmins() {
  return all('SELECT * FROM admins ORDER BY id').map(publicAdmin);
}

export function getAdmin(id) {
  return publicAdmin(get('SELECT * FROM admins WHERE id = ?', Number(id)));
}

function checkPassword(password) {
  if (String(password || '').length < MIN_PASSWORD_LENGTH) {
    throw new AppError('validation', `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов`, 422);
  }
}

/** data: { email*, password*, name, role } */
export function createAdmin(data) {
  const email = String(data.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new AppError('validation', 'Укажите корректный e-mail', 422);
  checkPassword(data.password);
  if (get('SELECT 1 AS x FROM admins WHERE email = ?', email)) throw new AppError('validation', 'Администратор с таким e-mail уже есть', 422);
  const role = ADMIN_ROLES[data.role] ? data.role : 'admin';
  const { lastInsertRowid } = run('INSERT INTO admins (email, name, password_hash, role) VALUES (?, ?, ?, ?)',
    email, String(data.name || '').trim().slice(0, 120), hashPassword(data.password), role);
  return getAdmin(Number(lastInsertRowid));
}

/** data: { name, email, role, active } — partial. The last active owner cannot be demoted or deactivated. */
export function updateAdmin(id, data) {
  const row = get('SELECT * FROM admins WHERE id = ?', Number(id));
  if (!row) throw notFound('Администратор');
  const email = data.email !== undefined ? String(data.email).trim().toLowerCase() : row.email;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new AppError('validation', 'Укажите корректный e-mail', 422);
  if (get('SELECT 1 AS x FROM admins WHERE email = ? AND id <> ?', email, row.id)) throw new AppError('validation', 'Этот e-mail уже занят', 422);
  const role = data.role !== undefined && ADMIN_ROLES[data.role] ? data.role : row.role;
  const active = data.active === undefined ? row.active : (data.active === true || data.active === 1 || data.active === '1' || data.active === 'on' ? 1 : 0);
  if (row.role === 'owner' && row.active && (role !== 'owner' || !active)) {
    const owners = get(`SELECT COUNT(*) AS n FROM admins WHERE role = 'owner' AND active = 1`).n;
    if (owners <= 1) throw new AppError('validation', 'Нельзя снять права с единственного владельца', 422);
  }
  run('UPDATE admins SET email = ?, name = ?, role = ?, active = ? WHERE id = ?',
    email, data.name !== undefined ? String(data.name).trim().slice(0, 120) : row.name, role, active, row.id);
  if (!active) logoutAll(row.id);
  return getAdmin(row.id);
}

/** Change own password: verifies the current one, then closes the admin's other sessions. */
export function changePassword(adminId, currentPassword, newPassword, { keepToken = null } = {}) {
  const row = get('SELECT * FROM admins WHERE id = ?', Number(adminId));
  if (!row) throw notFound('Администратор');
  if (!verifyPassword(currentPassword, row.password_hash)) throw new AppError('validation', 'Текущий пароль указан неверно', 422);
  checkPassword(newPassword);
  run('UPDATE admins SET password_hash = ? WHERE id = ?', hashPassword(newPassword), row.id);
  logoutAll(row.id, keepToken);
  return true;
}

/** Set a password without knowing the old one (owner resets another admin). */
export function setPassword(adminId, newPassword) {
  checkPassword(newPassword);
  if (!run('UPDATE admins SET password_hash = ? WHERE id = ?', hashPassword(newPassword), Number(adminId)).changes) throw notFound('Администратор');
  logoutAll(adminId);
  return true;
}

/** Delete an admin (not the last owner). */
export function deleteAdmin(id) {
  const row = get('SELECT * FROM admins WHERE id = ?', Number(id));
  if (!row) return false;
  if (row.role === 'owner' && get(`SELECT COUNT(*) AS n FROM admins WHERE role = 'owner' AND active = 1`).n <= 1) {
    throw new AppError('validation', 'Нельзя удалить единственного владельца', 422);
  }
  run('DELETE FROM admins WHERE id = ?', row.id);
  return true;
}
