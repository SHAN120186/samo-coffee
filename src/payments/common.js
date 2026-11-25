// Helpers shared by the registry, the routes and the providers (kept out of index.js so that the
// providers never import the registry — no import cycles).
import crypto from 'node:crypto';
import { config } from '../config.js';
import * as orders from '../services/orders.js';
import * as paymentsRepo from '../services/payments.js';

/** Default return URL: the public order status page. */
export const orderStatusUrl = (order) => `${config.baseUrl}/order/${order.public_token}`;

/**
 * URL we hand to the external providers (Payme `c=`, Click `return_url`). It is OUR handler:
 * it ignores whatever the provider appends to the query string, reads the real state from the DB
 * and only then sends the customer to the stored return URL of the attempt.
 */
export const providerReturnUrl = (order) => `${config.baseUrl}/pay/return/${order.public_token}`;

/**
 * Validate a user-supplied return URL (open-redirect protection): only same-site paths
 * ("/tma/#/orders/5") or absolute URLs under BASE_URL are accepted; anything else → order status page.
 */
export function safeReturnUrl(candidate, order) {
  const c = String(candidate || '');
  if (/^\/(?![/\\])/.test(c) && !/[\r\n]/.test(c)) return `${config.baseUrl}${c}`;
  if (c.startsWith(`${config.baseUrl}/`) && !/[\r\n]/.test(c)) return c;
  return orderStatusUrl(order);
}

/** Constant-time string comparison (both sides are hashed first, so lengths never leak). */
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Resolve the order a provider callback talks about. The contract is `orders.id`; the human order
 * number ("SC-100042") is accepted too, so a customer can pay "by order number" inside the Payme /
 * Click apps.
 * @param {unknown} ref value of the provider's account field / merchant_trans_id
 * @returns {object|null}
 */
export function findOrderByRef(ref) {
  const value = String(ref ?? '').trim();
  if (!value || value.length > 40) return null;
  if (/^\d{1,15}$/.test(value)) return orders.getOrder(Number(value));
  if (/^[A-Za-z]{1,4}-\d{1,12}$/.test(value)) return orders.getOrderByNumber(value);
  return null;
}

/** Is the order total something a provider can charge? (whole positive sums) */
export const isChargeable = (order) => Number.isSafeInteger(order?.total) && order.total > 0;

/**
 * Checkout attempt of a redirect-based provider (Payme, Click) that the provider has not picked up
 * yet: a row without a provider transaction id. One open attempt per order and provider is kept.
 */
export function findOpenAttempt(orderId, provider) {
  return paymentsRepo.listByOrder(orderId)
    .find((p) => p.provider === provider && !p.provider_tx_id && (p.status === 'created' || p.status === 'pending')) || null;
}

/**
 * Record a checkout attempt (reusing the open one, so page reloads do not pile up rows).
 * @returns {object} payments row
 */
export function recordAttempt(order, provider, { status = 'created', raw = {} } = {}) {
  const open = findOpenAttempt(order.id, provider);
  if (open) return paymentsRepo.updatePayment(open.id, { amount: order.total, status, raw });
  return paymentsRepo.createPayment({ orderId: order.id, provider, amount: order.total, status, raw });
}

/**
 * The order has been paid: close every other attempt that is still open, so exactly one payment
 * row per order is ever "paid" and nothing looks payable afterwards. Payme transactions in state 1
 * are left alone — they are closed through the Merchant API protocol (PerformTransaction is refused
 * and the transaction is cancelled there).
 * @returns {number} how many rows were closed
 */
export function closeSupersededAttempts(orderId, paidPaymentId = null) {
  let closed = 0;
  for (const p of paymentsRepo.listByOrder(orderId)) {
    if (p.id === paidPaymentId || (p.status !== 'created' && p.status !== 'pending')) continue;
    if (p.provider === 'payme' && p.state === 1) continue;
    paymentsRepo.updatePayment(p.id, { status: 'cancelled', cancelTime: Date.now(), error: 'Закрыт: заказ оплачен другим платежом' });
    closed += 1;
  }
  return closed;
}
