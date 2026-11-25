// Express application factory: security middleware, static files, parsers, shared locals,
// and the mounting of every module router. See docs/ARCHITECTURE.md for the request pipeline.
import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';

import { config } from './config.js';
import { csrfProtection } from './lib/csrf.js';
import { flashMiddleware } from './lib/flash.js';
import { formatSum, formatNumber, formatCompact, discountPercent } from './lib/money.js';
import { escapeHtml, nl2br, jsonForScript, stripTags, truncate, plural } from './lib/escape.js';
import * as dates from './lib/dates.js';
import * as settings from './services/settings.js';
import * as content from './services/content.js';
import * as analytics from './services/analytics.js';
import * as auth from './services/auth.js';

import siteRouter, { siteErrorHandler } from './site/routes.js';
import adminRouter from './admin/routes.js';
import tmaApiRouter from './tma/api.js';
import paymentsRouter, { paymentsErrorHandler } from './payments/routes.js';
import { startBot } from './bot/index.js';

/** Paths that are NOT protected by the CSRF middleware (token/signature-authenticated endpoints). */
export const CSRF_IGNORE = [/^\/api\//, /^\/pay\/payme(\/|$)/, /^\/pay\/click(\/|$)/, /^\/pay\/telegram(\/|$)/, /^\/bot\//];
/** Token/signature-authenticated paths that never receive cookies. */
export const COOKIELESS = ['/api', '/bot', '/pay/payme', '/pay/click', '/pay/telegram', '/healthz'];
/** Paths whose HTML responses are not counted as site page views. */
export const PAGEVIEW_EXCLUDE = ['/admin', '/api', '/pay', '/tma', '/bot', '/healthz'];

function securityHeaders() {
  const nonce = (req, res) => `'nonce-${res.locals.cspNonce}'`;
  const common = {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    objectSrc: ["'none'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
    fontSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"],
    mediaSrc: ["'self'", 'https:'],
    frameSrc: ["'self'", 'https://yandex.uz', 'https://yandex.ru', 'https://www.google.com'],
    // form-action also restricts redirects that follow a form submission (checkout → provider page)
    formAction: ["'self'", 'https://checkout.paycom.uz', 'https://checkout.test.paycom.uz', 'https://test.paycom.uz', 'https://my.click.uz', 'https://t.me'],
    ...(config.isHttps ? { upgradeInsecureRequests: [] } : {}),
  };
  const shared = {
    hsts: config.isProd && config.isHttps ? { maxAge: 15552000, includeSubDomains: false } : false,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  };
  const standard = helmet({
    ...shared,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { ...common, scriptSrc: ["'self'", nonce], frameAncestors: ["'none'"] },
    },
  });
  // Mini App: may load the official Telegram script and be embedded by Telegram Web clients.
  const tma = helmet({
    ...shared,
    frameguard: false,
    crossOriginOpenerPolicy: false,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        ...common,
        scriptSrc: ["'self'", nonce, 'https://telegram.org'],
        frameAncestors: ["'self'", 'https://web.telegram.org', 'https://*.telegram.org'],
      },
    },
  });
  return (req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    return (req.path === '/tma' || req.path.startsWith('/tma/') ? tma : standard)(req, res, next);
  };
}

function mountStatic(app) {
  const nm = (...p) => path.join(config.rootDir, 'node_modules', ...p);
  const opts = { maxAge: config.isProd ? '7d' : 0, index: false, redirect: false, fallthrough: true };
  const immutable = { ...opts, maxAge: config.isProd ? '30d' : 0 };
  app.use('/vendor/chart.js', express.static(nm('chart.js', 'dist'), immutable));
  app.use('/vendor/quill', express.static(nm('quill', 'dist'), immutable));
  app.use('/fonts/playfair-display', express.static(nm('@fontsource', 'playfair-display', 'files'), immutable));
  app.use('/fonts/manrope', express.static(nm('@fontsource', 'manrope', 'files'), immutable));
  app.use('/uploads', express.static(config.uploads.dir, { ...opts, dotfiles: 'ignore' }));
  // Mini App static bundle (index.html must never be cached: it boots the SPA)
  app.use('/tma', express.static(path.join(config.publicDir, 'tma'), {
    maxAge: config.isProd ? '1h' : 0,
    setHeaders: (res, file) => {
      if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
    },
  }));
  // Everything else in /public (css, img, site/, admin/). No directory redirects, so /admin reaches its router.
  app.use(express.static(config.publicDir, opts));
}

/** Template helpers available in every EJS view (res.locals). */
function viewLocals() {
  const helpers = {
    formatSum, formatNumber, formatCompact, discountPercent,
    escapeHtml, nl2br, jsonForScript, stripTags, truncate, plural,
    ...dates,
  };
  const publicConfig = {
    baseUrl: config.baseUrl,
    isProd: config.isProd,
    botUsername: config.bot.username,
    botUrl: config.bot.username ? `https://t.me/${config.bot.username}` : '',
    tmaUrl: config.tma.url,
    tmaDevAuth: config.tma.devAuth,
  };
  return (req, res, next) => {
    Object.assign(res.locals, helpers);
    res.locals.appConfig = publicConfig;
    res.locals.settings = settings.getAll();
    res.locals.g = content.getPage('global');
    res.locals.currentPath = req.path;
    res.locals.canonicalUrl = `${config.baseUrl}${req.path === '/' ? '' : req.path}`;
    res.locals.query = req.query;
    next();
  };
}

function wantsJson(req) {
  return req.path.startsWith('/api/') || req.xhr || req.accepts(['html', 'json']) === 'json';
}

function errorPage(res, status, title, message) {
  const h = escapeHtml;
  res.status(status).type('html').send(`<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${h(title)}</title><link rel="icon" href="/img/favicon.svg"><link rel="stylesheet" href="/css/tokens.css"></head>
<body><main class="container" style="min-height:100vh;display:grid;place-items:center;text-align:center">
<div><p class="eyebrow">Ошибка ${status}</p><h1>${h(title)}</h1><p class="lead" style="margin-inline:auto">${h(message)}</p>
<p style="margin-top:2rem"><a class="btn btn--primary" href="/">На главную</a></p></div></main></body></html>`);
}

/**
 * Build the app.
 * @param {{ bot?: boolean }} [options] bot=false skips startBot() (tests)
 * @returns {Promise<import('express').Express>}
 */
export async function createApp({ bot = true } = {}) {
  auth.ensureDefaultAdmin();
  content.ensureDefaults();

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);
  app.set('view engine', 'ejs');
  // Views are addressed from src/: res.render('site/views/home'), res.render('admin/views/orders/list')
  app.set('views', path.join(config.rootDir, 'src'));
  if (config.isProd) app.set('view cache', true);

  app.get('/healthz', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

  app.use(securityHeaders());
  app.use(compression());
  mountStatic(app);

  app.use(cookieParser(config.sessionSecret));
  const keepRaw = (req, res, buf) => {
    req.rawBody = buf; // payment webhooks verify signatures against the raw body
  };
  app.use(express.json({ limit: '1mb', verify: keepRaw }));
  app.use(express.urlencoded({ extended: true, limit: '2mb', parameterLimit: 2000, verify: keepRaw }));

  app.use(analytics.sessionMiddleware({ noCookie: COOKIELESS }));
  app.use(flashMiddleware());
  app.use(viewLocals()); // before the CSRF check, so the error pages rendered for a failed check have their locals
  app.use(csrfProtection({ ignore: CSRF_IGNORE }));

  app.use('/admin', adminRouter);
  app.use('/api/tma', tmaApiRouter);
  app.use('/pay', paymentsRouter);

  // The bot may mount its webhook route on the app, so it starts before the site catch-all.
  app.locals.botStarted = false;
  if (bot) {
    try {
      await startBot(app);
      app.locals.botStarted = true;
    } catch (err) {
      console.error('[bot] failed to start:', err);
    }
  }

  app.use(analytics.pageViewMiddleware({ exclude: PAGEVIEW_EXCLUDE }));
  app.use('/', siteRouter); // ends with its own 404 page

  // Fallbacks (the site router normally answers first).
  app.use((req, res) => {
    if (wantsJson(req)) return res.status(404).json({ ok: false, error: 'not_found', message: 'Не найдено' });
    return errorPage(res, 404, 'Страница не найдена', 'Возможно, ссылка устарела.');
  });

  // Payment providers must be answered in their own protocol even when the request was rejected
  // before reaching the router (malformed body); everything else falls through to the handler below.
  app.use('/pay', paymentsErrorHandler);
  // Site pages get the branded error page also for errors raised before the site router (CSRF check, body parser).
  app.use(siteErrorHandler);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = Number(err.status || err.statusCode) || 500;
    const expose = Boolean(err.expose) || err.code === 'EBADCSRFTOKEN' || (status >= 400 && status < 500);
    if (status >= 500) console.error(`[error] ${req.method} ${req.originalUrl}`, err);
    if (res.headersSent) return next(err);
    const message = expose && err.message ? err.message : 'Что-то пошло не так. Мы уже разбираемся.';
    if (wantsJson(req)) {
      // internal failures never leak their own codes (e.g. database error names) to clients
      const code = status >= 500 && !expose ? 'internal' : (err.code || 'error');
      return res.status(status).json({ ok: false, error: code, message, ...(err.details && code !== 'internal' ? { details: err.details } : {}) });
    }
    return errorPage(res, status, status === 404 ? 'Страница не найдена' : status === 403 ? 'Доступ запрещён' : 'Упс, ошибка', message);
  });

  return app;
}

export default createApp;
