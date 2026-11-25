// Starting a payment from the Mini App.
//   1. Telegram invoice (WebApp.openInvoice) when Telegram Payments is configured and the client can show it.
//   2. Otherwise the hosted payment page of the active provider (mock / payme / click).
// Money never changes state here: the result always arrives through orders.markPaid() — called by the
// bot (successful_payment), a provider webhook or the mock checkout page.
import { AppError } from '../lib/errors.js';
import { config } from '../config.js';
import * as orders from '../services/orders.js';
import * as telegramPayments from '../services/telegramPayments.js';
import * as registry from '../payments/index.js';

/** Is the native Telegram invoice available on the server side? */
export function invoiceAvailable() {
  return telegramPayments.isConfigured();
}

async function createTelegramInvoice(order, ctx) {
  const provider = registry.getProvider('telegram');
  if (provider && provider.isConfigured()) {
    const result = await registry.startPayment(order, { ...ctx, providerId: 'telegram' });
    return { provider: result.provider, invoiceLink: result.invoiceLink, redirectUrl: result.redirectUrl };
  }
  // The "telegram" provider is not registered in the payments registry: build the link with the shared
  // helper directly (same payload convention "order:<id>", so the bot handlers accept the payment).
  const fresh = orders.markPendingPayment(order.id, 'telegram');
  const invoiceLink = await telegramPayments.createInvoiceLink(fresh);
  return { provider: 'telegram', invoiceLink };
}

/**
 * @param {object} order from orders.getOrder()
 * @param {{ tgUserId: number, preferInvoice?: boolean, returnToApp?: boolean }} options
 *   preferInvoice — the client runs inside Telegram and supports WebApp.openInvoice
 *   returnToApp   — the hosted page should return into the Mini App (browser preview) instead of the
 *                   public order status page (Telegram opens hosted pages in an external browser)
 * @returns {Promise<{ provider: string, invoiceLink?: string, redirectUrl?: string }>}
 * @throws AppError 'already_paid' | 'order_closed' | 'payment_unavailable'
 */
export async function startTmaPayment(order, { tgUserId, preferInvoice = true, returnToApp = false } = {}) {
  if (!order) throw new AppError('not_found', 'Заказ не найден', 404);
  if (order.payment_status === 'paid') throw new AppError('already_paid', 'Заказ уже оплачен', 409);
  if (!order.can_pay) throw new AppError('order_closed', 'Этот заказ нельзя оплатить', 409);

  const ctx = {
    channel: 'tma',
    tgUserId,
    returnUrl: returnToApp ? `/tma/#/pay/${order.id}` : undefined,
  };

  if (preferInvoice && invoiceAvailable()) {
    try {
      const result = await createTelegramInvoice(order, ctx);
      if (result.invoiceLink || result.redirectUrl) return compact(result);
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Telegram is unreachable or rejected the invoice → fall back to the hosted page.
      if (!config.isTest) console.warn(`[tma] invoice link failed, using the hosted page: ${err.message}`);
    }
  }
  return compact(await registry.startPayment(orders.getOrder(order.id), ctx));
}

function compact({ provider, invoiceLink, redirectUrl }) {
  return { provider, ...(invoiceLink ? { invoiceLink } : {}), ...(redirectUrl ? { redirectUrl } : {}) };
}
