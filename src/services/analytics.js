// First-party analytics: page views + events, and every aggregate the admin dashboard needs.
// No third-party scripts, no personal data: a random session cookie, path, referrer host, UTM, device class.
import crypto from 'node:crypto';
import { all, get, run, now } from '../db/index.js';
import { config } from '../config.js';

export const SESSION_COOKIE = 'sc_sid';
export const SOURCE_COOKIE = 'sc_src';

export const EVENT_NAMES = ['view_product', 'add_to_cart', 'begin_checkout', 'purchase', 'feedback', 'tma_open', 'bot_start', 'subscribe'];
export const EVENT_LABELS = {
  view_product: 'Просмотр товара',
  add_to_cart: 'Добавление в корзину',
  begin_checkout: 'Начало оформления',
  purchase: 'Покупка',
  feedback: 'Обращение',
  tma_open: 'Открытие мини-приложения',
  bot_start: 'Запуск бота',
  subscribe: 'Оформление подписки',
};
export const CHANNEL_LABELS = { site: 'Сайт', tma: 'Мини-приложение', bot: 'Бот', admin: 'Админ-панель' };
export const DEVICE_LABELS = { desktop: 'Компьютеры', mobile: 'Телефоны', tablet: 'Планшеты' };
export const MEDIUM_LABELS = { direct: 'Прямые заходы', organic: 'Поиск', social: 'Соцсети', referral: 'Ссылки с сайтов', cpc: 'Реклама', email: 'Рассылки' };

const BOT_UA = /bot|crawl|spider|slurp|preview|monitor|uptime|headless|lighthouse|pingdom|facebookexternalhit|whatsapp|telegrambot|curl|wget|python-requests|axios|node-fetch|go-http-client|scrapy|httpclient/i;
const SEARCH_HOSTS = /(^|\.)(google|yandex|ya|bing|duckduckgo|yahoo|mail)\./i;
const SOCIAL_HOSTS = /(^|\.)(instagram\.com|facebook\.com|fb\.com|t\.me|telegram\.org|telegram\.me|tiktok\.com|youtube\.com|youtu\.be|vk\.com|twitter\.com|x\.com|linkedin\.com)$/i;

/** True for crawlers / monitoring / CLI clients (their hits are not recorded). */
export function isBotUserAgent(ua) {
  return !ua || BOT_UA.test(ua);
}

/** 'mobile' | 'tablet' | 'desktop' from a User-Agent string. */
export function detectDevice(ua = '') {
  if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/i.test(ua)) return 'tablet';
  if (/mobi|iphone|ipod|android.*mobile|windows phone|blackberry|opera mini/i.test(ua)) return 'mobile';
  return 'desktop';
}

/**
 * Classify traffic from UTM params and the referrer.
 * @returns {{ source: string, medium: string, campaign: string } | null} null = internal navigation / unknown
 */
export function classifyTraffic({ utmSource, utmMedium, utmCampaign, referrer, ownHost }) {
  const cut = (s, n = 60) => String(s || '').toLowerCase().replace(/[^a-z0-9а-яё._-]/gi, '').slice(0, n);
  if (utmSource) {
    return { source: cut(utmSource) || 'utm', medium: cut(utmMedium, 30) || 'referral', campaign: cut(utmCampaign, 80) };
  }
  let host = '';
  try {
    host = referrer ? new URL(referrer).hostname.replace(/^www\./, '').toLowerCase() : '';
  } catch { /* malformed referrer */ }
  if (!host || host === ownHost) return null;
  if (SEARCH_HOSTS.test(host)) {
    const name = /yandex|(^|\.)ya\./.test(host) ? 'yandex' : host.split('.').slice(-2, -1)[0] || host;
    return { source: name, medium: 'organic', campaign: '' };
  }
  if (SOCIAL_HOSTS.test(host)) {
    const name = /t\.me|telegram/.test(host) ? 'telegram' : host.split('.').slice(-2, -1)[0];
    return { source: name, medium: 'social', campaign: '' };
  }
  return { source: host.slice(0, 60), medium: 'referral', campaign: '' };
}

const ownHost = (() => {
  try {
    return new URL(config.baseUrl).hostname.replace(/^www\./, '');
  } catch {
    return 'localhost';
  }
})();

/**
 * Middleware (installed globally by app.js): assigns the analytics session.
 * options.noCookie: path prefixes / RegExps that must stay cookie-free (API, webhooks).
 * Sets req.sessionId (string), req.device, req.isBot and req.traffic ({source, medium, campaign} —
 * first-touch attribution kept for 30 days in a cookie).
 */
export function sessionMiddleware({ noCookie = [] } = {}) {
  const cookieless = (p) => noCookie.some((rule) => (rule instanceof RegExp ? rule.test(p) : p === rule || p.startsWith(`${rule}/`)));
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: config.isHttps, path: '/', maxAge: 30 * 24 * 3600 * 1000 };
  return function analyticsSession(req, res, next) {
    const ua = req.get('user-agent') || '';
    req.isBot = isBotUserAgent(ua);
    req.device = detectDevice(ua);
    // API / webhook paths never receive analytics cookies (req.sessionId is then per-request).
    const setCookies = !req.isBot && !cookieless(req.path);

    let sid = req.cookies?.[SESSION_COOKIE];
    if (!sid || !/^[A-Za-z0-9_-]{16,40}$/.test(sid)) {
      sid = crypto.randomBytes(15).toString('base64url');
      if (setCookies) res.cookie(SESSION_COOKIE, sid, cookieOptions);
    }
    req.sessionId = sid;

    let stored = null;
    try {
      const raw = req.cookies?.[SOURCE_COOKIE];
      if (raw) {
        const [source, medium, campaign = ''] = String(raw).split('|');
        if (source && medium) stored = { source: source.slice(0, 60), medium: medium.slice(0, 30), campaign: campaign.slice(0, 80) };
      }
    } catch { /* ignore */ }

    const q = req.query || {};
    const fresh = req.method === 'GET'
      ? classifyTraffic({ utmSource: q.utm_source, utmMedium: q.utm_medium, utmCampaign: q.utm_campaign, referrer: req.get('referer'), ownHost: req.hostname || ownHost })
      : null;
    if (fresh && setCookies) {
      res.cookie(SOURCE_COOKIE, `${fresh.source}|${fresh.medium}|${fresh.campaign}`, cookieOptions);
    }
    req.traffic = fresh || stored || { source: 'direct', medium: 'direct', campaign: '' };
    next();
  };
}

/**
 * Path as stored in page_views: no trailing slash; per-order pages are collapsed
 * ("/order/<token>" → "/order/*") so tokens never end up in reports.
 */
export function normalizePath(p) {
  const clean = p.length > 1 ? p.replace(/\/+$/, '') : '/';
  return clean.replace(/^\/order\/[^/]+$/, '/order/*').slice(0, 300) || '/';
}

/** Insert one page view row (used by the middleware and by tests/seeds). */
export function recordPageView({ sessionId, path, referrer = '', source = 'direct', medium = 'direct', campaign = '', device = 'desktop', at = null }) {
  run(
    `INSERT INTO page_views (session_id, path, referrer, source, medium, utm_campaign, device, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    String(sessionId), String(path).slice(0, 300), String(referrer).slice(0, 300), source, medium, campaign,
    ['desktop', 'mobile', 'tablet'].includes(device) ? device : 'desktop', at || now(),
  );
}

/**
 * Middleware: records a page view after a successful HTML GET response.
 * app.js mounts it for public site pages only (admin, API, payment and Mini App paths are excluded).
 * Requires sessionMiddleware() earlier in the chain.
 */
export function pageViewMiddleware({ exclude = [] } = {}) {
  const skip = (p) => exclude.some((rule) => (rule instanceof RegExp ? rule.test(p) : p === rule || p.startsWith(`${rule}/`)));
  return function trackPageView(req, res, next) {
    if (!config.analytics.enabled || req.method !== 'GET' || req.isBot || skip(req.path) || /\.[a-z0-9]{2,5}$/i.test(req.path)) return next();
    res.on('finish', () => {
      try {
        // only pages that were actually shown: redirects (cart → checkout, trailing slash) are not views
        if (res.statusCode < 200 || res.statusCode >= 300) return;
        if (!String(res.getHeader('content-type') || '').includes('text/html')) return;
        recordPageView({
          sessionId: req.sessionId,
          path: normalizePath(req.path),
          referrer: req.get('referer') || '',
          source: req.traffic?.source,
          medium: req.traffic?.medium,
          campaign: req.traffic?.campaign,
          device: req.device,
        });
      } catch (err) {
        console.error('[analytics] page view failed:', err.message);
      }
    });
    next();
  };
}

/**
 * Record an event. Never throws.
 * @param {string} name one of EVENT_NAMES (free-form names are allowed too)
 * @param {{ channel?: 'site'|'tma'|'bot'|'admin', sessionId?: string, tgUserId?: number, productId?: number, orderId?: number, value?: number, meta?: object, at?: string }} [data]
 *   For Telegram channels without a cookie session pass tgUserId — the session becomes "tg:<id>".
 */
/**
 * Delete raw page views older than `days` (config.analytics.retentionDays by default).
 * Orders, events and aggregates are untouched. Returns the number of deleted rows.
 */
export function pruneOldPageViews(days = config.analytics.retentionDays) {
  if (!days || days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  return Number(run('DELETE FROM page_views WHERE created_at < ?', cutoff).changes || 0);
}

export function trackEvent(name, data = {}) {
  if (!config.analytics.enabled) return;
  try {
    const sessionId = data.sessionId || (data.tgUserId ? `tg:${data.tgUserId}` : null);
    run(
      `INSERT INTO events (name, channel, session_id, tg_user_id, product_id, order_id, value, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      String(name).slice(0, 40), ['site', 'tma', 'bot', 'admin'].includes(data.channel) ? data.channel : 'site',
      sessionId, data.tgUserId ?? null, data.productId ?? null, data.orderId ?? null,
      Math.round(Number(data.value) || 0), JSON.stringify(data.meta ?? {}), data.at || now(),
    );
  } catch (err) {
    console.error('[analytics] event failed:', err.message);
  }
}

/** trackEvent for a site request: fills sessionId from req and skips crawlers. */
export function trackEventFromReq(req, name, data = {}) {
  if (req.isBot) return;
  trackEvent(name, { channel: 'site', sessionId: req.sessionId, ...data });
}

// ─────────────────────────────── date ranges

const DAY = 86400000;
const offsetMs = () => config.tzOffsetMinutes * 60000;
const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
/** Local (business timezone) date "YYYY-MM-DD" of a timestamp. */
export const localDate = (ts = Date.now()) => fmtDate(new Date(new Date(ts).getTime() + offsetMs()));
const parseDay = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? Date.parse(`${s}T00:00:00Z`) : null);
/** SQL expression giving the local date of a timestamp column. */
const dayExpr = (col = 'created_at') => `date(${col}, '${config.tzOffsetMinutes >= 0 ? '+' : ''}${config.tzOffsetMinutes} minutes')`;

export const RANGE_PRESETS = { today: 'Сегодня', '7d': '7 дней', '30d': '30 дней', '90d': '90 дней' };

/**
 * Build a range object from query params: { from, to } ("YYYY-MM-DD", inclusive, local days) or { range: 'today'|'7d'|'30d'|'90d' }.
 * Default: last 30 days. Max span: 366 days.
 * @returns {{ from, to, preset, start, end, days: string[], prev: { from, to, start, end } }}
 *   start/end are UTC ISO bounds (end exclusive); prev is the preceding period of equal length.
 */
export function resolveRange(query = {}) {
  const todayMs = parseDay(localDate());
  let preset = RANGE_PRESETS[query.range] ? query.range : null;
  let fromMs = parseDay(query.from);
  let toMs = parseDay(query.to);
  if (fromMs === null || toMs === null || preset) {
    preset = preset || '30d';
    const n = preset === 'today' ? 1 : Number.parseInt(preset, 10);
    toMs = todayMs;
    fromMs = todayMs - (n - 1) * DAY;
  }
  if (fromMs > toMs) [fromMs, toMs] = [toMs, fromMs];
  if (toMs - fromMs > 366 * DAY) fromMs = toMs - 366 * DAY;
  const count = Math.round((toMs - fromMs) / DAY) + 1;
  const days = Array.from({ length: count }, (_, i) => fmtDate(new Date(fromMs + i * DAY)));
  const bounds = (a, b) => ({
    from: fmtDate(new Date(a)),
    to: fmtDate(new Date(b)),
    start: new Date(a - offsetMs()).toISOString(),
    end: new Date(b + DAY - offsetMs()).toISOString(),
  });
  return { ...bounds(fromMs, toMs), preset, days, prev: bounds(fromMs - count * DAY, fromMs - DAY) };
}

// ─────────────────────────────── aggregates

function totals(r) {
  const pv = get('SELECT COUNT(*) AS views, COUNT(DISTINCT session_id) AS visitors FROM page_views WHERE created_at >= ? AND created_at < ?', r.start, r.end);
  const ord = get(
    `SELECT COUNT(*) AS orders,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END), 0) AS paid,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total ELSE 0 END), 0) AS revenue,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' AND channel = 'site' THEN 1 ELSE 0 END), 0) AS site_paid
       FROM orders WHERE created_at >= ? AND created_at < ?`, r.start, r.end);
  const ev = (name) => get('SELECT COUNT(*) AS n FROM events WHERE name = ? AND created_at >= ? AND created_at < ?', name, r.start, r.end).n;
  return {
    visitors: pv.visitors,
    pageViews: pv.views,
    orders: ord.orders,
    paidOrders: ord.paid,
    revenue: ord.revenue,
    avgCheck: ord.paid ? Math.round(ord.revenue / ord.paid) : 0,
    /** site paid orders / site visitors, percent with one decimal */
    conversion: pv.visitors ? Math.round((ord.site_paid / pv.visitors) * 1000) / 10 : 0,
    newCustomers: get('SELECT COUNT(*) AS n FROM customers WHERE created_at >= ? AND created_at < ?', r.start, r.end).n,
    feedback: get('SELECT COUNT(*) AS n FROM feedback_threads WHERE created_at >= ? AND created_at < ?', r.start, r.end).n,
    botStarts: ev('bot_start'),
    tmaOpens: ev('tma_open'),
    newSubscriptions: get('SELECT COUNT(*) AS n FROM subscriptions WHERE created_at >= ? AND created_at < ?', r.start, r.end).n,
  };
}

/**
 * KPI summary for a range, with the previous period and percentage deltas.
 * @returns {{ visitors, pageViews, orders, paidOrders, revenue, avgCheck, conversion, newCustomers, feedback,
 *            botStarts, tmaOpens, newSubscriptions, activeSubscriptions,
 *            prev: {...same metrics}, delta: { metric: percentChange|null } }}
 */
export function summary(range) {
  const cur = totals(range);
  const prev = totals(range.prev);
  const delta = {};
  for (const key of Object.keys(cur)) {
    delta[key] = prev[key] ? Math.round(((cur[key] - prev[key]) / prev[key]) * 1000) / 10 : null;
  }
  const activeSubscriptions = get("SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active'").n;
  return { ...cur, activeSubscriptions, prev, delta };
}

/** Per-day series (one entry for every day of the range): [{ date, visitors, pageViews, orders, paidOrders, revenue }] */
export function timeseries(range) {
  const pv = new Map(all(
    `SELECT ${dayExpr()} AS d, COUNT(*) AS views, COUNT(DISTINCT session_id) AS visitors
       FROM page_views WHERE created_at >= ? AND created_at < ? GROUP BY d`, range.start, range.end).map((r) => [r.d, r]));
  const ord = new Map(all(
    `SELECT ${dayExpr()} AS d, COUNT(*) AS orders,
            SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END) AS paid,
            SUM(CASE WHEN payment_status = 'paid' THEN total ELSE 0 END) AS revenue
       FROM orders WHERE created_at >= ? AND created_at < ? GROUP BY d`, range.start, range.end).map((r) => [r.d, r]));
  return range.days.map((date) => ({
    date,
    visitors: pv.get(date)?.visitors || 0,
    pageViews: pv.get(date)?.views || 0,
    orders: ord.get(date)?.orders || 0,
    paidOrders: ord.get(date)?.paid || 0,
    revenue: ord.get(date)?.revenue || 0,
  }));
}

/**
 * Conversion funnel (distinct sessions per step).
 * channel 'site' (default): visit → view_product → add_to_cart → begin_checkout → purchase
 * channel 'tma': tma_open → view_product → add_to_cart → begin_checkout → purchase
 * @returns {Array<{ key, label, count, rate (percent of first step), step_rate (percent of previous step) }>}
 */
export function funnel(range, { channel = 'site' } = {}) {
  const ch = channel === 'tma' ? 'tma' : 'site';
  const evCount = (name) => get(
    'SELECT COUNT(DISTINCT session_id) AS n FROM events WHERE name = ? AND channel = ? AND created_at >= ? AND created_at < ?',
    name, ch, range.start, range.end).n;
  const first = ch === 'site'
    ? { key: 'visit', label: 'Посетили сайт', count: get('SELECT COUNT(DISTINCT session_id) AS n FROM page_views WHERE created_at >= ? AND created_at < ?', range.start, range.end).n }
    : { key: 'tma_open', label: 'Открыли мини-приложение', count: evCount('tma_open') };
  const steps = [
    first,
    { key: 'view_product', label: 'Посмотрели товар', count: evCount('view_product') },
    { key: 'add_to_cart', label: 'Добавили в корзину', count: evCount('add_to_cart') },
    { key: 'begin_checkout', label: 'Начали оформление', count: evCount('begin_checkout') },
    { key: 'purchase', label: 'Оплатили заказ', count: evCount('purchase') },
  ];
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  return steps.map((s, i) => ({ ...s, rate: pct(s.count, steps[0].count), step_rate: i ? pct(s.count, steps[i - 1].count) : 100 }));
}

/** Most viewed pages: [{ path, views, visitors }] */
export function topPages(range, limit = 10) {
  return all(
    `SELECT path, COUNT(*) AS views, COUNT(DISTINCT session_id) AS visitors FROM page_views
      WHERE created_at >= ? AND created_at < ? GROUP BY path ORDER BY views DESC LIMIT ?`, range.start, range.end, Number(limit));
}

/** Best sellers by revenue of paid orders: [{ product_id, title, image, qty, revenue, views }] */
export function topProducts(range, limit = 10) {
  return all(
    `SELECT oi.product_id, oi.title, MAX(oi.image) AS image, SUM(oi.qty) AS qty, SUM(oi.total) AS revenue,
            (SELECT COUNT(*) FROM events e WHERE e.name = 'view_product' AND e.product_id = oi.product_id
               AND e.created_at >= ? AND e.created_at < ?) AS views
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.payment_status = 'paid' AND o.created_at >= ? AND o.created_at < ? AND oi.product_id IS NOT NULL
      GROUP BY oi.product_id ORDER BY revenue DESC LIMIT ?`,
    range.start, range.end, range.start, range.end, Number(limit));
}

/** Traffic sources: [{ source, medium, visitors, views, share (percent of visitors) }] */
export function sources(range, limit = 10) {
  const rows = all(
    `SELECT source, medium, COUNT(DISTINCT session_id) AS visitors, COUNT(*) AS views FROM page_views
      WHERE created_at >= ? AND created_at < ? GROUP BY source, medium ORDER BY visitors DESC LIMIT ?`, range.start, range.end, Number(limit));
  const total = rows.reduce((s, r) => s + r.visitors, 0);
  return rows.map((r) => ({ ...r, share: total ? Math.round((r.visitors / total) * 1000) / 10 : 0 }));
}

/** Traffic grouped by medium: [{ medium, label, visitors, share }] */
export function mediums(range) {
  const rows = all(
    `SELECT medium, COUNT(DISTINCT session_id) AS visitors FROM page_views
      WHERE created_at >= ? AND created_at < ? GROUP BY medium ORDER BY visitors DESC`, range.start, range.end);
  const total = rows.reduce((s, r) => s + r.visitors, 0);
  return rows.map((r) => ({ ...r, label: MEDIUM_LABELS[r.medium] || r.medium, share: total ? Math.round((r.visitors / total) * 1000) / 10 : 0 }));
}

/** UTM campaigns: [{ campaign, source, visitors, views }] */
export function campaigns(range, limit = 10) {
  return all(
    `SELECT utm_campaign AS campaign, source, COUNT(DISTINCT session_id) AS visitors, COUNT(*) AS views FROM page_views
      WHERE created_at >= ? AND created_at < ? AND utm_campaign <> '' GROUP BY utm_campaign, source ORDER BY visitors DESC LIMIT ?`,
    range.start, range.end, Number(limit));
}

/** Devices: [{ device, label, visitors, share }] */
export function devices(range) {
  const rows = all(
    `SELECT device, COUNT(DISTINCT session_id) AS visitors FROM page_views
      WHERE created_at >= ? AND created_at < ? GROUP BY device ORDER BY visitors DESC`, range.start, range.end);
  const total = rows.reduce((s, r) => s + r.visitors, 0);
  return rows.map((r) => ({ ...r, label: DEVICE_LABELS[r.device] || r.device, share: total ? Math.round((r.visitors / total) * 1000) / 10 : 0 }));
}

/** Orders by sales channel: [{ channel, label, orders, paidOrders, revenue }] */
export function channels(range) {
  return all(
    `SELECT channel, COUNT(*) AS orders,
            SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END) AS paidOrders,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total ELSE 0 END), 0) AS revenue
       FROM orders WHERE created_at >= ? AND created_at < ? GROUP BY channel ORDER BY revenue DESC`, range.start, range.end)
    .map((r) => ({ ...r, label: CHANNEL_LABELS[r.channel] || r.channel }));
}

/**
 * Telegram audience block.
 * @returns {{ totalUsers, activeUsers, blockedUsers, newUsers, botStarts, tmaOpens, tmaUsers, tmaOrders, tmaRevenue,
 *            series: Array<{ date, botStarts, tmaOpens, newUsers }> }}
 */
export function telegram(range) {
  const users = get('SELECT COUNT(*) AS total, COALESCE(SUM(is_blocked), 0) AS blocked FROM tg_users');
  const evRows = all(
    `SELECT ${dayExpr()} AS d, name, COUNT(*) AS n FROM events
      WHERE name IN ('bot_start', 'tma_open') AND created_at >= ? AND created_at < ? GROUP BY d, name`, range.start, range.end);
  const newRows = new Map(all(
    `SELECT ${dayExpr()} AS d, COUNT(*) AS n FROM tg_users WHERE created_at >= ? AND created_at < ? GROUP BY d`, range.start, range.end).map((r) => [r.d, r.n]));
  const byDay = new Map();
  for (const r of evRows) {
    if (!byDay.has(r.d)) byDay.set(r.d, {});
    byDay.get(r.d)[r.name] = r.n;
  }
  const series = range.days.map((date) => ({
    date, botStarts: byDay.get(date)?.bot_start || 0, tmaOpens: byDay.get(date)?.tma_open || 0, newUsers: newRows.get(date) || 0,
  }));
  const tma = get(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total ELSE 0 END), 0) AS revenue
       FROM orders WHERE channel IN ('tma', 'bot') AND created_at >= ? AND created_at < ?`, range.start, range.end);
  return {
    totalUsers: users.total,
    blockedUsers: users.blocked,
    activeUsers: users.total - users.blocked,
    newUsers: series.reduce((s, r) => s + r.newUsers, 0),
    botStarts: series.reduce((s, r) => s + r.botStarts, 0),
    tmaOpens: series.reduce((s, r) => s + r.tmaOpens, 0),
    tmaUsers: get("SELECT COUNT(DISTINCT tg_user_id) AS n FROM events WHERE name = 'tma_open' AND created_at >= ? AND created_at < ?", range.start, range.end).n,
    tmaOrders: tma.orders,
    tmaRevenue: tma.revenue,
    series,
  };
}

/** Everything the dashboard shows, in one call. */
export function dashboard(range) {
  return {
    range,
    summary: summary(range),
    timeseries: timeseries(range),
    funnel: funnel(range),
    topPages: topPages(range, 8),
    topProducts: topProducts(range, 8),
    sources: sources(range, 8),
    mediums: mediums(range),
    campaigns: campaigns(range, 6),
    devices: devices(range),
    channels: channels(range),
    telegram: telegram(range),
  };
}
