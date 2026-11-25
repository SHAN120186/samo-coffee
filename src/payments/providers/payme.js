// "payme" provider — Payme Business (Paycom, Uzbekistan).
//
// 1. CHECKOUT  createPayment() → redirect to
//      https://checkout.paycom.uz/<base64("m=<merchant_id>;ac.<account_field>=<order id>;a=<tiyin>;c=<return url>")>
//      (https://checkout.test.paycom.uz while PAYME_TEST=1)
// 2. MERCHANT API  POST /pay/payme — JSON-RPC 2.0 called by Payme, HTTP Basic auth "Paycom:<PAYME_KEY>".
//      handleRpc() below implements the whole protocol and ALWAYS answers with a JSON-RPC object
//      (HTTP 200): CheckPerformTransaction, CreateTransaction, PerformTransaction, CancelTransaction,
//      CheckTransaction, GetStatement.
//
// Transaction = one row of `payments` (provider 'payme'):
//   provider_tx_id  Payme transaction id          state   1 created · 2 performed · -1 cancelled · -2 cancelled after perform
//   create_time     our clock, ms                 reason  Payme cancel reason (1, 2, 3, 4 = timeout, 5 = refund, 10)
//   perform_time / cancel_time, ms                raw     { payme_time (Payme's clock), account, returnUrl, channel }
//   status          pending (1) · paid (2) · cancelled (-1) · refunded (-2)
//
// Rules of the protocol that are easy to get wrong:
//   * every method is idempotent by the Payme transaction id — a repeated call returns the same answer;
//   * one order holds at most ONE transaction in state 1; a second CreateTransaction gets -31099;
//   * a transaction that stays in state 1 longer than 12 hours is cancelled with reason 4 and can no
//     longer be performed (-31008);
//   * money effects never happen here: PerformTransaction → orders.markPaid(), CancelTransaction of a
//     performed transaction → orders.refund() (refused with -31007 once the order has been shipped).
// Amounts: Payme speaks tiyin, the database whole sums.
import { config } from '../../config.js';
import { tx } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import { sumToTiyin, tiyinToSum } from '../../lib/money.js';
import * as orders from '../../services/orders.js';
import * as paymentsRepo from '../../services/payments.js';
import { findOpenAttempt, findOrderByRef, isChargeable, providerReturnUrl, recordAttempt, safeEqual } from '../common.js';
import { paymentLog } from '../log.js';

/** A created transaction must be performed within 12 hours. */
export const TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const STATE = Object.freeze({ CREATED: 1, PERFORMED: 2, CANCELLED: -1, CANCELLED_AFTER_PERFORM: -2 });
export const REASON = Object.freeze({ RECEIVERS_NOT_FOUND: 1, PROCESSING_ERROR: 2, EXECUTION_ERROR: 3, TIMEOUT: 4, REFUND: 5, UNKNOWN: 10 });
export const ERROR = Object.freeze({
  NOT_POST: -32300,
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  AUTH: -32504,
  INTERNAL: -32400,
  WRONG_AMOUNT: -31001,
  TX_NOT_FOUND: -31003,
  CANNOT_CANCEL: -31007,
  CANNOT_PERFORM: -31008,
  // -31050 … -31099: errors of the customer's account (our order)
  ORDER_NOT_FOUND: -31050,
  ORDER_PAID: -31051,
  ORDER_CLOSED: -31052,
  OUT_OF_STOCK: -31053,
  ORDER_BUSY: -31099,
});

/** Order statuses in which a performed transaction may still be cancelled (money returned). */
const REFUNDABLE_STATUSES = ['paid', 'processing'];
const DAY_MS = 24 * 60 * 60 * 1000;

const MESSAGES = {
  not_post: [ERROR.NOT_POST, 'Запрос должен быть отправлен методом POST', 'So‘rov POST usuli bilan yuborilishi kerak', 'The request must be sent with the POST method'],
  parse: [ERROR.PARSE, 'Ошибка разбора JSON', 'JSON tahlilida xatolik', 'JSON parse error'],
  invalid_request: [ERROR.INVALID_REQUEST, 'В запросе отсутствуют обязательные поля или их тип неверен', 'So‘rovda majburiy maydonlar yo‘q yoki ularning turi noto‘g‘ri', 'Required fields are missing or have a wrong type'],
  method_not_found: [ERROR.METHOD_NOT_FOUND, 'Запрашиваемый метод не найден', 'So‘ralgan usul topilmadi', 'The requested method was not found'],
  auth: [ERROR.AUTH, 'Недостаточно привилегий для выполнения метода', 'Usulni bajarish uchun huquqlar yetarli emas', 'Insufficient privileges to perform the method'],
  internal: [ERROR.INTERNAL, 'Внутренняя ошибка сервера', 'Serverning ichki xatosi', 'Internal server error'],
  wrong_amount: [ERROR.WRONG_AMOUNT, 'Неверная сумма платежа', 'To‘lov summasi noto‘g‘ri', 'Incorrect payment amount'],
  tx_not_found: [ERROR.TX_NOT_FOUND, 'Транзакция не найдена', 'Tranzaksiya topilmadi', 'Transaction not found'],
  cannot_cancel: [ERROR.CANNOT_CANCEL, 'Заказ выполнен, отменить транзакцию невозможно', 'Buyurtma bajarilgan, tranzaksiyani bekor qilib bo‘lmaydi', 'The order is fulfilled, the transaction cannot be cancelled'],
  cannot_perform: [ERROR.CANNOT_PERFORM, 'Невозможно выполнить операцию', 'Amalni bajarib bo‘lmaydi', 'Unable to perform the operation'],
  tx_expired: [ERROR.CANNOT_PERFORM, 'Срок ожидания оплаты истёк, транзакция отменена', 'To‘lovni kutish muddati tugadi, tranzaksiya bekor qilindi', 'The payment timed out, the transaction is cancelled'],
  order_not_found: [ERROR.ORDER_NOT_FOUND, 'Заказ не найден', 'Buyurtma topilmadi', 'Order not found'],
  order_paid: [ERROR.ORDER_PAID, 'Заказ уже оплачен', 'Buyurtma allaqachon to‘langan', 'The order is already paid'],
  order_closed: [ERROR.ORDER_CLOSED, 'Заказ отменён и не может быть оплачен', 'Buyurtma bekor qilingan, uni to‘lab bo‘lmaydi', 'The order is cancelled and cannot be paid'],
  out_of_stock: [ERROR.OUT_OF_STOCK, 'Товар из заказа закончился, оплата невозможна', 'Buyurtmadagi mahsulot tugadi, to‘lab bo‘lmaydi', 'An item of the order is out of stock, the order cannot be paid'],
  order_busy: [ERROR.ORDER_BUSY, 'По заказу уже есть платёж, ожидающий подтверждения', 'Buyurtma bo‘yicha tasdiqlanishi kutilayotgan to‘lov mavjud', 'Another payment for this order is awaiting confirmation'],
};

/** Protocol error → JSON-RPC `error` member. */
export class PaymeError extends Error {
  constructor(key, data = undefined) {
    const [code, ru, uz, en] = MESSAGES[key] || MESSAGES.internal;
    super(en);
    this.name = 'PaymeError';
    this.key = key;
    this.code = code;
    this.rpcMessage = { ru, uz, en };
    this.data = data;
  }
}
const fail = (key, data) => new PaymeError(key, data);

const cfg = () => config.payments.payme;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function isConfigured() {
  return Boolean(cfg().merchantId && cfg().key);
}

// ─────────────────────────────── checkout

/** Hosted Payme checkout URL for an order. `returnUrl` is where Payme sends the customer afterwards. */
export function checkoutUrl(order, returnUrl = providerReturnUrl(order)) {
  const { merchantId, accountField, test } = cfg();
  const params = `m=${merchantId};ac.${accountField}=${order.id};a=${sumToTiyin(order.total)};c=${returnUrl}`;
  const host = test ? 'https://checkout.test.paycom.uz' : 'https://checkout.paycom.uz';
  return `${host}/${Buffer.from(params, 'utf8').toString('base64')}`;
}

// ─────────────────────────────── authorization

/** Check the `Authorization: Basic base64("Paycom:<key>")` header in constant time. */
export function checkAuth(header) {
  const key = cfg().key;
  if (!key) return false;
  const m = /^Basic[ \t]+([A-Za-z0-9+/=_-]+)[ \t]*$/i.exec(String(header || ''));
  if (!m) return false;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  return safeEqual(decoded, `Paycom:${key}`);
}

// ─────────────────────────────── transactions

const isTx = (p) => Boolean(p && p.provider === 'payme' && p.provider_tx_id);
const isExpired = (p, at = Date.now()) => p.state === STATE.CREATED && at - Number(p.create_time || 0) > TIMEOUT_MS;

/** The transaction in state 1 that currently holds the order (or null). */
function findActiveTx(orderId) {
  return paymentsRepo.listByOrder(orderId).find((p) => isTx(p) && p.state === STATE.CREATED) || null;
}

function cancelTx(p, reason, state = STATE.CANCELLED) {
  return paymentsRepo.updatePayment(p.id, {
    state,
    status: state === STATE.CANCELLED ? 'cancelled' : 'refunded',
    reason,
    cancelTime: Date.now(),
  });
}

/** A pending Payme payment fell through: the order becomes payable again (and the customer is told). */
function releaseOrder(orderId, note) {
  try {
    const order = orders.getOrder(orderId);
    if (order && order.can_pay && order.payment_provider === 'payme' && order.payment_status === 'pending') {
      orders.markPaymentFailed(order.id, { provider: 'payme', reason: note });
    }
  } catch (err) {
    paymentLog('payme.release_failed', { level: 'error', order: orderId, message: err.message });
  }
}

const createResult = (p) => ({ create_time: p.create_time, transaction: String(p.id), state: p.state });
const performResult = (p) => ({ transaction: String(p.id), perform_time: p.perform_time || 0, state: p.state });
const cancelResult = (p) => ({ transaction: String(p.id), cancel_time: p.cancel_time || 0, state: p.state });
const checkResult = (p) => ({
  create_time: p.create_time || 0,
  perform_time: p.perform_time || 0,
  cancel_time: p.cancel_time || 0,
  transaction: String(p.id),
  state: p.state,
  reason: p.reason ?? null,
});

// ─────────────────────────────── parameter checks

function requireTxId(params) {
  if (typeof params.id !== 'string' || !params.id.trim() || params.id.length > 64) throw fail('invalid_request', 'id');
  return params.id;
}

function requireInt(params, name) {
  const v = params[name];
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw fail('invalid_request', name);
  return v;
}

function requireTx(params) {
  const p = paymentsRepo.findByProviderTx('payme', requireTxId(params));
  if (!isTx(p)) throw fail('tx_not_found');
  return p;
}

function requireAmount(params) {
  if (typeof params.amount !== 'number' || !Number.isFinite(params.amount)) throw fail('invalid_request', 'amount');
  return params.amount;
}

/** account → order, or the "order not found" account error. */
function resolveOrder(params) {
  const field = cfg().accountField;
  if (!isObject(params.account)) throw fail('invalid_request', 'account');
  const order = findOrderByRef(params.account[field]);
  if (!order) throw fail('order_not_found', field);
  return order;
}

/** Can this order be paid right now with this amount (tiyin)? Throws the matching protocol error. */
function assertPayable(order, amount) {
  const field = cfg().accountField;
  if (order.is_paid) throw fail('order_paid', field);
  if (!order.can_pay || !isChargeable(order)) throw fail('order_closed', field);
  if (!Number.isSafeInteger(amount) || amount !== sumToTiyin(order.total)) throw fail('wrong_amount', 'amount');
  // stock is not reserved by unpaid orders: refuse before Payme charges for goods that ran out
  if (orders.stockShortage(order).length) throw fail('out_of_stock', field);
  const active = findActiveTx(order.id);
  if (active) {
    if (!isExpired(active)) throw fail('order_busy', field);
    cancelTx(active, REASON.TIMEOUT); // nobody finished it in 12 hours — free the order
  }
}

// ─────────────────────────────── methods

function checkPerformTransaction(params) {
  const amount = requireAmount(params);
  const order = resolveOrder(params);
  assertPayable(order, amount);
  return { allow: true, additional: { order: order.number } };
}

function createTransaction(params) {
  const txId = requireTxId(params);
  const time = requireInt(params, 'time');
  const amount = requireAmount(params);
  if (!isObject(params.account)) throw fail('invalid_request', 'account');

  const existing = paymentsRepo.findByProviderTx('payme', txId);
  if (isTx(existing)) {
    if (existing.state !== STATE.CREATED) throw fail('cannot_perform');
    if (isExpired(existing)) {
      cancelTx(existing, REASON.TIMEOUT);
      releaseOrder(existing.order_id, 'Payme: истекло время ожидания оплаты');
      throw fail('tx_expired');
    }
    if (amount !== sumToTiyin(existing.amount)) throw fail('wrong_amount', 'amount');
    return createResult(existing);
  }

  const order = resolveOrder(params);
  assertPayable(order, amount);
  if (time <= 0 || Date.now() - time > TIMEOUT_MS) throw fail('tx_expired', 'time');

  const fields = {
    providerTxId: txId,
    state: STATE.CREATED,
    status: 'pending',
    amount: tiyinToSum(amount),
    createTime: Date.now(),
    raw: { payme_time: time, account: { [cfg().accountField]: String(params.account[cfg().accountField]) } },
  };
  // The customer normally comes from our checkout redirect: adopt that attempt row (it carries the
  // return URL). A payment started inside the Payme app has no attempt — create the row.
  const attempt = findOpenAttempt(order.id, 'payme');
  const created = attempt
    ? paymentsRepo.updatePayment(attempt.id, fields)
    : paymentsRepo.createPayment({ orderId: order.id, provider: 'payme', ...fields });
  orders.markPendingPayment(order.id, 'payme');
  return createResult(created);
}

function performTransaction(params) {
  const p = requireTx(params);
  if (p.state === STATE.PERFORMED) return performResult(p);
  if (p.state !== STATE.CREATED) throw fail('cannot_perform');
  if (isExpired(p)) {
    cancelTx(p, REASON.TIMEOUT);
    releaseOrder(p.order_id, 'Payme: истекло время ожидания оплаты');
    throw fail('tx_expired');
  }

  const order = orders.getOrder(p.order_id);
  if (order?.is_paid && p.status === 'paid') {
    // The order was marked paid by this very transaction but the process stopped before the state
    // was saved — finish the bookkeeping, do not charge or fulfil anything twice.
    return performResult(paymentsRepo.updatePayment(p.id, { state: STATE.PERFORMED, performTime: p.perform_time ?? Date.now() }));
  }
  if (!order || order.is_paid || !order.can_pay) {
    // Paid in another way or cancelled meanwhile: refuse, Payme returns the money to the customer.
    cancelTx(p, REASON.EXECUTION_ERROR);
    throw fail('cannot_perform');
  }
  if (orders.stockShortage(order).length) {
    // the goods ran out after CreateTransaction: refuse, Payme returns the money to the customer
    cancelTx(p, REASON.EXECUTION_ERROR);
    releaseOrder(p.order_id, 'Товар закончился — оплата отменена, деньги вернутся');
    throw fail('cannot_perform');
  }
  try {
    // markPaid and "state 2" are committed together: a stop between the two can no longer leave a
    // transaction that paid the order but still looks cancellable as "not performed".
    return tx(() => {
      const result = orders.markPaid(order.id, { provider: 'payme', paymentId: p.id, txId: p.provider_tx_id, amount: p.amount });
      if (!result.changed) throw new AppError('already_paid', 'Заказ уже оплачен', 409);
      return performResult(paymentsRepo.updatePayment(p.id, { state: STATE.PERFORMED }));
    });
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    cancelTx(p, REASON.EXECUTION_ERROR);
    throw fail('cannot_perform');
  }
}

function cancelTransaction(params) {
  const p = requireTx(params);
  const reason = requireInt(params, 'reason');

  // A transaction that already paid the order counts as performed even if its state was not saved
  // (rows written before markPaid and the state were committed together): cancelling it is a REFUND,
  // otherwise Payme would return the money while the order stays paid and fulfilled.
  const performed = p.state === STATE.PERFORMED || (p.state === STATE.CREATED && p.status === 'paid');
  if (p.state === STATE.CREATED && !performed) {
    const cancelled = cancelTx(p, reason, STATE.CANCELLED);
    releaseOrder(p.order_id, `Payme отменил платёж (причина ${reason})`);
    return cancelResult(cancelled);
  }
  if (performed) {
    const order = orders.getOrder(p.order_id);
    if (!order) throw fail('cannot_cancel');
    if (order.status !== 'refunded') {
      if (!REFUNDABLE_STATUSES.includes(order.status)) throw fail('cannot_cancel');
      try {
        orders.refund(order.id, { actor: 'provider:payme', reason: `Возврат через Payme (причина ${reason})` });
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        throw fail('cannot_cancel');
      }
    }
    return cancelResult(cancelTx(p, reason, STATE.CANCELLED_AFTER_PERFORM));
  }
  return cancelResult(p); // cancelled earlier: the same answer again
}

function checkTransaction(params) {
  return checkResult(requireTx(params));
}

function getStatement(params) {
  const from = requireInt(params, 'from');
  const to = requireInt(params, 'to');
  if (from < 0 || to < from) throw fail('invalid_request', 'to');
  // The period is about Payme's own creation time (the `time` of CreateTransaction). Rows are indexed
  // by our create_time, which differs by the delivery delay only — select with a margin, filter exactly.
  const transactions = paymentsRepo.listByProviderBetween('payme', Math.max(0, from - DAY_MS), to + DAY_MS)
    .filter((p) => isTx(p) && Number.isFinite(p.raw?.payme_time) && p.raw.payme_time >= from && p.raw.payme_time <= to)
    .sort((a, b) => a.raw.payme_time - b.raw.payme_time || a.id - b.id)
    .map((p) => ({
      id: p.provider_tx_id,
      time: p.raw.payme_time,
      amount: sumToTiyin(p.amount),
      account: p.raw.account || { [cfg().accountField]: String(p.order_id) },
      create_time: p.create_time || 0,
      perform_time: p.perform_time || 0,
      cancel_time: p.cancel_time || 0,
      transaction: String(p.id),
      state: p.state,
      reason: p.reason ?? null,
    }));
  return { transactions };
}

const METHODS = {
  CheckPerformTransaction: checkPerformTransaction,
  CreateTransaction: createTransaction,
  PerformTransaction: performTransaction,
  CancelTransaction: cancelTransaction,
  CheckTransaction: checkTransaction,
  GetStatement: getStatement,
};
export const METHOD_NAMES = Object.keys(METHODS);

// ─────────────────────────────── JSON-RPC entry point

/** A bare protocol error answer (used by the HTTP layer for requests that never reach handleRpc). */
export function errorResponse(key, id = null) {
  const e = fail(key);
  return { jsonrpc: '2.0', id, error: { code: e.code, message: e.rpcMessage } };
}

/**
 * Process one Merchant API request. Never throws; the returned object is the HTTP response body
 * (status 200 in every case, as the protocol requires).
 * @param {{ body?: unknown, parseError?: boolean, authorization?: string, httpMethod?: string }} input
 *   body — the parsed JSON document; parseError — the body was not valid JSON
 * @returns {{ jsonrpc: '2.0', id: unknown, result?: object, error?: { code: number, message: { ru: string, uz: string, en: string }, data?: string } }}
 */
export function handleRpc({ body, parseError = false, authorization = '', httpMethod = 'POST' } = {}) {
  const started = Date.now();
  const id = isObject(body) && ['string', 'number'].includes(typeof body.id) ? body.id : null;
  const method = isObject(body) && typeof body.method === 'string' ? body.method : null;
  const params = isObject(body) && isObject(body.params) ? body.params : null;
  let response;
  try {
    if (String(httpMethod).toUpperCase() !== 'POST') throw fail('not_post');
    if (parseError || body === undefined) throw fail('parse');
    if (!checkAuth(authorization)) throw fail('auth');
    if (!isObject(body) || !method) throw fail('invalid_request', 'method');
    if (!Object.hasOwn(METHODS, method)) throw fail('method_not_found', method);
    if (!params) throw fail('invalid_request', 'params');
    response = { jsonrpc: '2.0', id, result: METHODS[method](params) };
  } catch (err) {
    const e = err instanceof PaymeError ? err : fail('internal');
    if (!(err instanceof PaymeError)) {
      console.error('[payments] payme: unexpected error', err);
    }
    response = { jsonrpc: '2.0', id, error: { code: e.code, message: e.rpcMessage, ...(e.data !== undefined ? { data: e.data } : {}) } };
  }
  paymentLog('payme.rpc', {
    method,
    rpc_id: id,
    tx: typeof params?.id === 'string' ? params.id : undefined,
    account: isObject(params?.account) ? params.account : undefined,
    amount: typeof params?.amount === 'number' ? params.amount : undefined,
    reason: typeof params?.reason === 'number' ? params.reason : undefined,
    ok: !response.error,
    code: response.error?.code,
    state: response.result?.state,
    ms: Date.now() - started,
  });
  return response;
}

// ─────────────────────────────── provider

export default {
  id: 'payme',
  title: 'Payme',
  isConfigured,

  async createPayment(order, ctx) {
    // The Payme transaction itself appears with CreateTransaction; until then this row is the
    // record of the attempt and the keeper of the customer's return URL.
    recordAttempt(order, 'payme', { status: 'created', raw: { returnUrl: ctx.returnUrl, channel: ctx.channel } });
    return { redirectUrl: checkoutUrl(order) };
  },
};
