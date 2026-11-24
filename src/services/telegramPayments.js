// Telegram Payments glue shared by three modules, so they agree on one contract:
//   PAYMENTS  → the "telegram" provider calls createInvoiceLink(order)
//   MINI APP  → gets that link from payments.startPayment() and opens it with WebApp.openInvoice()
//   BOT       → answers pre_checkout_query with validatePreCheckout() and passes
//               message.successful_payment to handleSuccessfulPayment()
// Invoice payload convention: "order:<orderId>". Amounts are in tiyin (UZS × 100).
import { config } from '../config.js';
import * as tg from '../lib/telegramApi.js';
import { sumToTiyin, tiyinToSum } from '../lib/money.js';
import { truncate } from '../lib/escape.js';
import * as orders from './orders.js';

/** Telegram invoice payload for an order. */
export const invoicePayload = (orderId) => `order:${orderId}`;

/** "order:42" → 42 (null when the payload is not ours). */
export function parseInvoicePayload(payload) {
  const m = /^order:(\d+)$/.exec(String(payload || ''));
  return m ? Number(m[1]) : null;
}

/** True when BOT_TOKEN and TELEGRAM_PAYMENT_TOKEN are both set. */
export function isConfigured() {
  return Boolean(config.bot.token && config.payments.telegram.providerToken);
}

/**
 * Invoice parameters for sendInvoice / createInvoiceLink.
 * prices are itemized (order lines + delivery) and always sum up to order.total in tiyin.
 * @param {object} order from orders.getOrder()
 */
export function buildInvoice(order) {
  const prices = order.items.map((item) => ({
    label: truncate(item.qty > 1 ? `${item.title} × ${item.qty}` : item.title, 60),
    amount: sumToTiyin(item.total),
  }));
  if (order.delivery_fee > 0) prices.push({ label: 'Доставка', amount: sumToTiyin(order.delivery_fee) });
  if (order.discount > 0) prices.push({ label: 'Скидка', amount: -sumToTiyin(order.discount) });
  return {
    title: `Заказ ${order.number}`,
    description: truncate(order.items.map((i) => (i.qty > 1 ? `${i.title} × ${i.qty}` : i.title)).join(', '), 250) || `Заказ ${order.number}`,
    payload: invoicePayload(order.id),
    provider_token: config.payments.telegram.providerToken,
    currency: config.payments.currency,
    prices,
  };
}

/** Create an invoice link (https://t.me/$...) for an order. Throws TelegramError. */
export function createInvoiceLink(order) {
  const { provider_token: providerToken, ...rest } = buildInvoice(order);
  return tg.createInvoiceLink({ ...rest, providerToken });
}

/**
 * Check a pre_checkout_query before Telegram charges the customer.
 * @param {{ invoice_payload: string, currency: string, total_amount: number }} query
 * @returns {{ ok: true, order: object } | { ok: false, errorMessage: string }}
 *   → bot: answerPreCheckoutQuery(query.id, ok, { error_message: errorMessage })
 */
export function validatePreCheckout(query) {
  const orderId = parseInvoicePayload(query?.invoice_payload);
  const order = orderId ? orders.getOrder(orderId) : null;
  if (!order) return { ok: false, errorMessage: 'Заказ не найден. Оформите его заново, пожалуйста.' };
  if (order.payment_status === 'paid') return { ok: false, errorMessage: 'Этот заказ уже оплачен.' };
  if (!order.can_pay) return { ok: false, errorMessage: 'Заказ отменён и не может быть оплачен.' };
  if (query.currency !== config.payments.currency || Number(query.total_amount) !== sumToTiyin(order.total)) {
    return { ok: false, errorMessage: 'Сумма заказа изменилась. Откройте заказ и оплатите ещё раз.' };
  }
  return { ok: true, order };
}

/**
 * Apply message.successful_payment. Idempotent (delegates to orders.markPaid).
 * @param {{ invoice_payload: string, currency: string, total_amount: number, telegram_payment_charge_id: string, provider_payment_charge_id?: string }} payment
 * @returns {{ ok: true, order: object, changed: boolean } | { ok: false, reason: 'bad_payload'|'not_found'|'amount_mismatch'|'order_closed' }}
 */
export function handleSuccessfulPayment(payment) {
  const orderId = parseInvoicePayload(payment?.invoice_payload);
  if (!orderId) return { ok: false, reason: 'bad_payload' };
  let amount;
  try {
    amount = tiyinToSum(payment.total_amount);
  } catch {
    return { ok: false, reason: 'amount_mismatch' };
  }
  try {
    const result = orders.markPaid(orderId, {
      provider: 'telegram',
      txId: payment.telegram_payment_charge_id,
      amount,
      raw: { provider_payment_charge_id: payment.provider_payment_charge_id || null, currency: payment.currency },
    });
    return { ok: true, order: result.order, changed: result.changed };
  } catch (err) {
    if (['not_found', 'amount_mismatch', 'order_closed'].includes(err.code)) return { ok: false, reason: err.code };
    throw err;
  }
}
