// Paying for an order from the bot.
//   TELEGRAM_PAYMENT_TOKEN set  → sendInvoice (payload "order:<id>", UZS, amounts in tiyin) →
//                                 pre_checkout_query → successful_payment → orders.markPaid('telegram')
//   no payment token            → a button (or a plain link in local development) to the hosted
//                                 payment page /pay/order/<token>, which uses the active provider
import { config } from '../../config.js';
import * as orders from '../../services/orders.js';
import * as catalog from '../../services/catalog.js';
import * as notify from '../../services/notify.js';
import * as telegramPayments from '../../services/telegramPayments.js';
import { escapeTg } from '../../lib/escape.js';
import { formatSum } from '../../lib/money.js';
import { cb, inline, siteUrl, urlButton } from '../keyboards.js';
import { clearState, getState, STATES } from '../state.js';
import * as texts from '../texts.js';

const log = (...args) => { if (!config.isTest) console.warn(...args); };

/** Hosted payment page: a button when Telegram accepts the URL, otherwise the link as text. */
async function sendPaymentLink(ctx, order) {
  const url = siteUrl(order.pay_url);
  const button = urlButton(`💳 Оплатить ${formatSum(order.total)}`, url);
  await ctx.reply(texts.paymentLinkText(order, url, { asButton: Boolean(button) }), {
    reply_markup: inline([[button], [cb('📦 Мои заказы', 'orders!')]]),
  });
  return { via: 'link', url };
}

/**
 * Ask the customer to pay an order: a Telegram invoice when Telegram Payments is configured,
 * the hosted payment page otherwise (also the fallback when Telegram refuses the invoice).
 * @returns {Promise<{ via: 'invoice' | 'link', url?: string }>}
 */
export async function sendPayment(ctx, order) {
  if (!telegramPayments.isConfigured()) return sendPaymentLink(ctx, order);
  const invoice = telegramPayments.buildInvoice(order);
  try {
    await ctx.reply(texts.invoiceIntro(order));
    await ctx.api.sendInvoice(ctx.chat.id, invoice.title, invoice.description, invoice.payload, invoice.currency, invoice.prices, {
      provider_token: invoice.provider_token,
      start_parameter: `order_${order.number}`.replace(/[^\w-]/g, ''),
    });
    orders.markPendingPayment(order.id, 'telegram');
    return { via: 'invoice' };
  } catch (err) {
    // e.g. PAYMENT_PROVIDER_INVALID, CURRENCY_TOTAL_AMOUNT_INVALID — the customer still has to be able to pay
    log(`[bot] sendInvoice failed for ${order.number}: ${err.description || err.message}`);
    return sendPaymentLink(ctx, order);
  }
}

/** Product orders: do not charge for goods that ran out while the invoice was waiting. */
function checkStock(order) {
  if (order.kind !== 'product') return null;
  for (const item of order.items) {
    if (!item.product_id) continue;
    const product = catalog.getProduct(item.product_id);
    if (!product || product.stock < item.qty) {
      return `«${item.title}» только что закончился. Напишите нам — подберём замену или сообщим о новой обжарке.`;
    }
  }
  return null;
}

/** pre_checkout_query: the last check before Telegram charges the customer (must be answered within 10 s). */
export async function onPreCheckoutQuery(ctx) {
  let verdict;
  try {
    verdict = telegramPayments.validatePreCheckout(ctx.preCheckoutQuery);
    if (verdict.ok) {
      const stockError = checkStock(verdict.order);
      if (stockError) verdict = { ok: false, errorMessage: stockError };
    }
  } catch (err) {
    console.error('[bot] pre_checkout validation failed:', err);
    verdict = { ok: false, errorMessage: 'Не удалось проверить заказ. Попробуйте ещё раз через минуту.' };
  }
  if (verdict.ok) await ctx.answerPreCheckoutQuery(true);
  else await ctx.answerPreCheckoutQuery(false, { error_message: verdict.errorMessage.slice(0, 200) });
}

/**
 * message.successful_payment → orders.markPaid (through telegramPayments.handleSuccessfulPayment).
 * Idempotent: a re-delivered update changes nothing. The "order paid" messages for the customer and
 * the admins are sent by the notify service.
 */
export async function onSuccessfulPayment(ctx) {
  const payment = ctx.message.successful_payment;
  const payer = ctx.from;
  const orderId = telegramPayments.parseInvoicePayload(payment.invoice_payload);

  // An invoice opened from a link (site / Mini App) may belong to an order without a Telegram user:
  // the payer becomes the one who gets the notifications.
  if (orderId && payer && !payer.is_bot && ctx.chat.type === 'private') {
    const order = orders.getOrder(orderId);
    if (order && !order.tg_user_id) orders.attachTgUser(order.id, payer.id);
  }

  let result;
  try {
    result = telegramPayments.handleSuccessfulPayment(payment);
  } catch (err) {
    console.error('[bot] successful_payment handling failed:', err);
    result = { ok: false, reason: 'error' };
  }

  if (result.ok) {
    if (payer && getState(payer.id).state === STATES.checkout) clearState(payer.id);
    return result;
  }

  // The money has been taken but the order could not be marked as paid — people must look at it.
  await notify.notifyAdmins([
    '⚠️ <b>Платёж в Telegram требует проверки</b>',
    `Причина: <code>${escapeTg(result.reason)}</code>`,
    `Payload: <code>${escapeTg(payment.invoice_payload)}</code>`,
    `Сумма: ${escapeTg(String(payment.total_amount / 100))} ${escapeTg(payment.currency)}`,
    `Charge id: <code>${escapeTg(payment.telegram_payment_charge_id)}</code>`,
    payer ? `Плательщик: ${escapeTg([payer.first_name, payer.last_name].filter(Boolean).join(' '))}${payer.username ? ` @${escapeTg(payer.username)}` : ''} · id <code>${payer.id}</code>` : null,
  ].filter(Boolean).join('\n'));
  await ctx.reply('Мы получили платёж, но не смогли автоматически привязать его к заказу. Уже разбираемся — напишем вам в этот чат.');
  return result;
}
