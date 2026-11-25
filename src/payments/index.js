// Payment provider registry + the single entry point that starts a payment.
//
// PROVIDER INTERFACE — every file in ./providers default-exports an object:
// {
//   id: 'mock' | 'telegram' | 'payme' | 'click',
//   title: 'Человеческое название',                       // shown in the admin and at checkout
//   isConfigured(): boolean,                              // are the credentials present (and is it allowed here)?
//   async createPayment(order, ctx): Promise<{ redirectUrl?: string, invoiceLink?: string }>,
//       order — full order from orders.getOrder() (total in whole sums, items[], public_token, …)
//       ctx   — { returnUrl: string (absolute, already validated), channel: 'site'|'tma'|'bot', tgUserId?: number }
//       redirectUrl → the browser must be redirected there (hosted checkout page)
//       invoiceLink → Telegram invoice link for WebApp.openInvoice() / the "pay in Telegram" page
// }
// Provider callbacks (Payme JSON-RPC, Click prepare/complete, the mock form) are mounted by ./routes.js.
//
// RULES
//   * A provider never changes orders itself. Success → orders.markPaid(order.id, { provider, txId, amount }),
//     failure → orders.markPaymentFailed(), refund → orders.refund(). All three are idempotent, so an
//     order is paid exactly once no matter how many providers or duplicate callbacks report it.
//   * Every attempt is a row of `payments` (services/payments.js): created when the customer is sent
//     to the provider, then driven by the provider's callbacks.
//   * The customer's return never decides anything: /pay/return/<token> reads the state from the DB.
//   * Telegram invoice payload convention: "order:<orderId>"; the shared helpers (buildInvoice,
//     validatePreCheckout, handleSuccessfulPayment) are in services/telegramPayments.js.
// Adding a provider: docs/PAYMENTS.md, section «Как добавить провайдера».
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { bus } from '../lib/bus.js';
import * as settings from '../services/settings.js';
import * as orders from '../services/orders.js';
import { invoicePayload, parseInvoicePayload } from '../services/telegramPayments.js';
import { closeSupersededAttempts, isChargeable, orderStatusUrl, providerReturnUrl, safeReturnUrl } from './common.js';
import { paymentLog } from './log.js';
import mock from './providers/mock.js';
import telegram, { buildInvoiceParams } from './providers/telegram.js';
import payme from './providers/payme.js';
import click from './providers/click.js';

const providers = new Map();

/** Add (or replace) a provider. */
export function registerProvider(provider) {
  if (!provider?.id || typeof provider.createPayment !== 'function' || typeof provider.isConfigured !== 'function') {
    throw new Error('Invalid payment provider');
  }
  providers.set(provider.id, provider);
  return provider;
}

registerProvider(mock);
registerProvider(telegram);
registerProvider(payme);
registerProvider(click);

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
 * "mock"; in production that is an error (never give goods away for free) — the mock provider
 * itself reports "not configured" there unless ALLOW_MOCK_PAYMENTS=1.
 */
export function resolveProvider(preferredId = null) {
  for (const id of [preferredId, activeProviderId()]) {
    const provider = id ? providers.get(id) : null;
    if (provider && provider.isConfigured()) return provider;
  }
  const fallback = providers.get('mock');
  if (!config.isProd && fallback?.isConfigured()) return fallback;
  throw new AppError('payment_unavailable', 'Онлайн-оплата временно недоступна. Свяжитесь с нами — оформим заказ вручную.', 503);
}

export { orderStatusUrl, safeReturnUrl, providerReturnUrl };

// Telegram invoice helpers: payload convention (services/telegramPayments.js, shared with the bot)
// and the sendInvoice / createInvoiceLink parameters of an order.
export { invoicePayload, parseInvoicePayload, buildInvoiceParams };

/**
 * Start a payment for an order with the active (or given) provider — the ONE entry point used by
 * the site (/pay/order/<token>), the Mini App and the bot's "pay" links.
 * The order is re-read from the database (the caller's copy is never trusted), must be payable and
 * have a positive whole total; then it is marked pending_payment and handed to the provider, which
 * records the attempt in `payments`.
 * @param {object} order from orders.getOrder()/getOrderByToken()
 * @param {{ returnUrl?: string, channel?: string, tgUserId?: number, providerId?: string }} [ctx]
 *   returnUrl — same-site path or URL under BASE_URL (anything else → the order status page)
 * @returns {Promise<{ provider: string, redirectUrl?: string, invoiceLink?: string }>}
 * @throws AppError 'not_found' | 'already_paid' | 'order_closed' | 'amount_invalid' | 'payment_unavailable';
 *         provider errors (e.g. TelegramError) are passed through
 */
export async function startPayment(order, ctx = {}) {
  const current = order?.id ? orders.getOrder(order.id) : null;
  if (!current) throw new AppError('not_found', 'Заказ не найден', 404);
  if (current.payment_status === 'paid') throw new AppError('already_paid', 'Заказ уже оплачен', 409);
  if (!current.can_pay) throw new AppError('order_closed', 'Этот заказ нельзя оплатить', 409);
  if (!isChargeable(current)) throw new AppError('amount_invalid', 'Сумма заказа некорректна — оплата невозможна', 409);

  const provider = resolveProvider(ctx.providerId);
  const fresh = orders.markPendingPayment(current.id, provider.id);
  const channel = ctx.channel || fresh.channel;
  let result;
  try {
    result = await provider.createPayment(fresh, {
      returnUrl: safeReturnUrl(ctx.returnUrl, fresh),
      channel,
      tgUserId: ctx.tgUserId ?? fresh.tg_user_id ?? undefined,
    });
  } catch (err) {
    paymentLog('start_failed', { level: 'error', provider: provider.id, order: fresh.id, number: fresh.number, channel, message: err.message });
    throw err;
  }
  if (!result || (!result.redirectUrl && !result.invoiceLink)) {
    paymentLog('start_failed', { level: 'error', provider: provider.id, order: fresh.id, number: fresh.number, channel, message: 'provider returned nothing' });
    throw new AppError('payment_unavailable', 'Не удалось начать оплату. Попробуйте ещё раз чуть позже.', 502);
  }
  paymentLog('start', { provider: provider.id, order: fresh.id, number: fresh.number, amount: fresh.total, currency: config.payments.currency, channel });
  return { provider: provider.id, ...result };
}

// When an order gets paid, every other attempt that is still open is closed (see common.js).
bus.on('order.paid', ({ order, payment }) => {
  if (order?.id) closeSupersededAttempts(order.id, payment?.id ?? null);
});
