// "click" provider — Click SHOP API (click.uz, Uzbekistan).
//
// 1. PAY URL  createPayment() → redirect to
//      https://my.click.uz/services/pay?service_id=…&merchant_id=…&amount=N.NN&transaction_param=<order id>&return_url=…
// 2. CALLBACKS (form-encoded POST from Click, answered with JSON, HTTP 200 in every case)
//      POST /pay/click/prepare   action=0  → { click_trans_id, merchant_trans_id, merchant_prepare_id, error, error_note }
//      POST /pay/click/complete  action=1  → { click_trans_id, merchant_trans_id, merchant_confirm_id, error, error_note }
//    sign_string = md5(click_trans_id + service_id + SECRET_KEY + merchant_trans_id
//                      [+ merchant_prepare_id — complete only] + amount + action + sign_time)
//
// Transaction = one row of `payments` (provider 'click'): provider_tx_id = click_trans_id,
// merchant_prepare_id = merchant_confirm_id = payments.id, status pending → paid | cancelled.
// merchant_trans_id (transaction_param) = orders.id. Amounts are whole sums.
//
// Answers:  0 Success · -1 SIGN CHECK FAILED! · -2 Incorrect parameter amount · -3 Action not found
//          -4 Already paid · -5 User does not exist (order not found) · -6 Transaction does not exist
//          -7 Failed to update user (our internal error) · -8 Error in request from click · -9 Transaction cancelled
//   -4 at Complete means exactly "this transaction was confirmed earlier" (a repeated Complete of the
//   transaction that paid the order). A Complete for an order paid by ANOTHER payment is answered with
//   -9 (and reported to the admins): that charge must be reversed, not kept.
//   Out of stock (stock is not reserved by unpaid orders): Prepare and Complete answer -9.
// Money effects never happen here: a successful Complete → orders.markPaid(); a Complete that carries
// error < 0 (Click could not charge the card) cancels the transaction and leaves the order payable.
import crypto from 'node:crypto';
import { config } from '../../config.js';
import { AppError } from '../../lib/errors.js';
import { escapeTg } from '../../lib/escape.js';
import { formatSum } from '../../lib/money.js';
import * as orders from '../../services/orders.js';
import * as paymentsRepo from '../../services/payments.js';
import * as notify from '../../services/notify.js';
import { findOpenAttempt, findOrderByRef, isChargeable, providerReturnUrl, recordAttempt, safeEqual } from '../common.js';
import { paymentLog } from '../log.js';

export const ACTION = Object.freeze({ PREPARE: 0, COMPLETE: 1 });
export const ERROR = Object.freeze({
  SUCCESS: 0,
  SIGN_CHECK_FAILED: -1,
  INCORRECT_AMOUNT: -2,
  ACTION_NOT_FOUND: -3,
  ALREADY_PAID: -4,
  ORDER_NOT_FOUND: -5,
  TRANSACTION_NOT_FOUND: -6,
  UPDATE_FAILED: -7,
  BAD_REQUEST: -8,
  TRANSACTION_CANCELLED: -9,
});
const NOTES = {
  [ERROR.SUCCESS]: 'Success',
  [ERROR.SIGN_CHECK_FAILED]: 'SIGN CHECK FAILED!',
  [ERROR.INCORRECT_AMOUNT]: 'Incorrect parameter amount',
  [ERROR.ACTION_NOT_FOUND]: 'Action not found',
  [ERROR.ALREADY_PAID]: 'Already paid',
  [ERROR.ORDER_NOT_FOUND]: 'User does not exist',
  [ERROR.TRANSACTION_NOT_FOUND]: 'Transaction does not exist',
  [ERROR.UPDATE_FAILED]: 'Failed to update user',
  [ERROR.BAD_REQUEST]: 'Error in request from click',
  [ERROR.TRANSACTION_CANCELLED]: 'Transaction cancelled',
};

const PAY_URL = 'https://my.click.uz/services/pay';
const cfg = () => config.payments.click;

export function isConfigured() {
  return Boolean(cfg().serviceId && cfg().merchantId && cfg().secretKey);
}

// ─────────────────────────────── pay URL

/** Click payment page URL for an order. `returnUrl` is where Click sends the customer afterwards. */
export function payUrl(order, returnUrl = providerReturnUrl(order)) {
  const query = new URLSearchParams({
    service_id: cfg().serviceId,
    merchant_id: cfg().merchantId,
    amount: `${order.total}.00`,
    transaction_param: String(order.id),
    return_url: returnUrl,
  });
  if (cfg().merchantUserId) query.set('merchant_user_id', cfg().merchantUserId);
  return `${PAY_URL}?${query.toString()}`;
}

// ─────────────────────────────── signature

const text = (v) => (v === undefined || v === null ? '' : String(v));

/**
 * md5 signature of a callback. Values are concatenated exactly as they arrived (strings).
 * @param {object} p request fields
 * @param {{ complete?: boolean, secretKey?: string }} [o]
 */
export function signString(p, { complete = false, secretKey = cfg().secretKey } = {}) {
  const parts = [text(p.click_trans_id), text(p.service_id), secretKey, text(p.merchant_trans_id)];
  if (complete) parts.push(text(p.merchant_prepare_id));
  parts.push(text(p.amount), text(p.action), text(p.sign_time));
  return crypto.createHash('md5').update(parts.join(''), 'utf8').digest('hex');
}

// ─────────────────────────────── callbacks

class ClickError extends Error {
  constructor(code) {
    super(NOTES[code] || 'Error');
    this.code = code;
  }
}
const fail = (code) => new ClickError(code);
const echoId = (v) => (/^\d{1,15}$/.test(text(v)) ? Number(v) : text(v));
const amountMatches = (order, amount) => /^\d+(\.\d+)?$/.test(text(amount).trim()) && Math.abs(Number(amount) - order.total) < 0.01;

const REQUIRED = ['click_trans_id', 'service_id', 'merchant_trans_id', 'amount', 'action', 'sign_time', 'sign_string'];

/** Checks shared by both callbacks, in the order Click documents them. Returns the order. */
function verify(body, action) {
  const complete = action === ACTION.COMPLETE;
  for (const name of complete ? [...REQUIRED, 'merchant_prepare_id'] : REQUIRED) {
    if (typeof body[name] === 'object' || text(body[name]).trim() === '') throw fail(ERROR.BAD_REQUEST);
  }
  if (!isConfigured() || !safeEqual(signString(body, { complete }), text(body.sign_string).trim().toLowerCase())) {
    throw fail(ERROR.SIGN_CHECK_FAILED);
  }
  if (text(body.service_id) !== cfg().serviceId) throw fail(ERROR.BAD_REQUEST);
  if (text(body.action) !== String(action)) throw fail(ERROR.ACTION_NOT_FOUND);
  const order = findOrderByRef(body.merchant_trans_id);
  if (!order) throw fail(ERROR.ORDER_NOT_FOUND);
  return order;
}

const cancelPayment = (p, note) => paymentsRepo.updatePayment(p.id, { status: 'cancelled', cancelTime: Date.now(), error: String(note || '').slice(0, 300) });

/**
 * A Complete for an order that another payment has already paid: close this transaction and — when
 * Click reports that it did charge the customer — tell the staff once, because that money has to go
 * back (Click reverses a transaction we answer with -9; the cabinet shows whether it did).
 */
function refuseDuplicate(order, payment, charged) {
  if (payment.status === 'pending' || payment.status === 'created') cancelPayment(payment, 'Заказ уже оплачен другим платежом');
  if (!charged || payment.raw?.duplicate_reported) return;
  paymentsRepo.updatePayment(payment.id, { raw: { duplicate_reported: true } });
  paymentLog('click.duplicate_charge', { level: 'error', order: order.id, number: order.number, click_trans_id: payment.provider_tx_id });
  try {
    orders.addNote(order.id, `Click: повторное списание по уже оплаченному заказу (транзакция ${payment.provider_tx_id}) отклонено, деньги должны вернуться покупателю`, 'provider:click');
  } catch { /* the note is best-effort */ }
  notify.notifyAdmins([
    '⚠️ <b>Click: второе списание по уже оплаченному заказу</b>',
    `Заказ ${escapeTg(order.number)} · ${formatSum(payment.amount)}`,
    `Транзакция Click: <code>${escapeTg(payment.provider_tx_id)}</code>`,
    'Мы отклонили её (код -9) — Click должен вернуть деньги покупателю. Проверьте в кабинете Click, что возврат прошёл.',
  ].join('\n'));
}

function prepare(body) {
  const order = verify(body, ACTION.PREPARE);
  const clickTransId = text(body.click_trans_id);
  const existing = paymentsRepo.findByProviderTx('click', clickTransId);
  if (existing && existing.order_id !== order.id) throw fail(ERROR.BAD_REQUEST);
  if (existing?.status === 'paid' || order.is_paid) throw fail(ERROR.ALREADY_PAID);
  if (!amountMatches(order, body.amount)) throw fail(ERROR.INCORRECT_AMOUNT);
  if (existing && existing.status !== 'pending') throw fail(ERROR.TRANSACTION_CANCELLED);
  if (!order.can_pay || !isChargeable(order)) throw fail(ERROR.TRANSACTION_CANCELLED);
  // stock is not reserved by unpaid orders: do not let Click charge for goods that ran out
  if (orders.stockShortage(order).length) throw fail(ERROR.TRANSACTION_CANCELLED);
  if (existing) return { merchant_prepare_id: existing.id }; // repeated Prepare: the same answer

  const fields = {
    providerTxId: clickTransId,
    status: 'pending',
    amount: order.total,
    createTime: Date.now(),
    raw: { click_paydoc_id: text(body.click_paydoc_id) || null, sign_time: text(body.sign_time) },
  };
  // Adopt the attempt recorded when the customer left for Click (it carries the return URL);
  // a payment started inside the Click app has none — create the row.
  const attempt = findOpenAttempt(order.id, 'click');
  const payment = attempt
    ? paymentsRepo.updatePayment(attempt.id, fields)
    : paymentsRepo.createPayment({ orderId: order.id, provider: 'click', ...fields });
  orders.markPendingPayment(order.id, 'click');
  return { merchant_prepare_id: payment.id };
}

function complete(body) {
  const order = verify(body, ACTION.COMPLETE);
  const prepareId = text(body.merchant_prepare_id).trim();
  const payment = /^\d{1,15}$/.test(prepareId) ? paymentsRepo.getPayment(Number(prepareId)) : null;
  if (!payment || payment.provider !== 'click' || payment.order_id !== order.id || payment.provider_tx_id !== text(body.click_trans_id)) {
    throw fail(ERROR.TRANSACTION_NOT_FOUND);
  }
  const confirm = { merchant_confirm_id: payment.id };
  // -4 is reserved for ONE case: Click repeats the Complete of the transaction that paid the order
  // (it did not get our first answer). The payment stands, nothing is done twice.
  if (payment.status === 'paid') throw Object.assign(fail(ERROR.ALREADY_PAID), { extra: confirm });
  const clickError = Number(body.error ?? 0);
  const charged = Number.isFinite(clickError) && clickError >= 0;
  if (order.is_paid) {
    // The order was paid by ANOTHER payment meanwhile (a second Click transaction, another provider,
    // "mark as paid" in the panel). This transaction must not be kept: it is cancelled and answered
    // with -9, never with -4 — "already paid" would tell Click that this very charge was accepted.
    refuseDuplicate(order, payment, charged);
    throw fail(ERROR.TRANSACTION_CANCELLED);
  }
  if (!amountMatches(order, body.amount)) throw fail(ERROR.INCORRECT_AMOUNT);
  if (payment.status !== 'pending') throw fail(ERROR.TRANSACTION_CANCELLED);
  if (!order.can_pay) {
    cancelPayment(payment, 'Заказ отменён');
    throw fail(ERROR.TRANSACTION_CANCELLED);
  }

  if (!charged) {
    // Click could not finish the payment on its side (no funds, the customer gave up, …)
    cancelPayment(payment, `Click: ${text(body.error_note).trim() || 'платёж отменён'} (код ${text(body.error)})`);
    if (order.payment_provider === 'click' && order.payment_status === 'pending') {
      orders.markPaymentFailed(order.id, { provider: 'click', reason: 'Click не смог провести платёж' });
    }
    throw fail(ERROR.TRANSACTION_CANCELLED);
  }

  if (orders.stockShortage(order).length) {
    // the goods ran out between Prepare and Complete: refuse, Click returns the money
    cancelPayment(payment, 'Товар закончился до подтверждения платежа');
    if (order.payment_provider === 'click' && order.payment_status === 'pending') {
      orders.markPaymentFailed(order.id, { provider: 'click', reason: 'Товар закончился — оплата отменена, деньги вернутся' });
    }
    throw fail(ERROR.TRANSACTION_CANCELLED);
  }

  try {
    const result = orders.markPaid(order.id, {
      provider: 'click',
      paymentId: payment.id,
      txId: payment.provider_tx_id,
      amount: payment.amount,
      raw: { click_paydoc_id: text(body.click_paydoc_id) || payment.raw?.click_paydoc_id || null },
    });
    if (!result.changed) {
      refuseDuplicate(order, payment, true);
      throw fail(ERROR.TRANSACTION_CANCELLED);
    }
  } catch (err) {
    if (err instanceof ClickError) throw err;
    if (!(err instanceof AppError)) throw err;
    cancelPayment(payment, err.message);
    throw fail(err.code === 'amount_mismatch' ? ERROR.INCORRECT_AMOUNT : ERROR.TRANSACTION_CANCELLED);
  }
  return confirm;
}

function handle(name, fn, body) {
  const started = Date.now();
  const input = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const base = { click_trans_id: echoId(input.click_trans_id), merchant_trans_id: text(input.merchant_trans_id) };
  let response;
  try {
    response = { ...base, ...fn(input), error: ERROR.SUCCESS, error_note: NOTES[ERROR.SUCCESS] };
  } catch (err) {
    if (!(err instanceof ClickError)) console.error(`[payments] click ${name}: unexpected error`, err);
    const code = err instanceof ClickError ? err.code : ERROR.UPDATE_FAILED; // internal failure: Click repeats the call
    response = { ...base, ...(err.extra || {}), error: code, error_note: NOTES[code] };
  }
  paymentLog(`click.${name}`, {
    click_trans_id: base.click_trans_id,
    click_paydoc_id: text(input.click_paydoc_id) || undefined,
    order: base.merchant_trans_id,
    amount: text(input.amount) || undefined,
    click_error: text(input.error) || undefined,
    prepare_id: response.merchant_prepare_id,
    confirm_id: response.merchant_confirm_id,
    error: response.error,
    ms: Date.now() - started,
  });
  return response;
}

/** POST /pay/click/prepare — never throws; returns the JSON answer for Click. */
export const handlePrepare = (body) => handle('prepare', prepare, body);
/** POST /pay/click/complete — never throws; returns the JSON answer for Click. */
export const handleComplete = (body) => handle('complete', complete, body);

// ─────────────────────────────── provider

export default {
  id: 'click',
  title: 'Click',
  isConfigured,

  async createPayment(order, ctx) {
    // The Click transaction appears with the Prepare callback; until then this row records the
    // attempt and keeps the customer's return URL.
    recordAttempt(order, 'click', { status: 'created', raw: { returnUrl: ctx.returnUrl, channel: ctx.channel } });
    return { redirectUrl: payUrl(order) };
  },
};
