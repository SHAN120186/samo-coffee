// "telegram" provider: Telegram Bot Payments (the money is charged by the provider connected in
// @BotFather → Payments: Click, Payme, a test provider, …).
//
//   createPayment → Bot API createInvoiceLink → { invoiceLink: 'https://t.me/$…' }
//     Mini App : Telegram.WebApp.openInvoice(invoiceLink)
//     site     : /pay/invoice/<token> — "pay in Telegram" page with the link (see ../routes.js)
//     bot      : sendInvoice with buildInvoiceParams(order) (BOT module)
//   Telegram → bot: pre_checkout_query  → telegramPayments.validatePreCheckout()
//                   successful_payment  → telegramPayments.handleSuccessfulPayment() → orders.markPaid()
//
// Invoice: payload "order:<id>", currency UZS, prices in tiyin (sum × 100) that add up to order.total.
// An invoice link can be opened any number of times, so the amount and the order state are checked
// again at pre_checkout time — a paid or cancelled order is refused there.
import { config } from '../../config.js';
import * as tg from '../../lib/telegramApi.js';
import { sumToTiyin } from '../../lib/money.js';
import { AppError } from '../../lib/errors.js';
import * as paymentsRepo from '../../services/payments.js';
import * as telegramPayments from '../../services/telegramPayments.js';
import { recordAttempt } from '../common.js';

/**
 * Invoice parameters for sendInvoice / createInvoiceLink (Bot API field names).
 * @param {object} order from orders.getOrder()
 * @param {{ needPhone?: boolean }} [options] needPhone → need_phone_number (default: TELEGRAM_PAYMENT_NEED_PHONE)
 * @returns {{ title: string, description: string, payload: string, provider_token: string, currency: string,
 *             prices: { label: string, amount: number }[], need_phone_number?: boolean }}
 * @throws AppError 'amount_mismatch' when the itemized prices do not add up to the order total
 */
export function buildInvoiceParams(order, { needPhone = config.payments.telegram.needPhone } = {}) {
  const invoice = telegramPayments.buildInvoice(order);
  const total = invoice.prices.reduce((sum, p) => sum + p.amount, 0);
  if (!Number.isSafeInteger(total) || total <= 0 || total !== sumToTiyin(order.total)) {
    throw new AppError('amount_mismatch', 'Сумма счёта не совпадает с суммой заказа', 409, { expected: sumToTiyin(order.total), got: total });
  }
  return {
    ...invoice,
    title: String(invoice.title).slice(0, 32),
    description: String(invoice.description).slice(0, 255),
    currency: config.payments.currency,
    ...(needPhone ? { need_phone_number: true } : {}),
  };
}

export default {
  id: 'telegram',
  title: 'Telegram Payments',
  isConfigured: () => telegramPayments.isConfigured(),

  /** @returns {Promise<{ invoiceLink: string }>} throws TelegramError when the Bot API refuses the invoice */
  async createPayment(order, ctx) {
    const { provider_token: providerToken, ...params } = buildInvoiceParams(order);
    const attempt = recordAttempt(order, 'telegram', {
      status: 'pending',
      raw: { payload: params.payload, returnUrl: ctx.returnUrl, channel: ctx.channel, invoiceLink: null },
    });
    let invoiceLink;
    try {
      invoiceLink = await tg.createInvoiceLink({ ...params, providerToken });
    } catch (err) {
      paymentsRepo.updatePayment(attempt.id, { status: 'failed', error: `Telegram: ${err.description || err.message}`.slice(0, 300) });
      throw err; // the Mini App falls back to the hosted page of the active provider
    }
    if (typeof invoiceLink !== 'string' || !/^https:\/\/t\.me\//.test(invoiceLink)) {
      paymentsRepo.updatePayment(attempt.id, { status: 'failed', error: 'Telegram вернул некорректную ссылку на счёт' });
      throw new Error('Telegram returned an invalid invoice link'); // not an AppError → callers may fall back
    }
    paymentsRepo.updatePayment(attempt.id, { raw: { invoiceLink } });
    return { invoiceLink };
  },
};
