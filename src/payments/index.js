// Payment provider registry.
//
// PROVIDER INTERFACE — every file in ./providers exports an object:
// {
//   id: 'mock' | 'telegram' | 'payme' | 'click',
//   title: 'Человеческое название',                       // shown in the admin and at checkout
//   isConfigured(): boolean,                              // are the credentials present?
//   async createPayment(order, ctx): Promise<{ redirectUrl?: string, invoiceLink?: string }>,
//       order — full order from orders.getOrder() (total in whole sums, items[], public_token, …)
//       ctx   — { returnUrl: string (absolute, already validated), channel: 'site'|'tma'|'bot', tgUserId?: number }
//       redirectUrl → the browser must be redirected there (hosted checkout page)
//       invoiceLink → Telegram invoice link for WebApp.openInvoice() / a t.me URL
//   // optional, provider specific: handleCallback(req, res) mounted by ./routes.js
// }
//
// RULES
//   * A provider never changes orders itself. Success → orders.markPaid(order.id, { provider, txId, amount }),
//     failure → orders.markPaymentFailed(), refund → orders.refund(). All three are idempotent.
//   * Transactions are stored through services/payments.js (table `payments`).
//   * Telegram invoice payload convention: "order:<orderId>"; the shared helpers (buildInvoice, createInvoiceLink,
//     validatePreCheckout, handleSuccessfulPayment) are in services/telegramPayments.js.
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';
import * as settings from '../services/settings.js';
import * as orders from '../services/orders.js';
import { invoicePayload, parseInvoicePayload } from '../services/telegramPayments.js';
import mock from './providers/mock.js';

const providers = new Map();

/** Add (or replace) a provider. */
export function registerProvider(provider) {
  if (!provider?.id || typeof provider.createPayment !== 'function') throw new Error('Invalid payment provider');
  providers.set(provider.id, provider);
  return provider;
}

registerProvider(mock);
// PAYMENTS module: import and register telegram / payme / click providers here.

export function getProvider(id) {
  return providers.get(id) || null;
}

/** [{ id, title, configured, active }] */
export function listProviders() {
  const active = activeProviderId();
  return [...providers.values()].map((p) => ({ id: p.id, title: p.title, configured: Boolean(p.isConfigured()), active: p.id === active }));
}

/** Provider id selected by the `payment_provider` setting (Admin → Settings) or PAYMENT_PROVIDER env. */
export function activeProviderId() {
  return settings.get('payment_provider', '') || config.payments.provider;
}

/**
 * Resolve the provider to use: the preferred one (e.g. "telegram" for the Mini App) when it is
 * configured, otherwise the active one. Outside production an unconfigured choice falls back to
 * "mock"; in production that is an error (never give goods away for free).
 */
export function resolveProvider(preferredId = null) {
  for (const id of [preferredId, activeProviderId()]) {
    const provider = id ? providers.get(id) : null;
    if (provider && provider.isConfigured()) return provider;
  }
  if (!config.isProd && providers.get('mock')) return providers.get('mock');
  throw new AppError('payment_unavailable', 'Онлайн-оплата временно недоступна. Свяжитесь с нами — оформим заказ вручную.', 503);
}

/** Default return URL: the public order status page. */
export const orderStatusUrl = (order) => `${config.baseUrl}/order/${order.public_token}`;

/**
 * Validate a user-supplied return URL (open-redirect protection): only same-site paths
 * ("/tma/#/orders/5") or absolute URLs under BASE_URL are accepted; anything else → order status page.
 */
export function safeReturnUrl(candidate, order) {
  const c = String(candidate || '');
  if (/^\/(?![/\\])/.test(c) && !/[\r\n]/.test(c)) return `${config.baseUrl}${c}`;
  if (c.startsWith(`${config.baseUrl}/`)) return c;
  return orderStatusUrl(order);
}

// Telegram invoice payload helpers live in services/telegramPayments.js (shared with the bot).
export { invoicePayload, parseInvoicePayload };

/**
 * Start a payment for an order with the active (or given) provider.
 * Marks the order pending_payment and returns what the client has to do next.
 * @param {object} order from orders.getOrder()/getOrderByToken()
 * @param {{ returnUrl?: string, channel?: string, tgUserId?: number, providerId?: string }} [ctx]
 * @returns {Promise<{ provider: string, redirectUrl?: string, invoiceLink?: string }>}
 * @throws AppError 'already_paid' | 'order_closed' | 'payment_unavailable'
 */
export async function startPayment(order, ctx = {}) {
  if (!order) throw new AppError('not_found', 'Заказ не найден', 404);
  if (order.payment_status === 'paid') throw new AppError('already_paid', 'Заказ уже оплачен', 409);
  if (!order.can_pay) throw new AppError('order_closed', 'Этот заказ нельзя оплатить', 409);
  const provider = resolveProvider(ctx.providerId);
  const fresh = orders.markPendingPayment(order.id, provider.id);
  const result = await provider.createPayment(fresh, {
    returnUrl: safeReturnUrl(ctx.returnUrl, fresh),
    channel: ctx.channel || fresh.channel,
    tgUserId: ctx.tgUserId ?? fresh.tg_user_id ?? undefined,
  });
  return { provider: provider.id, ...result };
}
