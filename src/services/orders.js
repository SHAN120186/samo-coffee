// Orders: creation, status machine and THE single entry point for payment results (markPaid).
//
// Lifecycle
//   new ──► pending_payment ──► paid ──► processing ──► shipped ──► delivered
//    │            │               └──────────┴─────────────┴────────────┴──► refunded
//    └────────────┴──► cancelled
//
// payment_status: unpaid → pending → paid | failed (retry allowed) ; paid → refunded
import crypto from 'node:crypto';
import { all, get, run, tx, now } from '../db/index.js';
import { config } from '../config.js';
import { AppError, notFound } from '../lib/errors.js';
import { emit } from '../lib/bus.js';
import { clean } from '../lib/escape.js';
import * as cartService from './cart.js';
import * as customers from './customers.js';
import * as subscriptions from './subscriptions.js';
import * as paymentsRepo from './payments.js';
import * as analytics from './analytics.js';
import * as notify from './notify.js';

export const ORDER_STATUSES = ['new', 'pending_payment', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'];
export const PAYMENT_STATUSES = ['unpaid', 'pending', 'paid', 'failed', 'refunded'];
export const ORDER_STATUS_LABELS = notify.ORDER_STATUS_LABELS;
export const PAYMENT_STATUS_LABELS = notify.PAYMENT_STATUS_LABELS;
export const CHANNEL_LABELS = notify.CHANNEL_LABELS;
export const DELIVERY_METHOD_LABELS = { courier: 'Курьером', pickup: 'Самовывоз' };
export const KIND_LABELS = { product: 'Товары', subscription: 'Подписка' };

/** Status machine: current status → statuses it may move to. */
export const TRANSITIONS = {
  new: ['pending_payment', 'paid', 'cancelled'],
  pending_payment: ['paid', 'cancelled'],
  paid: ['processing', 'shipped', 'delivered', 'refunded'],
  processing: ['shipped', 'delivered', 'refunded'],
  shipped: ['delivered', 'refunded'],
  delivered: ['refunded'],
  cancelled: [],
  refunded: [],
};

const CHANNELS = ['site', 'tma', 'bot', 'admin'];

// ─────────────────────────────── reading

function hydrate(row) {
  if (!row) return null;
  const payable = ['unpaid', 'pending', 'failed'].includes(row.payment_status) && ['new', 'pending_payment'].includes(row.status);
  return {
    ...row,
    status_label: ORDER_STATUS_LABELS[row.status] || row.status,
    payment_status_label: PAYMENT_STATUS_LABELS[row.payment_status] || row.payment_status,
    channel_label: CHANNEL_LABELS[row.channel] || row.channel,
    delivery_method_label: DELIVERY_METHOD_LABELS[row.delivery_method] || row.delivery_method,
    kind_label: KIND_LABELS[row.kind] || row.kind,
    is_paid: row.payment_status === 'paid',
    /** the customer may (re)start a payment */
    can_pay: payable,
    /** public status page */
    url: `/order/${row.public_token}`,
    /** hosted payment entry point: redirects to the active provider */
    pay_url: `/pay/order/${row.public_token}`,
  };
}

const withItems = (order) => (order ? { ...order, items: all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', order.id) } : null);

/** Order with items[] or null. */
export function getOrder(id) {
  return withItems(hydrate(get('SELECT * FROM orders WHERE id = ?', Number(id))));
}

/** Order by the unguessable public token (status page, hosted payment). */
export function getOrderByToken(token) {
  if (!token || typeof token !== 'string') return null;
  return withItems(hydrate(get('SELECT * FROM orders WHERE public_token = ?', token)));
}

/** Order by human number "SC-100042". */
export function getOrderByNumber(number) {
  return withItems(hydrate(get('SELECT * FROM orders WHERE number = ?', String(number).trim().toUpperCase())));
}

/** Status / payment history: [{ type, from_value, to_value, note, actor, created_at }] oldest first. */
export function getOrderEvents(orderId) {
  return all('SELECT * FROM order_events WHERE order_id = ? ORDER BY id', Number(orderId));
}

/** Statuses the order may move to now, with labels: [{ status, label }]. */
export function allowedTransitions(order) {
  return (TRANSITIONS[order.status] || []).map((status) => ({ status, label: ORDER_STATUS_LABELS[status] }));
}

const dayBound = (date, endOfDay) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
  const ms = Date.parse(`${date}T00:00:00Z`) - config.tzOffsetMinutes * 60000 + (endOfDay ? 86400000 : 0);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

/**
 * Admin / account list, newest first. Each item has items_count (no items[]).
 * @param {object} [f]
 * @param {string} [f.status]  @param {string} [f.paymentStatus]  @param {'product'|'subscription'} [f.kind]
 * @param {string} [f.channel] @param {string} [f.search] number, customer name or phone digits
 * @param {string} [f.from] "YYYY-MM-DD" local day, inclusive  @param {string} [f.to]
 * @param {number} [f.customerId] @param {number} [f.tgUserId]
 * @param {number} [f.limit] default 50  @param {number} [f.offset]
 * @returns {{ items: object[], total: number }}
 */
export function listOrders(f = {}) {
  const where = [];
  const params = [];
  const eq = (col, val) => { where.push(`${col} = ?`); params.push(val); };
  if (f.status && ORDER_STATUSES.includes(f.status)) eq('o.status', f.status);
  if (f.paymentStatus && PAYMENT_STATUSES.includes(f.paymentStatus)) eq('o.payment_status', f.paymentStatus);
  if (f.kind) eq('o.kind', String(f.kind));
  if (f.channel) eq('o.channel', String(f.channel));
  if (f.customerId) eq('o.customer_id', Number(f.customerId));
  if (f.tgUserId) eq('o.tg_user_id', Number(f.tgUserId));
  const from = dayBound(f.from, false);
  const to = dayBound(f.to, true);
  if (from) { where.push('o.created_at >= ?'); params.push(from); }
  if (to) { where.push('o.created_at < ?'); params.push(to); }
  const search = String(f.search || '').trim();
  if (search) {
    const digits = search.replace(/\D/g, '');
    const needle = `%${search.toLocaleLowerCase('ru')}%`;
    const parts = ['ulower(o.number) LIKE ?', 'ulower(o.customer_name) LIKE ?'];
    params.push(needle, needle);
    if (digits.length >= 3) {
      parts.push("REPLACE(REPLACE(o.customer_phone, ' ', ''), '+', '') LIKE ?");
      params.push(`%${digits}%`);
    }
    where.push(`(${parts.join(' OR ')})`);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = get(`SELECT COUNT(*) AS n FROM orders o ${w}`, ...params).n;
  const items = all(
    `SELECT o.*, (SELECT COALESCE(SUM(qty), 0) FROM order_items oi WHERE oi.order_id = o.id) AS items_count
       FROM orders o ${w} ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`,
    ...params, Math.min(500, Number(f.limit) || 50), Number(f.offset) || 0,
  ).map(hydrate);
  return { items, total };
}

/** Orders of a Telegram user with items[], newest first (Mini App "My orders", bot). */
export function listForTgUser(tgUserId, limit = 20) {
  return all('SELECT * FROM orders WHERE tg_user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', Number(tgUserId), Number(limit))
    .map((row) => withItems(hydrate(row)));
}

/** { new: n, pending_payment: n, ... , all: n } */
export function countByStatus() {
  const out = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0]));
  let total = 0;
  for (const r of all('SELECT status, COUNT(*) AS n FROM orders GROUP BY status')) {
    out[r.status] = r.n;
    total += r.n;
  }
  return { ...out, all: total };
}

// ─────────────────────────────── creation

function logEvent(orderId, type, { from = null, to = null, note = '', actor = 'system' } = {}) {
  run('INSERT INTO order_events (order_id, type, from_value, to_value, note, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    orderId, type, from, to, String(note || '').slice(0, 500), actor, now());
}

/**
 * Validate and normalize checkout input. Throws AppError('validation') with details.fields = { field: message }.
 * @returns {{ name, phone, email, method, address, comment }}
 */
export function validateCheckout(input = {}, { requireAddress = true } = {}) {
  const c = input.customer || {};
  const d = input.delivery || {};
  const fields = {};
  const name = clean(c.name, 120);
  if (name.length < 2) fields.name = 'Укажите имя';
  const phone = customers.normalizePhone(c.phone);
  if (!phone) fields.phone = 'Укажите телефон в формате +998 90 123 45 67';
  const email = clean(c.email, 160).toLowerCase();
  if (email && !customers.isEmail(email)) fields.email = 'Проверьте e-mail';
  const method = d.method === 'pickup' ? 'pickup' : 'courier';
  const address = clean(d.address, 300);
  if (method === 'courier' && requireAddress && address.length < 5) fields.address = 'Укажите адрес доставки';
  if (Object.keys(fields).length) {
    throw new AppError('validation', Object.values(fields)[0], 422, { fields });
  }
  return { name, phone, email, method, address: method === 'pickup' ? '' : address, comment: clean(input.comment, 1000) };
}

function insertOrder(o) {
  const ts = now();
  const { lastInsertRowid } = run(
    `INSERT INTO orders (public_token, customer_id, kind, plan_id, status, payment_status, channel, subtotal, delivery_fee,
       discount, total, customer_name, customer_phone, customer_email, delivery_method, delivery_address, comment,
       tg_user_id, session_id, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'new', 'unpaid', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    crypto.randomBytes(16).toString('hex'), o.customerId, o.kind, o.planId ?? null, o.channel, o.subtotal, o.deliveryFee,
    o.subtotal + o.deliveryFee, o.name, o.phone, o.email, o.method, o.address, o.comment,
    o.tgUserId ?? null, o.sessionId ?? null, String(o.source || '').slice(0, 60), ts, ts,
  );
  const id = Number(lastInsertRowid);
  run('UPDATE orders SET number = ? WHERE id = ?', `SC-${100000 + id}`, id);
  return id;
}

function afterCreate(orderId) {
  const order = getOrder(orderId);
  notify.orderCreated(order);
  emit('order.created', { order });
  return order;
}

/**
 * Create a product order from a cart and empty the cart.
 * @param {{ token: string } | { tgUserId: number }} cartRef see services/cart.js
 * @param {object} input
 * @param {{ name: string, phone: string, email?: string }} input.customer
 * @param {{ method?: 'courier'|'pickup', address?: string }} input.delivery address is required for courier
 * @param {string} [input.comment]
 * @param {'site'|'tma'|'bot'} [input.channel] default 'site'
 * @param {string} [input.sessionId] analytics session (req.sessionId) — links the purchase to the funnel
 * @param {string} [input.source] traffic source label (req.traffic.source)
 * @param {number} [input.tgUserId] Telegram user to notify about this order
 * @param {string} [input.tgUsername]
 * @returns {object} order with items[] (status 'new', payment_status 'unpaid')
 * @throws AppError code 'validation' (details.fields) | 'empty_cart' | 'out_of_stock' (details.items)
 */
export function createFromCart(cartRef, input = {}) {
  const v = validateCheckout(input);
  const channel = CHANNELS.includes(input.channel) ? input.channel : 'site';
  const orderId = tx(() => {
    const cart = cartService.getCart(cartRef);
    if (!cart.items.length) throw new AppError('empty_cart', 'Корзина пуста', 409);
    const unavailable = cart.items.filter((i) => !i.available);
    if (unavailable.length) {
      throw new AppError('out_of_stock', `Недостаточно на складе: ${unavailable.map((i) => i.title).join(', ')}`, 409, {
        items: unavailable.map((i) => ({ product_id: i.product_id, title: i.title, stock: i.stock, qty: i.qty })),
      });
    }
    const customer = customers.upsertCustomer({
      name: v.name, phone: v.phone, email: v.email, address: v.address,
      tgUserId: input.tgUserId, tgUsername: input.tgUsername, source: channel === 'admin' ? 'admin' : channel,
    });
    const id = insertOrder({
      customerId: customer.id, kind: 'product', channel, subtotal: cart.subtotal,
      deliveryFee: cartService.calcDelivery(cart.subtotal, v.method),
      name: v.name, phone: v.phone, email: v.email, method: v.method, address: v.address, comment: v.comment,
      tgUserId: input.tgUserId, sessionId: input.sessionId, source: input.source,
    });
    for (const item of cart.items) {
      run('INSERT INTO order_items (order_id, product_id, title, image, price, qty, total) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, item.product_id, item.title, item.image, item.price, item.qty, item.line_total);
    }
    logEvent(id, 'created', { to: 'new', actor: 'customer' });
    cartService.clearCart(cartRef);
    return id;
  });
  return afterCreate(orderId);
}

/**
 * Create an order for a subscription plan (one period, delivery is free).
 * @param {object} input
 * @param {number} input.planId
 * @param {{ name: string, phone: string, email?: string }} input.customer
 * @param {{ method?: 'courier'|'pickup', address?: string }} [input.delivery] address is optional here
 * @param {string} [input.comment] @param {'site'|'tma'|'bot'} [input.channel]
 * @param {string} [input.sessionId] @param {string} [input.source] @param {number} [input.tgUserId] @param {string} [input.tgUsername]
 * @returns {object} order with items[] (kind 'subscription')
 * @throws AppError code 'validation' | 'not_found'
 */
export function createSubscriptionOrder(input = {}) {
  const plan = subscriptions.getPlan(input.planId);
  if (!plan || !plan.active) throw new AppError('not_found', 'План подписки не найден', 404);
  const v = validateCheckout(input, { requireAddress: false });
  const channel = CHANNELS.includes(input.channel) ? input.channel : 'site';
  const orderId = tx(() => {
    const customer = customers.upsertCustomer({
      name: v.name, phone: v.phone, email: v.email, address: v.address,
      tgUserId: input.tgUserId, tgUsername: input.tgUsername, source: channel === 'admin' ? 'admin' : channel,
    });
    const id = insertOrder({
      customerId: customer.id, kind: 'subscription', planId: plan.id, channel, subtotal: plan.price, deliveryFee: 0,
      name: v.name, phone: v.phone, email: v.email, method: v.method, address: v.address, comment: v.comment,
      tgUserId: input.tgUserId, sessionId: input.sessionId, source: input.source,
    });
    run('INSERT INTO order_items (order_id, plan_id, title, image, price, qty, total) VALUES (?, ?, ?, ?, ?, 1, ?)',
      id, plan.id, `Подписка «${plan.title}»`, plan.image, plan.price, plan.price);
    logEvent(id, 'created', { to: 'new', actor: 'customer' });
    return id;
  });
  analytics.trackEvent('subscribe', { channel, sessionId: input.sessionId, tgUserId: input.tgUserId, orderId, value: plan.price });
  return afterCreate(orderId);
}

// ─────────────────────────────── payment results

/**
 * A payment attempt has started with a provider: new → pending_payment, payment_status → pending.
 * Idempotent; no-op for paid/closed orders. Called by payments.startPayment().
 */
export function markPendingPayment(orderId, provider) {
  const row = get('SELECT * FROM orders WHERE id = ?', Number(orderId));
  if (!row) throw notFound('Заказ');
  if (row.payment_status === 'paid' || ['cancelled', 'refunded'].includes(row.status)) return getOrder(row.id);
  if (row.status !== 'pending_payment' || row.payment_status !== 'pending' || row.payment_provider !== provider) {
    tx(() => {
      run(`UPDATE orders SET status = 'pending_payment', payment_status = 'pending', payment_provider = ?, updated_at = ? WHERE id = ?`,
        provider, now(), row.id);
      if (row.status !== 'pending_payment') logEvent(row.id, 'status', { from: row.status, to: 'pending_payment', note: `Провайдер: ${provider}` });
    });
  }
  return getOrder(row.id);
}

/**
 * THE single entry point for a successful payment — every provider, webhook, bot handler and the
 * admin "mark as paid" action must call it. Idempotent: the second call for a paid order changes nothing.
 *
 * Side effects (all in one DB transaction): order → paid, payment row → paid (created or updated),
 * stock decrement for product orders, subscription activation/extension for subscription orders,
 * `purchase` analytics event, history entry. After commit: Telegram notifications to admins and the
 * customer + bus events 'order.paid' (and 'subscription.activated').
 *
 * @param {number} orderId
 * @param {object} [p]
 * @param {string} [p.provider] 'mock' | 'telegram' | 'payme' | 'click' | 'manual'  (default 'manual')
 * @param {string} [p.txId] provider transaction id (matches payments.provider_tx_id)
 * @param {number} [p.paymentId] id of an existing payments row to mark as paid (alternative to txId)
 * @param {number} [p.amount] paid amount in whole sums; when given it MUST equal order.total
 * @param {object} [p.raw] provider payload to store
 * @param {string} [p.actor] history actor, default `provider:<provider>`
 * @returns {{ order: object, changed: boolean, payment: object|null, subscription?: object }}
 * @throws AppError code 'not_found' | 'amount_mismatch' | 'order_closed'
 */
export function markPaid(orderId, { provider = 'manual', txId = null, paymentId = null, amount = null, raw = null, actor = null } = {}) {
  let subscriptionResult = null;
  const result = tx(() => {
    const row = get('SELECT * FROM orders WHERE id = ?', Number(orderId));
    if (!row) throw notFound('Заказ');
    if (row.payment_status === 'paid') {
      const existing = get(`SELECT id FROM payments WHERE order_id = ? AND status = 'paid' ORDER BY id DESC LIMIT 1`, row.id);
      return { changed: false, paymentId: existing?.id ?? null };
    }
    if (['cancelled', 'refunded'].includes(row.status)) {
      throw new AppError('order_closed', 'Заказ отменён и не может быть оплачен', 409);
    }
    if (amount !== null && amount !== undefined && Math.round(Number(amount)) !== row.total) {
      throw new AppError('amount_mismatch', 'Сумма платежа не совпадает с суммой заказа', 409, { expected: row.total, got: amount });
    }
    const ts = now();
    run(`UPDATE orders SET status = 'paid', payment_status = 'paid', payment_provider = ?, paid_at = ?, updated_at = ? WHERE id = ?`,
      provider, ts, ts, row.id);

    // payment row: update the provider's transaction or create one
    let payment = paymentId ? paymentsRepo.getPayment(paymentId) : null;
    if (payment && payment.order_id !== row.id) payment = null;
    if (!payment && txId !== null) payment = paymentsRepo.findByProviderTx(provider, txId);
    if (payment && payment.order_id !== row.id) {
      throw new AppError('tx_conflict', 'Транзакция принадлежит другому заказу', 409);
    }
    if (payment) {
      payment = paymentsRepo.updatePayment(payment.id, {
        status: 'paid', performTime: payment.perform_time ?? Date.now(), ...(raw ? { raw } : {}),
      });
    } else {
      payment = paymentsRepo.createPayment({ orderId: row.id, provider, providerTxId: txId, amount: row.total, status: 'paid', raw: raw || {} });
      paymentsRepo.updatePayment(payment.id, { performTime: Date.now() });
    }

    if (row.kind === 'product') {
      for (const item of all('SELECT product_id, qty FROM order_items WHERE order_id = ? AND product_id IS NOT NULL', row.id)) {
        run('UPDATE products SET stock = MAX(0, stock - ?), updated_at = ? WHERE id = ?', item.qty, ts, item.product_id);
      }
    } else if (row.kind === 'subscription') {
      subscriptionResult = subscriptions.activateFromOrder(row);
    }

    logEvent(row.id, 'payment', { from: row.status, to: 'paid', note: `Оплата: ${provider}${txId ? ` (${txId})` : ''}`, actor: actor || `provider:${provider}` });
    analytics.trackEvent('purchase', {
      channel: row.channel, sessionId: row.session_id, tgUserId: row.tg_user_id, orderId: row.id, value: row.total,
      meta: { provider, kind: row.kind },
    });
    return { changed: true, paymentId: payment.id };
  });

  const order = getOrder(orderId);
  const payment = result.paymentId ? paymentsRepo.getPayment(result.paymentId) : null;
  if (result.changed) {
    notify.orderPaid(order);
    emit('order.paid', { order, payment });
    if (subscriptionResult) {
      notify.subscriptionActivated(subscriptionResult.subscription, order, subscriptionResult.renewed);
      emit('subscription.activated', { ...subscriptionResult, order });
    }
  }
  return { order, changed: result.changed, payment, ...(subscriptionResult ? { subscription: subscriptionResult.subscription } : {}) };
}

/**
 * A payment attempt failed / was declined. The order stays payable (status pending_payment,
 * payment_status 'failed'). No-op for paid orders.
 * @param {number} orderId
 * @param {{ provider?: string, txId?: string, paymentId?: number, reason?: string }} [p]
 * @returns {{ order: object, changed: boolean }}
 */
export function markPaymentFailed(orderId, { provider = null, txId = null, paymentId = null, reason = '' } = {}) {
  const row = get('SELECT * FROM orders WHERE id = ?', Number(orderId));
  if (!row) throw notFound('Заказ');
  if (row.payment_status === 'paid' || ['cancelled', 'refunded'].includes(row.status)) return { order: getOrder(row.id), changed: false };
  tx(() => {
    run(`UPDATE orders SET payment_status = 'failed', updated_at = ? WHERE id = ?`, now(), row.id);
    let payment = paymentId ? paymentsRepo.getPayment(paymentId) : null;
    if (!payment && provider && txId !== null) payment = paymentsRepo.findByProviderTx(provider, txId);
    if (payment && payment.order_id === row.id && payment.status !== 'paid') {
      paymentsRepo.updatePayment(payment.id, { status: 'failed', error: String(reason || '').slice(0, 300) });
    }
    logEvent(row.id, 'payment', { from: row.payment_status, to: 'failed', note: reason || 'Оплата не прошла', actor: provider ? `provider:${provider}` : 'system' });
  });
  const order = getOrder(row.id);
  if (row.payment_status !== 'failed') notify.paymentFailed(order);
  emit('order.payment_failed', { order, reason });
  return { order, changed: true };
}

// ─────────────────────────────── status changes

/**
 * Cancel an UNPAID order. Paid orders must be refunded instead.
 * @param {number} orderId @param {{ actor?: string, reason?: string }} [o]
 * @returns {{ order: object, changed: boolean }}
 * @throws AppError 'paid_order' when the order is already paid
 */
export function cancel(orderId, { actor = 'system', reason = '' } = {}) {
  const row = get('SELECT * FROM orders WHERE id = ?', Number(orderId));
  if (!row) throw notFound('Заказ');
  if (row.status === 'cancelled') return { order: getOrder(row.id), changed: false };
  if (row.payment_status === 'paid') throw new AppError('paid_order', 'Заказ уже оплачен — оформите возврат', 409);
  if (!TRANSITIONS[row.status].includes('cancelled')) throw new AppError('bad_transition', 'Этот заказ нельзя отменить', 409);
  tx(() => {
    const ts = now();
    run(`UPDATE orders SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?`, ts, ts, row.id);
    run(`UPDATE payments SET status = 'cancelled', updated_at = ? WHERE order_id = ? AND status IN ('created', 'pending')`, ts, row.id);
    logEvent(row.id, 'status', { from: row.status, to: 'cancelled', note: reason, actor });
  });
  const order = getOrder(row.id);
  notify.orderStatusChanged(order, row.status, 'cancelled');
  emit('order.status', { order, from: row.status, to: 'cancelled' });
  return { order, changed: true };
}

/**
 * Refund a PAID order: status → refunded, payment → refunded, stock is returned, the subscription
 * period granted by this order is reverted. Idempotent. Moving the money back is the provider's job
 * (Payme CancelTransaction calls this; for other providers refund in the provider cabinet).
 * @param {number} orderId @param {{ actor?: string, reason?: string }} [o]
 * @returns {{ order: object, changed: boolean }}
 */
export function refund(orderId, { actor = 'system', reason = '' } = {}) {
  const row = get('SELECT * FROM orders WHERE id = ?', Number(orderId));
  if (!row) throw notFound('Заказ');
  if (row.status === 'refunded') return { order: getOrder(row.id), changed: false };
  if (row.payment_status !== 'paid') throw new AppError('not_paid', 'Заказ не оплачен — его можно только отменить', 409);
  tx(() => {
    const ts = now();
    run(`UPDATE orders SET status = 'refunded', payment_status = 'refunded', cancelled_at = ?, updated_at = ? WHERE id = ?`, ts, ts, row.id);
    run(`UPDATE payments SET status = 'refunded', updated_at = ? WHERE order_id = ? AND status = 'paid'`, ts, row.id);
    if (row.kind === 'product') {
      for (const item of all('SELECT product_id, qty FROM order_items WHERE order_id = ? AND product_id IS NOT NULL', row.id)) {
        run('UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ?', item.qty, ts, item.product_id);
      }
    } else {
      subscriptions.revertFromOrder(row);
    }
    logEvent(row.id, 'status', { from: row.status, to: 'refunded', note: reason, actor });
  });
  const order = getOrder(row.id);
  notify.orderStatusChanged(order, row.status, 'refunded');
  emit('order.refunded', { order });
  emit('order.status', { order, from: row.status, to: 'refunded' });
  return { order, changed: true };
}

/**
 * Move an order to another status (admin action). Validates the status machine and dispatches:
 *   'paid' → markPaid(provider 'manual'), 'cancelled' → cancel(), 'refunded' → refund(),
 *   everything else → plain status update + customer notification.
 * @param {number} orderId @param {string} status
 * @param {{ actor?: string, note?: string }} [o] actor e.g. `admin:3`
 * @returns {{ order: object, changed: boolean }}
 * @throws AppError 'bad_transition'
 */
export function setStatus(orderId, status, { actor = 'system', note = '' } = {}) {
  const row = get('SELECT * FROM orders WHERE id = ?', Number(orderId));
  if (!row) throw notFound('Заказ');
  if (row.status === status) return { order: getOrder(row.id), changed: false };
  if (!ORDER_STATUSES.includes(status) || !TRANSITIONS[row.status].includes(status)) {
    throw new AppError('bad_transition', `Нельзя перевести заказ из «${ORDER_STATUS_LABELS[row.status]}» в «${ORDER_STATUS_LABELS[status] || status}»`, 409);
  }
  if (status === 'paid') {
    const r = markPaid(row.id, { provider: 'manual', actor });
    return { order: r.order, changed: r.changed };
  }
  if (status === 'cancelled') return cancel(row.id, { actor, reason: note });
  if (status === 'refunded') return refund(row.id, { actor, reason: note });
  if (status === 'pending_payment') {
    return { order: markPendingPayment(row.id, row.payment_provider || 'manual'), changed: true };
  }
  tx(() => {
    run('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', status, now(), row.id);
    logEvent(row.id, 'status', { from: row.status, to: status, note, actor });
  });
  const order = getOrder(row.id);
  notify.orderStatusChanged(order, row.status, status);
  emit('order.status', { order, from: row.status, to: status });
  return { order, changed: true };
}

/** Add a free-form note to the order history. */
export function addNote(orderId, note, actor = 'system') {
  if (!get('SELECT 1 AS x FROM orders WHERE id = ?', Number(orderId))) throw notFound('Заказ');
  logEvent(Number(orderId), 'note', { note, actor });
}

/** Save the internal admin note of an order. */
export function setAdminNote(orderId, text) {
  run('UPDATE orders SET admin_note = ?, updated_at = ? WHERE id = ?', clean(text, 2000), now(), Number(orderId));
  return getOrder(orderId);
}

/**
 * Link an order placed without Telegram (site checkout) to a Telegram user, so the customer gets
 * status notifications in the bot and sees the order in "Мои заказы". Only orders that have no
 * Telegram user yet can be linked — the caller (BOT module) must first verify that the user owns
 * the order (phone confirmed with a shared Telegram contact).
 * @param {number} orderId @param {number} tgUserId
 * @returns {boolean} true when the order was linked by this call
 */
export function attachTgUser(orderId, tgUserId) {
  const id = Number(tgUserId);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  const { changes } = run('UPDATE orders SET tg_user_id = ?, updated_at = ? WHERE id = ? AND tg_user_id IS NULL', id, now(), Number(orderId));
  if (changes > 0) logEvent(Number(orderId), 'note', { note: `Заказ привязан к Telegram (id ${id})`, actor: 'customer' });
  return changes > 0;
}
