// Shared helpers of the admin panel: navigation model, pagination, form helpers, badges, CSV.
import { AppError } from '../lib/errors.js';
import { clean } from '../lib/escape.js';

/** Render a view of this module: view('orders/index') → 'admin/views/orders/index'. */
export const view = (name) => `admin/views/${name}`;

/** Wrap an async route handler so rejections reach the error middleware (Express 4). */
export const wrap = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res, next);
    if (out && typeof out.catch === 'function') out.catch(next);
  } catch (err) {
    next(err);
  }
};

/** Sidebar structure. `roles` limits an item to the listed admin roles. */
export const NAV = [
  {
    title: 'Обзор',
    items: [{ id: 'dashboard', title: 'Дашборд', href: '/admin', icon: 'chart' }],
  },
  {
    title: 'Продажи',
    items: [
      { id: 'orders', title: 'Заказы', href: '/admin/orders', icon: 'bag', count: 'orders' },
      { id: 'subscriptions', title: 'Подписки', href: '/admin/subscriptions', icon: 'repeat' },
      { id: 'customers', title: 'Клиенты', href: '/admin/customers', icon: 'users' },
    ],
  },
  {
    title: 'Каталог',
    items: [
      { id: 'products', title: 'Товары', href: '/admin/products', icon: 'box' },
      { id: 'categories', title: 'Категории', href: '/admin/categories', icon: 'folder' },
      { id: 'plans', title: 'Планы подписки', href: '/admin/plans', icon: 'calendar' },
    ],
  },
  {
    title: 'Контент',
    items: [
      { id: 'content', title: 'Страницы', href: '/admin/content', icon: 'layout' },
      { id: 'posts', title: 'Блог', href: '/admin/posts', icon: 'pen' },
      { id: 'faq', title: 'Вопросы и ответы', href: '/admin/faq', icon: 'help' },
      { id: 'media', title: 'Медиатека', href: '/admin/media', icon: 'image' },
    ],
  },
  {
    title: 'Коммуникации',
    items: [
      { id: 'feedback', title: 'Обращения', href: '/admin/feedback', icon: 'chat', count: 'feedback' },
      { id: 'broadcasts', title: 'Рассылки', href: '/admin/broadcasts', icon: 'send', roles: ['owner', 'admin'] },
    ],
  },
  {
    title: 'Система',
    items: [
      { id: 'settings', title: 'Настройки', href: '/admin/settings', icon: 'settings', roles: ['owner', 'admin'] },
      { id: 'admins', title: 'Администраторы', href: '/admin/admins', icon: 'shield', roles: ['owner'] },
    ],
  },
];

/** Navigation visible to an admin role. */
export function navFor(role) {
  return NAV
    .map((group) => ({ ...group, items: group.items.filter((i) => !i.roles || i.roles.includes(role)) }))
    .filter((group) => group.items.length);
}

// ─────────────────────────────── badges

const BADGES = {
  order: { new: 'info', pending_payment: 'warning', paid: 'success', processing: 'accent', shipped: 'accent', delivered: 'dark', cancelled: 'muted', refunded: 'danger' },
  payment: { unpaid: 'muted', pending: 'warning', paid: 'success', failed: 'danger', refunded: 'danger', created: 'muted', cancelled: 'muted' },
  feedback: { open: 'warning', answered: 'success', closed: 'muted' },
  subscription: { active: 'success', paused: 'warning', cancelled: 'muted', expired: 'danger' },
  channel: { site: 'muted', tma: 'info', bot: 'accent', admin: 'dark' },
  broadcast: { draft: 'muted', sending: 'warning', done: 'success', failed: 'danger' },
};

/** CSS modifier for a status badge: badgeClass('order', 'paid') → 'badge badge--success'. */
export function badgeClass(kind, value) {
  const tone = BADGES[kind]?.[value] || 'muted';
  return tone === 'muted' ? 'badge' : `badge badge--${tone}`;
}

// ─────────────────────────────── request helpers

/** Positive integer route/query param or null. */
export function intParam(value) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 && String(n) === String(value).trim() ? n : null;
}

/** Checkbox / flag coming from a form (handles the hidden "0" + checkbox "1" pattern). */
export function flag(value) {
  const v = Array.isArray(value) ? value[value.length - 1] : value;
  return v === true || v === 1 || v === '1' || v === 'on' || v === 'true' ? 1 : 0;
}

/** Always an array of trimmed non-empty strings (form fields named `x[]`). */
export function list(value, max = 50) {
  const arr = Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value];
  return arr.map((v) => clean(v, 2000)).filter(Boolean).slice(0, max);
}

/** Build a query string from an object, skipping empty values. Returns '' or '?a=b'. */
export function qs(params = {}) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}

/**
 * Pagination model for list pages.
 * @returns {{ page, perPage, offset, total, pages, from, to, link(n): string }}
 */
export function paginate(req, total, perPage = 25, basePath = null) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(pages, Math.max(1, Number.parseInt(req.query.page, 10) || 1));
  const base = basePath || `${req.baseUrl}${req.path}`;
  const rest = { ...req.query };
  delete rest.page;
  return {
    page, perPage, total, pages,
    offset: (page - 1) * perPage,
    from: total ? (page - 1) * perPage + 1 : 0,
    to: Math.min(total, page * perPage),
    link: (n) => `${base}${qs({ ...flatQuery(rest), ...(n > 1 ? { page: n } : {}) })}`,
  };
}

/** Requested page offset before the total is known (list services need limit/offset first). */
export function pageOffset(req, perPage = 25) {
  return (Math.max(1, Number.parseInt(req.query.page, 10) || 1) - 1) * perPage;
}

/** Keep only plain string query values (drops arrays/objects injected through `a[b]=c`). */
export function flatQuery(query = {}) {
  const out = {};
  for (const [k, v] of Object.entries(query)) if (typeof v === 'string') out[k] = v;
  return out;
}

/** True for errors that should be shown next to a form instead of an error page. */
export const isUserError = (err) => err instanceof AppError && err.status >= 400 && err.status < 500;

/** Local redirect target taken from a form field / Referer; only paths inside /admin are accepted. */
export function backUrl(req, fallback = '/admin') {
  const candidates = [req.body?._back, req.query?._back, req.get('referer')];
  for (const c of candidates) {
    if (!c) continue;
    let path = String(c);
    if (/^https?:\/\//i.test(path)) {
      try {
        const u = new URL(path);
        if (u.host !== req.get('host')) continue;
        path = `${u.pathname}${u.search}`;
      } catch {
        continue;
      }
    }
    if (/^\/admin(\/|\?|$)/.test(path) && !path.includes('//') && !/[\r\n\\]/.test(path)) return path;
  }
  return fallback;
}

// ─────────────────────────────── CSV

/** One CSV cell: quoted, with formula-injection protection for spreadsheet apps. */
export function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+([.,]\d+)?$/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** CSV document for Excel (UTF-8 BOM, ";" separator, CRLF). */
export function toCsv(header, rows) {
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(';'));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** Human file size: 12 КБ, 1,4 МБ. */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}

/** "admin:3" → "Администратор (Имя)"; used in the order history. */
export function actorLabel(actor, adminsById = new Map()) {
  const a = String(actor || 'system');
  if (a === 'system') return 'Система';
  if (a === 'customer') return 'Клиент';
  if (a.startsWith('admin:')) {
    const admin = adminsById.get(Number(a.slice(6)));
    return admin ? (admin.name || admin.email) : 'Администратор';
  }
  if (a.startsWith('provider:')) {
    const names = { mock: 'Демо-оплата', telegram: 'Telegram Payments', payme: 'Payme', click: 'Click', manual: 'Вручную' };
    return names[a.slice(9)] || a.slice(9);
  }
  return a;
}

export const PROVIDER_LABELS = { mock: 'Демо-оплата', telegram: 'Telegram Payments', payme: 'Payme', click: 'Click', manual: 'Вручную' };
