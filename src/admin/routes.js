// ADMIN module router, mounted at /admin.
// Everything except /admin/login requires an admin session (auth.requireAdmin). CSRF protection,
// flash messages and the shared view helpers are installed globally by src/app.js.
// Views live in src/admin/views and are rendered as res.render('admin/views/<name>').
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { rateLimit } from '../lib/ratelimit.js';
import * as auth from '../services/auth.js';
import * as orders from '../services/orders.js';
import * as feedback from '../services/feedback.js';
import * as media from '../services/media.js';
import * as payments from '../payments/index.js';
import * as customersService from '../services/customers.js';
import { view, navFor, badgeClass, qs, isUserError, backUrl, formatBytes, PROVIDER_LABELS } from './lib.js';
import { icon } from './icons.js';

import dashboardRouter from './controllers/dashboard.js';
import contentRouter from './controllers/content.js';
import catalogRouter from './controllers/catalog.js';
import plansRouter from './controllers/plans.js';
import blogRouter from './controllers/blog.js';
import ordersRouter from './controllers/orders.js';
import customersRouter from './controllers/customers.js';
import feedbackRouter from './controllers/feedback.js';
import mediaRouter from './controllers/media.js';
import settingsRouter from './controllers/settings.js';
import broadcastsRouter from './controllers/broadcasts.js';
import accountRouter from './controllers/account.js';

const router = Router();

/** Cache-busting suffix for the panel's own assets (they are cached for days in production). */
const assetV = (() => {
  const files = ['css/tokens.css', 'admin/css/admin.css', 'admin/js/admin.js', 'admin/js/editor.js', 'admin/js/dashboard.js'];
  let latest = 0;
  for (const file of files) {
    try {
      latest = Math.max(latest, fs.statSync(path.join(config.publicDir, file)).mtimeMs);
    } catch { /* missing asset: keep going */ }
  }
  return Math.round(latest / 1000).toString(36);
})();

router.use((req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});
router.use(auth.loadAdmin);

// View helpers of the admin panel (available on the login page too).
router.use((req, res, next) => {
  Object.assign(res.locals, {
    icon,
    badgeClass,
    qs,
    formatBytes,
    formatPhone: customersService.formatPhone,
    providerLabels: PROVIDER_LABELS,
    assetV,
    botEnabled: config.bot.enabled,
    paymentTitle: '',
    paymentLive: false,
    section: '',
    nav: [],
    navCounts: {},
    pageTitle: '',
    can: (...roles) => Boolean(req.admin && roles.includes(req.admin.role)),
  });
  next();
});

// ─────────────────────────────── login / logout (public part)

const DEV_PASSWORD = 'admin12345';
/** IP-wide brake on top of the limiters built into auth.login() (per IP+account and per account from any IP). */
const loginIpLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  key: (req) => `admin-login:${req.ip}`,
  message: 'Слишком много попыток входа. Попробуйте через 15 минут.',
});

function renderLogin(req, res, { status = 200, error = null, email = '' } = {}) {
  res.status(status).render(view('login'), {
    title: 'Вход',
    error,
    email,
    next: auth.safeNext(req.body?.next || req.query.next),
    // Demo hint: only outside production and only while the default dev password is configured.
    demoHint: !config.isProd && config.admin.password === DEV_PASSWORD ? { email: config.admin.email, password: DEV_PASSWORD } : null,
  });
}

router.get('/login', (req, res) => {
  if (req.admin) return res.redirect(auth.safeNext(req.query.next));
  res.set('Cache-Control', 'no-store');
  return renderLogin(req, res);
});

router.post('/login', loginIpLimit, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const email = String(req.body?.email || '').trim().slice(0, 160);
  const password = String(req.body?.password || '');
  if (!email || !password) {
    return renderLogin(req, res, { status: 422, error: 'Введите e-mail и пароль', email });
  }
  const result = auth.login(email, password, {
    ip: req.ip, userAgent: req.get('user-agent') || '', knownAccount: req.signedCookies?.[auth.DEVICE_COOKIE] || '',
  });
  if (!result.ok) {
    if (result.reason === 'rate_limited') {
      const minutes = Math.max(1, Math.ceil((result.retryAfterSec || 60) / 60));
      res.set('Retry-After', String(result.retryAfterSec || 60));
      return renderLogin(req, res, { status: 429, error: `Слишком много неудачных попыток. Попробуйте через ${minutes} мин.`, email });
    }
    return renderLogin(req, res, { status: 401, error: 'Неверный e-mail или пароль', email });
  }
  auth.setSessionCookie(res, result.token);
  auth.setDeviceCookie(res, result.admin.email);
  return res.redirect(auth.safeNext(req.body.next));
});

// ─────────────────────────────── everything below needs a session

router.use(auth.requireAdmin);

router.use((req, res, next) => {
  res.locals.nav = navFor(req.admin.role);
  const byStatus = orders.countByStatus();
  const fb = feedback.counts();
  // Orders that need a manager right now: paid and not yet in work.
  res.locals.navCounts = { orders: byStatus.paid, feedback: fb.unread };
  // Production without a known public address: Telegram links, sitemap and payment returns point to localhost.
  res.locals.baseUrlWarning = config.isProd && config.baseUrlIsFallback;
  // Which payment provider customers actually get right now (sidebar status line).
  try {
    const provider = payments.resolveProvider();
    res.locals.paymentTitle = provider.id === 'mock' ? 'демо-режим' : provider.title;
    res.locals.paymentLive = provider.id !== 'mock';
  } catch {
    res.locals.paymentTitle = 'не настроена';
  }
  next();
});

router.post('/logout', (req, res) => {
  auth.logout(req.adminToken);
  auth.clearSessionCookie(res);
  req.flash('info', 'Вы вышли из админ-панели');
  res.redirect('/admin/login');
});

const manage = auth.requireRole('owner', 'admin');

router.use('/', dashboardRouter);
router.use('/content', contentRouter);
router.use('/', catalogRouter); // /products, /categories
router.use('/', plansRouter); // /plans, /subscriptions
router.use('/', blogRouter); // /posts, /faq
router.use('/orders', ordersRouter);
router.use('/customers', customersRouter);
router.use('/feedback', feedbackRouter);
router.use('/media', mediaRouter);
router.use('/settings', manage, settingsRouter);
router.use('/broadcasts', manage, broadcastsRouter);
router.use('/', accountRouter); // /account, /admins (owner only)

// ─────────────────────────────── 404 + errors inside the panel

router.use((req, res) => {
  if (req.xhr || req.accepts(['html', 'json']) === 'json') {
    return res.status(404).json({ ok: false, error: 'not_found', message: 'Не найдено' });
  }
  return res.status(404).render(view('error'), {
    title: 'Страница не найдена',
    code: 404,
    message: 'Такой страницы в админ-панели нет. Возможно, запись удалили или ссылка устарела.',
  });
});

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (!req.admin) return next(err);
  const wantsJson = req.xhr || req.accepts(['html', 'json']) === 'json';
  const isUpload = err instanceof multer.MulterError || err?.code === 'bad_file_type';
  if (isUpload) {
    media.discardUploads(req.files || req.file);
    const message = media.uploadErrorMessage(err);
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
    if (wantsJson) return res.status(status).json({ ok: false, error: err.code || 'upload_failed', message });
    req.flash('error', message);
    return res.redirect(backUrl(req, '/admin/media'));
  }
  if (!isUserError(err)) return next(err);
  if (wantsJson) {
    return res.status(err.status).json({ ok: false, error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
  }
  if (err.status === 404 || err.status === 403) {
    return res.status(err.status).render(view('error'), {
      title: err.status === 404 ? 'Не найдено' : 'Недостаточно прав',
      code: err.status,
      message: err.message,
    });
  }
  // Validation / state errors of POST actions: explain and go back to where the admin was.
  if (req.method !== 'GET') {
    req.flash('error', err.message);
    return res.redirect(backUrl(req));
  }
  return next(err);
});

export default router;
