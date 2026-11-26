// Mounted at /pay.
//   GET  /pay/order/:token      hosted payment entry: starts a payment with the active provider and redirects
//   GET  /pay/return/:token     where Payme / Click send the customer back; reads the state from the DB only
//   GET  /pay/status/:token     JSON state of an order for the waiting pages (polling)
//   GET  /pay/invoice/:token    "pay in Telegram" page with the invoice link (telegram provider on the site)
//   GET  /pay/mock/:tx          demo checkout page                (404 when the mock provider is disabled)
//   POST /pay/mock/:tx          demo checkout result (action=success|fail|cancel), CSRF-protected
//   POST /pay/payme             Payme Merchant API (JSON-RPC 2.0, Basic auth)
//   POST /pay/click/prepare     Click SHOP API, Prepare  (form-encoded, md5 sign)
//   POST /pay/click/complete    Click SHOP API, Complete (form-encoded, md5 sign)
// /pay/payme and /pay/click/* are excluded from CSRF and cookies in app.js; they authenticate every
// request themselves and always answer in the provider's own format with HTTP 200.
import { Router } from 'express';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { rateLimit } from '../lib/ratelimit.js';
import * as orders from '../services/orders.js';
import * as paymentsRepo from '../services/payments.js';
import { startPayment } from './index.js';
import { orderStatusUrl, safeReturnUrl } from './common.js';
import { paymentLog } from './log.js';
import { MOCK_TX_PATTERN, mockEnabled } from './providers/mock.js';
import * as payme from './providers/payme.js';
import * as click from './providers/click.js';

/**
 * Our own pages (e.g. the demo checkout /pay/mock/…) are redirected to by path, so the browser stays on
 * the address it is actually using even when BASE_URL is missing or wrong. External providers keep their URL.
 */
function sameSitePath(url) {
  return url.startsWith(`${config.baseUrl}/`) ? url.slice(config.baseUrl.length) : url;
}

const router = Router();
const view = (name) => `payments/views/${name}`;
const noStore = (res) => res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });

const entryLimiter = rateLimit({ windowMs: 60_000, max: 30 });
const returnLimiter = rateLimit({ windowMs: 60_000, max: 60 });
const invoiceLimiter = rateLimit({ windowMs: 60_000, max: 60 });
const statusLimiter = rateLimit({ windowMs: 60_000, max: 120, json: true });
const mockLimiter = rateLimit({ windowMs: 60_000, max: 60 });

/** Where the customer goes after the payment: the return URL stored with the latest attempt. */
function storedReturnUrl(order, attempts = paymentsRepo.listByOrder(order.id)) {
  const stored = attempts.find((p) => typeof p.raw?.returnUrl === 'string' && p.raw.returnUrl)?.raw.returnUrl;
  return safeReturnUrl(stored, order);
}

// ─────────────────────────────── entry

/** Messengers fetch shared links to build previews — such a visit must not start a payment. */
const LINK_PREVIEW_UA = /telegrambot|whatsapp|facebookexternalhit|twitterbot|slackbot|discordbot|vkshare|skypeuripreview|linkedinbot/i;

router.get('/order/:token', entryLimiter, async (req, res, next) => {
  try {
    const order = orders.getOrderByToken(req.params.token);
    if (!order) return next();
    noStore(res);
    const returnUrl = safeReturnUrl(req.query.return, order);
    if (!order.can_pay || LINK_PREVIEW_UA.test(req.get('user-agent') || '')) return res.redirect(sameSitePath(returnUrl));
    let result;
    try {
      result = await startPayment(order, { returnUrl, channel: order.channel });
    } catch (err) {
      if (err instanceof AppError) {
        if (err.code === 'already_paid' || err.code === 'order_closed') return res.redirect(sameSitePath(returnUrl));
        throw err;
      }
      // the provider is unreachable or refused the request (details are in the payment log)
      throw new AppError('payment_unavailable', 'Не удалось начать оплату. Попробуйте ещё раз через минуту или свяжитесь с нами.', 503);
    }
    if (result.redirectUrl) return res.redirect(sameSitePath(result.redirectUrl));
    if (result.invoiceLink) return res.redirect(`/pay/invoice/${order.public_token}`);
    return res.redirect(sameSitePath(returnUrl));
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────── return / status (the database is the only source of truth)

/** A provider transaction that was opened recently and still waits for its final callback. */
const IN_FLIGHT_WINDOW_MS = 30 * 60 * 1000;
const hasInFlightTransaction = (attempts) => attempts.some((p) => p.status === 'pending' && p.provider_tx_id
  && (p.provider === 'payme' || p.provider === 'click') && Date.now() - Number(p.create_time || 0) < IN_FLIGHT_WINDOW_MS);

router.get('/return/:token', returnLimiter, (req, res, next) => {
  try {
    const order = orders.getOrderByToken(req.params.token);
    if (!order) return next();
    noStore(res);
    // Nothing from the query string is used: providers (and anybody else) can append whatever they like.
    const attempts = paymentsRepo.listByOrder(order.id);
    const returnUrl = storedReturnUrl(order, attempts);
    if (order.is_paid || !order.can_pay || !hasInFlightTransaction(attempts)) return res.redirect(303, sameSitePath(returnUrl));
    // The customer came back before the provider's final callback: wait for it here.
    return res.render(view('pending'), { order, returnUrl: sameSitePath(returnUrl), title: `Проверяем оплату заказа ${order.number}` });
  } catch (err) {
    return next(err);
  }
});

router.get('/status/:token', statusLimiter, (req, res, next) => {
  try {
    const order = orders.getOrderByToken(req.params.token);
    noStore(res);
    if (!order) return res.status(404).json({ ok: false, error: 'not_found', message: 'Заказ не найден' });
    return res.json({
      ok: true,
      number: order.number,
      status: order.status,
      payment_status: order.payment_status,
      paid: order.is_paid,
      can_pay: order.can_pay,
    });
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────── Telegram invoice page

router.get('/invoice/:token', invoiceLimiter, (req, res, next) => {
  try {
    const order = orders.getOrderByToken(req.params.token);
    if (!order) return next();
    noStore(res);
    const attempts = paymentsRepo.listByOrder(order.id);
    const returnUrl = storedReturnUrl(order, attempts);
    if (!order.can_pay) return res.redirect(303, sameSitePath(returnUrl));
    const attempt = attempts.find((p) => p.provider === 'telegram' && p.status === 'pending' && !p.provider_tx_id);
    const invoiceLink = attempt?.amount === order.total && /^https:\/\/t\.me\/[^\s"'<>]+$/.test(attempt.raw?.invoiceLink || '') ? attempt.raw.invoiceLink : null;
    if (!invoiceLink) return res.redirect(303, sameSitePath(orderStatusUrl(order)));
    return res.render(view('telegram-invoice'), { order, invoiceLink, returnUrl: sameSitePath(returnUrl), title: `Оплата заказа ${order.number} в Telegram` });
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────── mock (demo checkout)

function loadMockPayment(req) {
  if (!mockEnabled()) return null;
  const payment = MOCK_TX_PATTERN.test(req.params.tx) ? paymentsRepo.findByProviderTx('mock', req.params.tx) : null;
  if (!payment) return null;
  const order = orders.getOrder(payment.order_id);
  return order ? { payment, order, returnUrl: safeReturnUrl(payment.raw?.returnUrl, order) } : null;
}

/** An attempt can be used once, while it is pending and still matches the order. */
const mockUsable = ({ payment, order }) => payment.status === 'pending' && order.can_pay && payment.amount === order.total;

router.get('/mock/:tx', mockLimiter, (req, res, next) => {
  const ctx = loadMockPayment(req);
  if (!ctx) return next();
  noStore(res);
  if (!mockUsable(ctx)) return res.redirect(sameSitePath(ctx.returnUrl));
  return res.render(view('mock-checkout'), { order: ctx.order, payment: ctx.payment, returnUrl: sameSitePath(ctx.returnUrl), title: `Оплата заказа ${ctx.order.number}` });
});

router.post('/mock/:tx', mockLimiter, (req, res, next) => {
  try {
    const ctx = loadMockPayment(req);
    if (!ctx) return next();
    const { payment, order, returnUrl } = ctx;
    const action = String(req.body?.action || '');
    if (!['success', 'fail', 'cancel'].includes(action)) throw new AppError('validation', 'Неизвестное действие', 400);
    let changed = false;
    if (mockUsable(ctx)) {
      if (action === 'success' && orders.stockShortage(order).length) {
        // the goods ran out while the checkout page was open: nothing is "charged"
        ({ changed } = orders.markPaymentFailed(order.id, { provider: 'mock', paymentId: payment.id, txId: payment.provider_tx_id, reason: 'Товар закончился — оплата не проведена' }));
      } else if (action === 'success') {
        ({ changed } = orders.markPaid(order.id, { provider: 'mock', paymentId: payment.id, txId: payment.provider_tx_id, amount: payment.amount, raw: { simulated: true } }));
      } else if (action === 'fail') {
        ({ changed } = orders.markPaymentFailed(order.id, { provider: 'mock', paymentId: payment.id, txId: payment.provider_tx_id, reason: 'Банк отклонил операцию (демо)' }));
      }
      // action === 'cancel' → nothing changes, the customer just goes back
    }
    paymentLog('mock.result', { order: order.id, number: order.number, tx: payment.provider_tx_id, action, changed });
    return res.redirect(303, sameSitePath(returnUrl || orderStatusUrl(order)));
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────── Payme Merchant API

/** Raw request body: taken from the global parsers when they consumed it, otherwise read here. */
async function readRawBody(req, limit = 1024 * 1024) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new AppError('too_large', 'Request body is too large', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

router.all('/payme', async (req, res) => {
  noStore(res);
  let body;
  let parseError = false;
  try {
    if (req.method === 'POST') body = JSON.parse((await readRawBody(req)).toString('utf8'));
  } catch {
    parseError = true;
  }
  // The answer is always HTTP 200 + JSON-RPC, errors included (Payme treats other statuses as "merchant is down").
  return res.status(200).json(payme.handleRpc({ body, parseError, authorization: req.get('authorization'), httpMethod: req.method }));
});

// ─────────────────────────────── Click SHOP API

router.post('/click/prepare', (req, res) => {
  noStore(res);
  return res.status(200).json(click.handlePrepare(req.body));
});

router.post('/click/complete', (req, res) => {
  noStore(res);
  return res.status(200).json(click.handleComplete(req.body));
});

/**
 * Error handler for requests that failed BEFORE reaching this router (the global body parsers reject
 * malformed or oversized bodies). Providers must still get an answer in their own protocol, so
 * app.js mounts this at /pay ahead of the generic error handler. Everything else is passed on.
 */
// eslint-disable-next-line no-unused-vars
export function paymentsErrorHandler(err, req, res, next) {
  const path = String(req.originalUrl || '').split('?')[0];
  if (res.headersSent) return next(err);
  if (/^\/pay\/payme\/?$/.test(path)) {
    const key = err?.type === 'entity.parse.failed' || err instanceof SyntaxError ? 'parse' : err?.status >= 400 && err?.status < 500 ? 'invalid_request' : 'internal';
    paymentLog('payme.rejected', { level: 'error', reason: err?.type || err?.message, key });
    return res.status(200).json(payme.errorResponse(key));
  }
  if (/^\/pay\/click\/(prepare|complete)\/?$/.test(path)) {
    paymentLog('click.rejected', { level: 'error', reason: err?.type || err?.message });
    return res.status(200).json({ error: click.ERROR.BAD_REQUEST, error_note: 'Error in request from click' });
  }
  return next(err);
}

export default router;
