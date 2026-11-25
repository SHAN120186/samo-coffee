// MINI APP module: JSON API mounted at /api/tma.
//
// Auth: every route except GET /ping requires `Authorization: tma <Telegram.WebApp.initData>`
// (see ./auth.js). This prefix is CSRF-exempt and never reads cookies.
//
// Response envelope:  success → { ok: true, ...data }
//                     failure → { ok: false, error: <code>, message: <Russian text>, details? }
//
//   GET    /ping                       health + who am I (no auth required)
//   GET    /bootstrap                  user, profile prefill, settings, texts, categories, cart, subscription
//   POST   /events                     { name: tma_open | view_product | begin_checkout, productId? }
//   GET    /categories
//   GET    /products                   ?category=<slug>&search=&sort=&featured=1&limit=&offset=
//   GET    /products/:idOrSlug         product + related
//   GET    /cart                       cart view
//   POST   /cart/items                 { productId, qty? }      (records add_to_cart)
//   PUT    /cart/items/:productId      { qty }                  (0 removes the line)
//   DELETE /cart/items/:productId
//   DELETE /cart
//   POST   /checkout                   { customer, delivery, comment, invoice?, returnToApp? } → order + invoiceLink | redirectUrl
//   GET    /plans                      plans + current subscription
//   POST   /subscribe                  { planId, customer, delivery?, comment, invoice?, returnToApp? } → like /checkout
//   GET    /subscription               current subscription + its plan
//   POST   /subscription/:action       pause | resume | cancel
//   GET    /orders                     my orders
//   GET    /orders/:id                 one order (also used for payment status polling)
//   POST   /orders/:id/pay             restart the payment → invoiceLink | redirectUrl
//   POST   /orders/:id/cancel          cancel an unpaid order
//   POST   /orders/:id/repeat          put the items of an order back into the cart
//   GET    /feedback                   my support conversation (channel "tma")
//   POST   /feedback                   { text } → stored + forwarded to the admin chat; answers arrive via the bot
import { Router } from 'express';
import { config } from '../config.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { clean } from '../lib/escape.js';
import { rateLimit } from '../lib/ratelimit.js';
import { resolveTmaUser } from '../lib/initData.js';
import * as catalog from '../services/catalog.js';
import * as cart from '../services/cart.js';
import * as orders from '../services/orders.js';
import * as subscriptions from '../services/subscriptions.js';
import * as customers from '../services/customers.js';
import * as feedback from '../services/feedback.js';
import * as analytics from '../services/analytics.js';
import * as settings from '../services/settings.js';
import * as content from '../services/content.js';
import { requireTmaUser, displayName, botUrl } from './auth.js';
import { startTmaPayment, invoiceAvailable } from './payment.js';
import { productCard, productFull, categoryView, planView, subscriptionView, orderView, messageView } from './serialize.js';

const router = Router();

// ─────────────────────────────── helpers

/** Wrap a (possibly async) handler so rejections reach the error middleware (Express 4). */
const wrap = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res, next);
    if (out && typeof out.catch === 'function') out.catch(next);
  } catch (err) {
    next(err);
  }
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const body = (req) => (isObject(req.body) ? req.body : {});
/** Text input: only strings (and numbers) are accepted — objects and arrays become ''. */
const str = (v, max) => (typeof v === 'string' || typeof v === 'number' ? clean(v, max) : '');

/** "42" → 42; anything that is not a positive integer id → 422. */
function toId(value, what = 'Идентификатор') {
  const n = typeof value === 'number' ? value : /^\d{1,12}$/.test(String(value ?? '')) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw invalid(`${what}: некорректное значение`);
  return n;
}

function toQty(value, { min = 1 } = {}) {
  const n = typeof value === 'number' ? value : /^\d{1,4}$/.test(String(value ?? '')) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < min || n > 999) throw invalid('Количество указано неверно', { fields: { qty: 'Количество указано неверно' } });
  return Math.min(n, cart.MAX_QTY_PER_ITEM);
}

const userKey = (req) => `tma:${req.tma?.user?.id ?? req.ip}`;
const limiter = (max, windowMs, message) => rateLimit({ windowMs, max, key: userKey, json: true, message });

const readLimiter = limiter(300, 60_000);
const cartLimiter = limiter(90, 60_000, 'Слишком много действий с корзиной. Подождите немного.');
const orderLimiter = limiter(10, 10 * 60_000, 'Слишком много заказов подряд. Попробуйте через несколько минут.');
const payLimiter = limiter(20, 10 * 60_000, 'Слишком много попыток оплаты. Попробуйте через несколько минут.');
const actionLimiter = limiter(20, 10 * 60_000);
const feedbackLimiter = limiter(6, 60_000, 'Слишком много сообщений. Подождите минуту и напишите ещё раз.');
const eventLimiter = limiter(120, 60_000);

/** Checkout prefill: what we already know about the customer. */
function profileFor(user) {
  const customer = customers.getCustomerByTgUserId(user.id);
  const last = orders.listForTgUser(user.id, 1)[0];
  return {
    name: last?.customer_name || customer?.name || displayName(user),
    phone: customer?.phone || last?.customer_phone || '',
    email: customer?.email || last?.customer_email || '',
    address: last?.delivery_address || customer?.address || '',
    delivery_method: last?.delivery_method === 'pickup' ? 'pickup' : 'courier',
  };
}

function publicSettings() {
  const s = settings.getAll();
  return {
    site_name: s.site_name,
    site_tagline: s.site_tagline,
    phone: s.phone,
    email: s.email,
    address: s.address,
    work_hours: s.work_hours,
    social_telegram: s.social_telegram,
    social_instagram: s.social_instagram,
    delivery_fee: settings.getInt('delivery_fee', 0),
    free_delivery_from: settings.getInt('free_delivery_from', 0),
    pickup_address: s.pickup_address,
    delivery_note: s.delivery_note,
  };
}

function cartSummary(view) {
  return { count: view.count, subtotal: view.subtotal };
}

/** The user's order or 404 (never reveals that a foreign order exists). */
function ownOrder(req) {
  const order = orders.getOrder(toId(req.params.id, 'Заказ'));
  if (!order || order.tg_user_id !== req.tma.user.id) throw notFound('Заказ');
  return order;
}

function checkoutInput(req) {
  const b = body(req);
  const c = isObject(b.customer) ? b.customer : {};
  const d = isObject(b.delivery) ? b.delivery : {};
  const { user } = req.tma;
  return {
    customer: { name: str(c.name, 120), phone: str(c.phone, 40), email: str(c.email, 160) },
    delivery: { method: d.method === 'pickup' ? 'pickup' : 'courier', address: str(d.address, 300) },
    comment: str(b.comment, 1000),
    channel: 'tma',
    sessionId: `tg:${user.id}`,
    source: 'telegram',
    tgUserId: user.id,
    tgUsername: user.username || undefined,
  };
}

/** Start the payment; a provider problem must not lose the order that was just created. */
async function beginPayment(req, order) {
  const b = body(req);
  try {
    const payment = await startTmaPayment(order, {
      tgUserId: req.tma.user.id,
      preferInvoice: b.invoice !== false,
      returnToApp: b.returnToApp === true,
    });
    return { payment };
  } catch (err) {
    if (err instanceof AppError && err.code !== 'payment_unavailable') throw err;
    if (!(err instanceof AppError)) console.error('[tma] payment start failed:', err);
    return {
      payment: null,
      paymentError: {
        error: err.code || 'payment_failed',
        message: err instanceof AppError ? err.message : 'Не удалось открыть оплату. Заказ сохранён — оплатите его из раздела «Заказы».',
      },
    };
  }
}

function paymentResponse(order, { payment, paymentError }) {
  return {
    ok: true,
    order: orderView(orders.getOrder(order.id)),
    provider: payment?.provider || null,
    ...(payment?.invoiceLink ? { invoiceLink: payment.invoiceLink } : {}),
    ...(payment?.redirectUrl ? { redirectUrl: payment.redirectUrl } : {}),
    ...(paymentError ? { paymentError } : {}),
  };
}

// ─────────────────────────────── public

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.get('/ping', (req, res) => {
  const auth = resolveTmaUser(req);
  res.json({
    ok: true,
    user: auth.user ? { id: auth.user.id, first_name: auth.user.first_name } : null,
    dev: Boolean(auth.dev),
    botUrl: botUrl(),
  });
});

// ─────────────────────────────── everything below needs a Mini App user
// Routes are declared through `secure.*`, so none can be registered without the auth middleware,
// while unknown paths still fall through to the JSON 404 at the bottom.

const secure = Object.fromEntries(['get', 'post', 'put', 'delete'].map((method) => [
  method,
  (path, ...handlers) => router[method](path, requireTmaUser, readLimiter, ...handlers),
]));

secure.get('/bootstrap', wrap((req, res) => {
  const { user, dev, startParam, cartRef } = req.tma;
  res.json({
    ok: true,
    user: { id: user.id, first_name: user.first_name, last_name: user.last_name, username: user.username, name: displayName(user) },
    dev,
    startParam,
    profile: profileFor(user),
    settings: publicSettings(),
    texts: content.getPage('tma'),
    categories: catalog.listCategories().filter((c) => c.product_count > 0).map(categoryView),
    cart: cartSummary(cart.getCart(cartRef)),
    subscription: subscriptionView(subscriptions.getCurrentForTgUser(user.id)),
    payments: { invoice: invoiceAvailable() },
    limits: { maxQty: cart.MAX_QTY_PER_ITEM, maxMessageLength: feedback.MAX_MESSAGE_LENGTH },
    links: { site: config.baseUrl, bot: botUrl() },
  });
}));

const CLIENT_EVENTS = new Set(['tma_open', 'view_product', 'begin_checkout']);

secure.post('/events', eventLimiter, wrap((req, res) => {
  const b = body(req);
  const name = String(b.name || '');
  if (!CLIENT_EVENTS.has(name)) throw invalid('Неизвестное событие');
  const { user, cartRef } = req.tma;
  const base = { channel: 'tma', tgUserId: user.id };
  if (name === 'tma_open') {
    analytics.trackEvent(name, { ...base, meta: { platform: str(b.platform, 24), version: str(b.version, 12), start_param: str(req.tma.startParam, 64) } });
  } else if (name === 'view_product') {
    const product = catalog.getProduct(toId(b.productId, 'Товар'));
    if (!product || !product.active) throw notFound('Товар');
    analytics.trackEvent(name, { ...base, productId: product.id, value: product.price });
  } else {
    const view = cart.getCart(cartRef);
    if (!view.count) return res.json({ ok: true, tracked: false });
    analytics.trackEvent(name, { ...base, value: view.subtotal });
  }
  return res.json({ ok: true, tracked: true });
}));

// ─────────────────────────────── catalog

secure.get('/categories', wrap((req, res) => {
  res.json({ ok: true, items: catalog.listCategories().filter((c) => c.product_count > 0).map(categoryView) });
}));

secure.get('/products', wrap((req, res) => {
  const q = req.query;
  const sort = Object.hasOwn(catalog.PRODUCT_SORTS, String(q.sort)) ? String(q.sort) : undefined;
  const limit = Math.min(60, Math.max(1, Number.parseInt(q.limit, 10) || 60));
  const offset = Math.max(0, Number.parseInt(q.offset, 10) || 0);
  const category = /^[a-z0-9-]{1,80}$/.test(String(q.category || '')) ? String(q.category) : undefined;
  const { items, total } = catalog.listProducts({
    categorySlug: category,
    search: str(q.search, 80),
    sort,
    featured: q.featured === '1' || q.featured === 'true',
    limit,
    offset,
  });
  res.json({ ok: true, items: items.map(productCard), total, limit, offset });
}));

secure.get('/products/:key', wrap((req, res) => {
  const key = String(req.params.key);
  const product = /^\d{1,12}$/.test(key) ? catalog.getProduct(Number(key)) : /^[a-z0-9-]{1,120}$/.test(key) ? catalog.getProductBySlug(key) : null;
  if (!product || !product.active) throw notFound('Товар');
  const inCart = cart.getCart(req.tma.cartRef).items.find((i) => i.product_id === product.id)?.qty || 0;
  res.json({
    ok: true,
    product: productFull(product),
    related: catalog.relatedProducts(product, 4).map(productCard),
    inCart,
  });
}));

// ─────────────────────────────── cart

secure.get('/cart', wrap((req, res) => {
  res.json({ ok: true, cart: cart.getCart(req.tma.cartRef) });
}));

secure.post('/cart/items', cartLimiter, wrap((req, res) => {
  const b = body(req);
  const productId = toId(b.productId, 'Товар');
  const qty = b.qty === undefined ? 1 : toQty(b.qty);
  const before = cart.countItems(req.tma.cartRef);
  const view = cart.addItem(req.tma.cartRef, productId, qty);
  const line = view.items.find((i) => i.product_id === productId);
  if (view.count > before) {
    analytics.trackEvent('add_to_cart', { channel: 'tma', tgUserId: req.tma.user.id, productId, value: line?.price || 0, meta: { qty } });
  }
  res.status(201).json({ ok: true, cart: view, added: view.count - before });
}));

secure.put('/cart/items/:productId', cartLimiter, wrap((req, res) => {
  const productId = toId(req.params.productId, 'Товар');
  const qty = toQty(body(req).qty, { min: 0 });
  res.json({ ok: true, cart: cart.setQty(req.tma.cartRef, productId, qty) });
}));

secure.delete('/cart/items/:productId', cartLimiter, wrap((req, res) => {
  res.json({ ok: true, cart: cart.removeItem(req.tma.cartRef, toId(req.params.productId, 'Товар')) });
}));

secure.delete('/cart', cartLimiter, wrap((req, res) => {
  cart.clearCart(req.tma.cartRef);
  res.json({ ok: true, cart: cart.getCart(req.tma.cartRef) });
}));

// ─────────────────────────────── checkout & payment

secure.post('/checkout', orderLimiter, wrap(async (req, res) => {
  const order = orders.createFromCart(req.tma.cartRef, checkoutInput(req));
  res.status(201).json(paymentResponse(order, await beginPayment(req, order)));
}));

// ─────────────────────────────── subscriptions

secure.get('/plans', wrap((req, res) => {
  res.json({
    ok: true,
    items: subscriptions.listPlans().map(planView),
    subscription: subscriptionView(subscriptions.getCurrentForTgUser(req.tma.user.id)),
  });
}));

secure.post('/subscribe', orderLimiter, wrap(async (req, res) => {
  const planId = toId(body(req).planId, 'План');
  const order = orders.createSubscriptionOrder({ ...checkoutInput(req), planId });
  res.status(201).json(paymentResponse(order, await beginPayment(req, order)));
}));

secure.get('/subscription', wrap((req, res) => {
  const sub = subscriptions.getCurrentForTgUser(req.tma.user.id);
  const plan = sub ? subscriptions.getPlan(sub.plan_id) : null;
  res.json({ ok: true, subscription: subscriptionView(sub), plan: plan ? planView(plan) : null });
}));

const SUBSCRIPTION_ACTIONS = {
  pause: subscriptions.pauseSubscription,
  resume: subscriptions.resumeSubscription,
  cancel: subscriptions.cancelSubscription,
};

secure.post('/subscription/:action', actionLimiter, wrap((req, res) => {
  const action = SUBSCRIPTION_ACTIONS[req.params.action];
  if (!action || !Object.hasOwn(SUBSCRIPTION_ACTIONS, req.params.action)) throw notFound('Операция');
  const sub = subscriptions.getCurrentForTgUser(req.tma.user.id);
  if (!sub) throw new AppError('not_found', 'У вас нет активной подписки', 404);
  action(sub.id);
  res.json({ ok: true, subscription: subscriptionView(subscriptions.getCurrentForTgUser(req.tma.user.id)) });
}));

// ─────────────────────────────── orders

secure.get('/orders', wrap((req, res) => {
  res.json({ ok: true, items: orders.listForTgUser(req.tma.user.id, 30).map(orderView) });
}));

secure.get('/orders/:id', wrap((req, res) => {
  res.json({ ok: true, order: orderView(ownOrder(req)) });
}));

secure.post('/orders/:id/pay', payLimiter, wrap(async (req, res) => {
  const order = ownOrder(req);
  const result = await beginPayment(req, order);
  if (result.paymentError) throw new AppError(result.paymentError.error, result.paymentError.message, 503);
  res.json(paymentResponse(order, result));
}));

secure.post('/orders/:id/cancel', actionLimiter, wrap((req, res) => {
  const order = ownOrder(req);
  const result = orders.cancel(order.id, { actor: 'customer', reason: 'Отменён покупателем в мини-приложении' });
  res.json({ ok: true, order: orderView(result.order), changed: result.changed });
}));

secure.post('/orders/:id/repeat', cartLimiter, wrap((req, res) => {
  const order = ownOrder(req);
  const skipped = [];
  let added = 0;
  for (const item of order.items) {
    if (!item.product_id) continue;
    try {
      cart.addItem(req.tma.cartRef, item.product_id, item.qty);
      added += 1;
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      skipped.push(item.title);
    }
  }
  if (!added) throw new AppError('out_of_stock', 'Товаров из этого заказа сейчас нет в наличии', 409);
  res.json({ ok: true, cart: cart.getCart(req.tma.cartRef), added, skipped });
}));

// ─────────────────────────────── feedback (support)

function conversation(tgUserId) {
  const threads = feedback.listForTgUser(tgUserId, 20).filter((t) => t.channel === 'tma');
  const current = threads.filter((t) => t.status !== 'closed').sort((a, b) => b.id - a.id)[0] || null;
  const messages = threads
    .flatMap((t) => t.messages)
    .sort((a, b) => a.id - b.id)
    .slice(-200)
    .map(messageView);
  return {
    thread: current ? { id: current.id, status: current.status, status_label: current.status_label } : null,
    messages,
  };
}

secure.get('/feedback', wrap((req, res) => {
  res.json({ ok: true, ...conversation(req.tma.user.id) });
}));

secure.post('/feedback', feedbackLimiter, wrap(async (req, res) => {
  const text = str(body(req).text, feedback.MAX_MESSAGE_LENGTH);
  if (text.length < 2) throw invalid('Напишите сообщение', { fields: { text: 'Напишите сообщение' } });
  const { user } = req.tma;
  const result = await feedback.receiveFromTelegram({ tgUser: user, chatId: user.id, text, channel: 'tma' });
  res.status(201).json({ ok: true, message: messageView(result.message), isNew: result.isNew, ...conversation(user.id) });
}));

// ─────────────────────────────── fallbacks

router.use((req, res) => {
  res.status(404).json({ ok: false, error: 'not_found', message: 'Метод не найден' });
});

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number(err.status || err.statusCode) || 500;
  if (status >= 500 && !(err instanceof AppError)) console.error(`[tma] ${req.method} ${req.originalUrl}`, err);
  const expose = err instanceof AppError || (status >= 400 && status < 500);
  return res.status(status).json({
    ok: false,
    // unexpected failures never leak their own codes (e.g. database error names)
    error: expose ? (err.code || 'error') : 'internal',
    message: expose && err.message ? err.message : 'Что-то пошло не так. Попробуйте ещё раз.',
    ...(expose && err.details ? { details: err.details } : {}),
  });
});

export default router;
