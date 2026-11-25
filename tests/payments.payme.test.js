// Payme Business Merchant API (POST /pay/payme): the whole transaction lifecycle over HTTP —
// authorization, protocol errors, every business error code, duplicates, timeout, cancel before
// and after perform, GetStatement — plus the checkout URL.
import { PAYME_KEY, PAYME_MERCHANT_ID } from './payments.env.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/http.js';
import { config } from '../src/config.js';
import * as orders from '../src/services/orders.js';
import * as paymentsRepo from '../src/services/payments.js';
import * as subscriptions from '../src/services/subscriptions.js';
import { startPayment, getProvider } from '../src/payments/index.js';
import { checkoutUrl, checkAuth, TIMEOUT_MS, STATE, REASON, ERROR } from '../src/payments/providers/payme.js';
import { setLogSink } from '../src/payments/log.js';
import { makeOrder, makeOrderFor, makeSubscriptionOrder, paymeAuth, paymeClient, paymeTxId, stockOf, purchaseEvents, paidRows, HOUR } from './payments.helpers.js';

let t;
let rpc;
const logs = [];
let restoreLog;
before(async () => {
  restoreLog = setLogSink((entry) => logs.push(entry));
  t = await startTestApp();
  rpc = paymeClient(t.baseUrl);
});
after(async () => {
  restoreLog();
  await t.close();
});

const account = (order) => ({ order_id: String(order.id) });
const tiyin = (order) => order.total * 100;
/** CreateTransaction for an order; returns { id, res }. */
async function create(order, { id = paymeTxId(), time = Date.now(), amount = tiyin(order) } = {}) {
  return { id, res: await rpc('CreateTransaction', { id, time, amount, account: account(order) }) };
}
const row = (id) => paymentsRepo.findByProviderTx('payme', id);

// ─────────────────────────────── configuration and checkout URL

test('provider is registered, configured and builds the checkout URL', async () => {
  const provider = getProvider('payme');
  assert.equal(provider.id, 'payme');
  assert.equal(provider.isConfigured(), true);

  const { order } = makeOrder();
  const url = new URL(checkoutUrl(order));
  assert.equal(url.origin, 'https://checkout.test.paycom.uz', 'PAYME_TEST=1 → sandbox host');
  const decoded = Buffer.from(decodeURIComponent(url.pathname.slice(1)), 'base64').toString('utf8');
  assert.equal(decoded, `m=${PAYME_MERCHANT_ID};ac.order_id=${order.id};a=${order.total * 100};c=${config.baseUrl}/pay/return/${order.public_token}`);

  config.payments.payme.test = false;
  try {
    assert.equal(new URL(checkoutUrl(order)).origin, 'https://checkout.paycom.uz', 'production host');
  } finally {
    config.payments.payme.test = true;
  }

  // startPayment → redirect to that URL + a recorded attempt that keeps the customer's return URL
  const result = await startPayment(order, { providerId: 'payme', returnUrl: '/tma/#/pay/1', channel: 'tma' });
  assert.equal(result.provider, 'payme');
  assert.equal(result.redirectUrl, checkoutUrl(order));
  const fresh = orders.getOrder(order.id);
  assert.equal(fresh.status, 'pending_payment');
  assert.equal(fresh.payment_provider, 'payme');
  const [attempt] = paymentsRepo.listByOrder(order.id);
  assert.equal(attempt.provider, 'payme');
  assert.equal(attempt.status, 'created');
  assert.equal(attempt.provider_tx_id, null);
  assert.equal(attempt.amount, order.total);
  assert.equal(attempt.raw.returnUrl, `${config.baseUrl}/tma/#/pay/1`);
  await startPayment(fresh, { providerId: 'payme' });
  assert.equal(paymentsRepo.listByOrder(order.id).length, 1, 'a repeated start reuses the open attempt');
});

// ─────────────────────────────── authorization

test('authorization: Basic "Paycom:<key>" is required for every method (-32504)', async () => {
  const { order } = makeOrder();
  const params = { amount: tiyin(order), account: account(order) };
  const bad = [
    null, // no header
    paymeAuth('wrong-key'),
    paymeAuth(PAYME_KEY.slice(0, -1)),
    paymeAuth(`${PAYME_KEY}x`),
    paymeAuth(PAYME_KEY, 'paycom'),
    paymeAuth(PAYME_KEY, 'Admin'),
    `Bearer ${PAYME_KEY}`,
    'Basic',
    'Basic !!!not-base64!!!',
    `Basic ${Buffer.from(PAYME_KEY).toString('base64')}`,
  ];
  for (const auth of bad) {
    for (const method of ['CheckPerformTransaction', 'CreateTransaction', 'PerformTransaction', 'CancelTransaction', 'CheckTransaction', 'GetStatement', 'Nope']) {
      const res = await rpc(method, params, { auth });
      assert.equal(res.error.code, ERROR.AUTH, `${method} with ${auth}`);
      assert.equal(res.error.code, -32504);
    }
  }
  assert.equal(paymentsRepo.listByOrder(order.id).length, 0, 'nothing is stored for unauthorized calls');
  assert.equal((await rpc('CheckPerformTransaction', params)).result.allow, true, 'the right key works');

  assert.equal(checkAuth(paymeAuth()), true);
  assert.equal(checkAuth(''), false);
  assert.equal(checkAuth(undefined), false);
});

// ─────────────────────────────── JSON-RPC protocol errors

test('protocol errors: -32300 not POST, -32700 bad JSON, -32600 bad request, -32601 unknown method', async () => {
  assert.equal((await rpc('CheckTransaction', {}, { httpMethod: 'GET' })).error.code, -32300);

  // malformed JSON: rejected by the global JSON parser (application/json) or by the route (other types)
  for (const contentType of ['application/json', 'text/plain', 'application/x-www-form-urlencoded']) {
    const res = await rpc(null, null, { rawBody: '{"jsonrpc":"2.0","id":1,"method":', contentType });
    assert.equal(res.error.code, -32700, contentType);
    assert.equal(res.id, null);
  }
  assert.equal((await rpc(null, null, { rawBody: '', contentType: 'application/json' })).error.code, -32700, 'empty body');

  // valid JSON sent with an unusual content type is still understood
  const { order } = makeOrder();
  const viaText = await rpc(null, null, {
    contentType: 'text/plain',
    rawBody: JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'CheckPerformTransaction', params: { amount: tiyin(order), account: account(order) } }),
  });
  assert.equal(viaText.id, 77);
  assert.equal(viaText.result.allow, true);

  // structurally invalid requests
  assert.equal((await rpc(null, null, { rawBody: '[]' })).error.code, -32600, 'batch / array');
  assert.equal((await rpc(null, null, { rawBody: 'null', contentType: 'text/plain' })).error.code, -32600, 'not an object');
  assert.equal((await rpc(null, null, { rawBody: '"CheckTransaction"', contentType: 'text/plain' })).error.code, -32600);
  assert.equal((await rpc(null, null, { rawBody: 'null' })).error.code, -32700, 'the strict JSON parser accepts objects and arrays only');
  assert.equal((await rpc(null, null, { rawBody: JSON.stringify({ id: 5, params: {} }) })).error.code, -32600, 'no method');
  assert.equal((await rpc(null, null, { rawBody: JSON.stringify({ id: 5, method: 42, params: {} }) })).error.code, -32600, 'method is not a string');
  const noParams = await rpc(null, null, { rawBody: JSON.stringify({ id: 6, method: 'CheckTransaction' }) });
  assert.equal(noParams.error.code, -32600);
  assert.equal(noParams.id, 6);
  assert.equal((await rpc('CheckTransaction', [])).error.code, -32600, 'params must be an object');

  // unknown methods
  for (const method of ['ChangePassword', 'checkperformtransaction', 'constructor', 'toString', '__proto__']) {
    const res = await rpc(method, {});
    assert.equal(res.error.code, -32601, method);
    assert.equal(res.error.data, method);
  }

  // wrong types of required fields
  assert.equal((await rpc('CheckPerformTransaction', { amount: '100', account: account(order) })).error.code, -32600);
  assert.equal((await rpc('CheckPerformTransaction', { account: account(order) })).error.code, -32600);
  assert.equal((await rpc('CheckPerformTransaction', { amount: tiyin(order) })).error.code, -32600, 'no account object');
  assert.equal((await rpc('CreateTransaction', { time: Date.now(), amount: tiyin(order), account: account(order) })).error.code, -32600, 'no id');
  assert.equal((await rpc('CreateTransaction', { id: paymeTxId(), amount: tiyin(order), account: account(order) })).error.code, -32600, 'no time');
  assert.equal((await rpc('CreateTransaction', { id: paymeTxId(), time: 'now', amount: tiyin(order), account: account(order) })).error.code, -32600);
  assert.equal((await rpc('CreateTransaction', { id: 12345, time: Date.now(), amount: tiyin(order), account: account(order) })).error.code, -32600, 'id must be a string');
  assert.equal((await rpc('PerformTransaction', {})).error.code, -32600);
  assert.equal((await rpc('CancelTransaction', { reason: 3 })).error.code, -32600);
  assert.equal((await rpc('GetStatement', { from: 'a', to: 'b' })).error.code, -32600);
  assert.equal((await rpc('GetStatement', { from: 10, to: 5 })).error.code, -32600);
  assert.equal(paymentsRepo.listByOrder(order.id).length, 0);
});

// ─────────────────────────────── CheckPerformTransaction

test('CheckPerformTransaction: allow, -31001 wrong amount, -31050…-31099 account errors', async () => {
  const { order } = makeOrder();
  const ok = await rpc('CheckPerformTransaction', { amount: tiyin(order), account: account(order) });
  assert.deepEqual(ok.result, { allow: true, additional: { order: order.number } });
  assert.equal(orders.getOrder(order.id).status, 'new', 'a check changes nothing');

  // the human order number is accepted as the account too (payment from the Payme app)
  assert.equal((await rpc('CheckPerformTransaction', { amount: tiyin(order), account: { order_id: order.number } })).result.allow, true);

  for (const amount of [tiyin(order) - 1, tiyin(order) + 100, order.total, 1, 0, -tiyin(order), tiyin(order) + 0.5]) {
    const res = await rpc('CheckPerformTransaction', { amount, account: account(order) });
    assert.equal(res.error.code, -31001, `amount ${amount}`);
    assert.equal(res.error.data, 'amount');
  }

  for (const acc of [{ order_id: '99999999' }, { order_id: 'SC-999999' }, { order_id: '' }, { order_id: 'abc' }, {}, { phone: '998901234567' }, { order_id: null }, { order_id: `${order.id} OR 1=1` }]) {
    const res = await rpc('CheckPerformTransaction', { amount: tiyin(order), account: acc });
    assert.equal(res.error.code, -31050, JSON.stringify(acc));
    assert.equal(res.error.data, 'order_id', 'data names the account field');
    assert.ok(res.error.code <= -31050 && res.error.code >= -31099);
  }

  const paid = makeOrder().order;
  orders.markPaid(paid.id, { provider: 'manual' });
  const paidRes = await rpc('CheckPerformTransaction', { amount: tiyin(paid), account: account(paid) });
  assert.equal(paidRes.error.code, -31051);
  assert.equal(paidRes.error.message.ru, 'Заказ уже оплачен');

  const cancelled = makeOrder().order;
  orders.cancel(cancelled.id);
  assert.equal((await rpc('CheckPerformTransaction', { amount: tiyin(cancelled), account: account(cancelled) })).error.code, -31052);

  const refunded = makeOrder().order;
  orders.markPaid(refunded.id, { provider: 'manual' });
  orders.refund(refunded.id);
  assert.equal((await rpc('CheckPerformTransaction', { amount: tiyin(refunded), account: account(refunded) })).error.code, -31052);
});

// ─────────────────────────────── the happy path

test('lifecycle: Create → Perform marks the order paid exactly once; every call is idempotent', async () => {
  const { order, product } = makeOrder({ qty: 3, stock: 10 });
  const before = Date.now();
  const paymeTime = before - 1500;
  const { id, res: created } = await create(order, { time: paymeTime });
  assert.equal(created.result.state, 1);
  assert.equal(typeof created.result.transaction, 'string');
  assert.ok(created.result.create_time >= before && created.result.create_time <= Date.now(), 'create_time is our clock in ms');

  let p = row(id);
  assert.equal(created.result.transaction, String(p.id));
  assert.equal(p.order_id, order.id);
  assert.equal(p.amount, order.total, 'stored in whole sums');
  assert.equal(p.status, 'pending');
  assert.equal(p.state, STATE.CREATED);
  assert.equal(p.raw.payme_time, paymeTime);
  assert.deepEqual(p.raw.account, { order_id: String(order.id) });
  let fresh = orders.getOrder(order.id);
  assert.equal(fresh.status, 'pending_payment');
  assert.equal(fresh.payment_status, 'pending');
  assert.equal(fresh.payment_provider, 'payme');
  assert.equal(stockOf(product), 10, 'nothing is reserved before the payment');

  // CreateTransaction repeated with the same id → the same answer, no second row
  const again = await rpc('CreateTransaction', { id, time: paymeTime, amount: tiyin(order), account: account(order) });
  assert.deepEqual(again.result, created.result);
  assert.equal(paymentsRepo.listByOrder(order.id).length, 1);
  // …and the amount of a known transaction cannot change
  assert.equal((await rpc('CreateTransaction', { id, time: paymeTime, amount: tiyin(order) + 100, account: account(order) })).error.code, -31001);

  const check1 = await rpc('CheckTransaction', { id });
  assert.deepEqual(check1.result, { create_time: created.result.create_time, perform_time: 0, cancel_time: 0, transaction: created.result.transaction, state: 1, reason: null });

  const performed = await rpc('PerformTransaction', { id });
  assert.equal(performed.result.state, 2);
  assert.equal(performed.result.transaction, created.result.transaction);
  assert.ok(performed.result.perform_time >= created.result.create_time);

  fresh = orders.getOrder(order.id);
  assert.equal(fresh.status, 'paid');
  assert.equal(fresh.payment_status, 'paid');
  assert.equal(fresh.payment_provider, 'payme');
  assert.ok(fresh.paid_at);
  assert.equal(stockOf(product), 7, 'stock decremented by the ordered quantity');
  assert.equal(purchaseEvents(order.id), 1);
  p = row(id);
  assert.equal(p.status, 'paid');
  assert.equal(p.state, STATE.PERFORMED);
  assert.equal(p.perform_time, performed.result.perform_time);
  assert.ok(orders.getOrderEvents(order.id).some((e) => e.type === 'payment' && e.to_value === 'paid' && e.actor === 'provider:payme'));

  // PerformTransaction repeated (Payme retries until it gets an answer) → the same answer, no second effect
  for (let i = 0; i < 3; i += 1) assert.deepEqual((await rpc('PerformTransaction', { id })).result, performed.result);
  assert.equal(stockOf(product), 7);
  assert.equal(purchaseEvents(order.id), 1);
  assert.equal(paidRows(order.id).length, 1);

  const check2 = await rpc('CheckTransaction', { id });
  assert.deepEqual(check2.result, {
    create_time: created.result.create_time, perform_time: performed.result.perform_time, cancel_time: 0,
    transaction: created.result.transaction, state: 2, reason: null,
  });

  // a performed transaction cannot be created again; the paid order accepts no new transaction
  assert.equal((await rpc('CreateTransaction', { id, time: paymeTime, amount: tiyin(order), account: account(order) })).error.code, -31008);
  assert.equal((await create(order)).res.error.code, -31051);
  assert.equal((await rpc('CheckPerformTransaction', { amount: tiyin(order), account: account(order) })).error.code, -31051);
});

test('CreateTransaction adopts the checkout attempt recorded by startPayment (return URL is kept)', async () => {
  const { order } = makeOrder();
  await startPayment(order, { providerId: 'payme', returnUrl: '/order/custom-return' });
  const [attempt] = paymentsRepo.listByOrder(order.id);
  const { id, res } = await create(order);
  assert.equal(res.result.transaction, String(attempt.id), 'the attempt row became the transaction');
  const rows = paymentsRepo.listByOrder(order.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider_tx_id, id);
  assert.equal(rows[0].state, 1);
  assert.equal(rows[0].raw.returnUrl, `${config.baseUrl}/order/custom-return`);
});

test('CreateTransaction: -31001, -31050, -31051, -31052 and one active transaction per order (-31099)', async () => {
  const { order } = makeOrder();
  assert.equal((await create(order, { amount: tiyin(order) - 100 })).res.error.code, -31001);
  assert.equal((await create(order, { amount: order.total })).res.error.code, -31001, 'sums instead of tiyin');
  assert.equal((await rpc('CreateTransaction', { id: paymeTxId(), time: Date.now(), amount: tiyin(order), account: { order_id: '424242424' } })).error.code, -31050);
  assert.equal(paymentsRepo.listByOrder(order.id).length, 0, 'refused transactions are not stored');

  const first = await create(order);
  assert.equal(first.res.result.state, 1);
  const second = await create(order);
  assert.equal(second.res.error.code, -31099, 'another transaction is waiting for this order');
  assert.equal(second.res.error.data, 'order_id');
  assert.equal(row(second.id), null);
  assert.equal((await rpc('CheckPerformTransaction', { amount: tiyin(order), account: account(order) })).error.code, -31099);
  assert.equal((await rpc('CheckTransaction', { id: second.id })).error.code, -31003);

  // once the first transaction is cancelled the order accepts a new one
  assert.equal((await rpc('CancelTransaction', { id: first.id, reason: REASON.EXECUTION_ERROR })).result.state, -1);
  const third = await create(order);
  assert.equal(third.res.result.state, 1);
  assert.notEqual(third.res.result.transaction, first.res.result.transaction);

  const cancelled = makeOrder().order;
  orders.cancel(cancelled.id);
  assert.equal((await create(cancelled)).res.error.code, -31052);

  // a transaction that Payme created more than 12 hours ago is not accepted
  const stale = makeOrder().order;
  assert.equal((await create(stale, { time: Date.now() - TIMEOUT_MS - 1000 })).res.error.code, -31008);
  assert.equal((await create(stale, { time: 0 })).res.error.code, -31008);
  assert.equal(paymentsRepo.listByOrder(stale.id).length, 0);
});

// ─────────────────────────────── PerformTransaction errors

test('PerformTransaction: -31003 unknown transaction, -31008 for cancelled ones and closed orders', async () => {
  assert.equal((await rpc('PerformTransaction', { id: paymeTxId() })).error.code, -31003);
  assert.equal((await rpc('CheckTransaction', { id: paymeTxId() })).error.code, -31003);
  assert.equal((await rpc('CancelTransaction', { id: paymeTxId(), reason: 1 })).error.code, -31003);

  // cancelled before perform → cannot be performed
  const a = makeOrder();
  const txA = await create(a.order);
  await rpc('CancelTransaction', { id: txA.id, reason: REASON.PROCESSING_ERROR });
  assert.equal((await rpc('PerformTransaction', { id: txA.id })).error.code, -31008);
  assert.equal(orders.getOrder(a.order.id).is_paid, false);
  assert.equal(stockOf(a.product), 10);

  // the manager cancelled the order while the customer was paying → refuse, cancel with reason 3
  const b = makeOrder();
  const txB = await create(b.order);
  orders.cancel(b.order.id, { actor: 'admin:1' });
  const refused = await rpc('PerformTransaction', { id: txB.id });
  assert.equal(refused.error.code, -31008);
  assert.equal(orders.getOrder(b.order.id).status, 'cancelled');
  assert.equal(orders.getOrder(b.order.id).is_paid, false);
  const checkB = (await rpc('CheckTransaction', { id: txB.id })).result;
  assert.equal(checkB.state, -1);
  assert.equal(checkB.reason, REASON.EXECUTION_ERROR);
  assert.ok(checkB.cancel_time > 0);
  assert.equal((await rpc('PerformTransaction', { id: txB.id })).error.code, -31008, 'repeated call: still refused');

  // paid by hand in the admin panel meanwhile → the Payme transaction is refused, nothing doubles
  const c = makeOrder({ qty: 2 });
  const txC = await create(c.order);
  orders.markPaid(c.order.id, { provider: 'manual', actor: 'admin:1' });
  assert.equal((await rpc('PerformTransaction', { id: txC.id })).error.code, -31008);
  assert.equal((await rpc('CheckTransaction', { id: txC.id })).result.state, -1);
  assert.equal(stockOf(c.product), 8);
  assert.equal(purchaseEvents(c.order.id), 1);
  assert.equal(paidRows(c.order.id).length, 1);
  assert.equal(orders.getOrder(c.order.id).payment_provider, 'manual');
});

test('PerformTransaction finishes the bookkeeping when the order was already marked paid by this transaction', async () => {
  // simulates a crash between orders.markPaid() and saving state 2
  const { order, product } = makeOrder({ qty: 1 });
  const { id } = await create(order);
  orders.markPaid(order.id, { provider: 'payme', paymentId: row(id).id, txId: id, amount: order.total });
  assert.equal(row(id).state, 1);
  const res = await rpc('PerformTransaction', { id });
  assert.equal(res.result.state, 2);
  assert.equal(res.result.perform_time, row(id).perform_time);
  assert.equal(stockOf(product), 9);
  assert.equal(purchaseEvents(order.id), 1);
});

// ─────────────────────────────── CancelTransaction

test('CancelTransaction before perform: state -1, the reason is kept, the order stays payable', async () => {
  const { order, product } = makeOrder();
  const { id, res: created } = await create(order);
  const cancelled = await rpc('CancelTransaction', { id, reason: REASON.PROCESSING_ERROR });
  assert.equal(cancelled.result.state, -1);
  assert.equal(cancelled.result.transaction, created.result.transaction);
  assert.ok(cancelled.result.cancel_time >= created.result.create_time);

  const p = row(id);
  assert.equal(p.status, 'cancelled');
  assert.equal(p.state, STATE.CANCELLED);
  assert.equal(p.reason, 2);
  const fresh = orders.getOrder(order.id);
  assert.equal(fresh.status, 'pending_payment');
  assert.equal(fresh.payment_status, 'failed');
  assert.equal(fresh.can_pay, true);
  assert.equal(stockOf(product), 10);

  // repeated cancel (also with another reason) → the first answer again
  assert.deepEqual((await rpc('CancelTransaction', { id, reason: REASON.PROCESSING_ERROR })).result, cancelled.result);
  assert.deepEqual((await rpc('CancelTransaction', { id, reason: REASON.REFUND })).result, cancelled.result);
  assert.equal(row(id).reason, 2);
  assert.deepEqual((await rpc('CheckTransaction', { id })).result, {
    create_time: created.result.create_time, perform_time: 0, cancel_time: cancelled.result.cancel_time,
    transaction: created.result.transaction, state: -1, reason: 2,
  });
  assert.equal((await rpc('CreateTransaction', { id, time: Date.now(), amount: tiyin(order), account: account(order) })).error.code, -31008);

  // the customer tries again: a new transaction pays the same order
  const retry = await create(order);
  assert.equal((await rpc('PerformTransaction', { id: retry.id })).result.state, 2);
  assert.equal(orders.getOrder(order.id).status, 'paid');
  assert.equal(stockOf(product), 8);
  assert.equal(paidRows(order.id).length, 1);
});

test('CancelTransaction after perform: state -2, the order is refunded and the stock returns', async () => {
  const { order, product } = makeOrder({ qty: 4, stock: 9 });
  const { id, res: created } = await create(order);
  const performed = await rpc('PerformTransaction', { id });
  assert.equal(stockOf(product), 5);

  const cancelled = await rpc('CancelTransaction', { id, reason: REASON.REFUND });
  assert.equal(cancelled.result.state, -2);
  assert.ok(cancelled.result.cancel_time >= performed.result.perform_time);
  const fresh = orders.getOrder(order.id);
  assert.equal(fresh.status, 'refunded');
  assert.equal(fresh.payment_status, 'refunded');
  assert.equal(stockOf(product), 9, 'stock is back');
  const p = row(id);
  assert.equal(p.status, 'refunded');
  assert.equal(p.state, STATE.CANCELLED_AFTER_PERFORM);
  assert.equal(p.reason, 5);

  assert.deepEqual((await rpc('CancelTransaction', { id, reason: REASON.REFUND })).result, cancelled.result, 'idempotent');
  assert.equal(stockOf(product), 9, 'the stock is returned once');
  assert.deepEqual((await rpc('CheckTransaction', { id })).result, {
    create_time: created.result.create_time, perform_time: performed.result.perform_time, cancel_time: cancelled.result.cancel_time,
    transaction: created.result.transaction, state: -2, reason: 5,
  });
  assert.equal((await rpc('PerformTransaction', { id })).error.code, -31008);
  assert.equal((await create(order)).res.error.code, -31052, 'a refunded order is closed for payment');
});

test('CancelTransaction after perform is refused with -31007 once the order has been shipped or delivered', async () => {
  for (const status of ['shipped', 'delivered']) {
    const { order, product } = makeOrder({ qty: 1 });
    const { id } = await create(order);
    const performed = await rpc('PerformTransaction', { id });
    orders.setStatus(order.id, status, { actor: 'admin:1' });

    const res = await rpc('CancelTransaction', { id, reason: REASON.REFUND });
    assert.equal(res.error.code, -31007, status);
    assert.equal(res.error.code, ERROR.CANNOT_CANCEL);
    assert.equal(orders.getOrder(order.id).status, status);
    assert.equal(orders.getOrder(order.id).payment_status, 'paid');
    assert.equal(stockOf(product), 9);
    assert.deepEqual((await rpc('CheckTransaction', { id })).result.state, 2, 'the transaction stays performed');
    assert.equal((await rpc('PerformTransaction', { id })).result.perform_time, performed.result.perform_time);
  }

  // "processing" (being packed) can still be refunded
  const { order } = makeOrder();
  const { id } = await create(order);
  await rpc('PerformTransaction', { id });
  orders.setStatus(order.id, 'processing', { actor: 'admin:1' });
  assert.equal((await rpc('CancelTransaction', { id, reason: REASON.REFUND })).result.state, -2);
  assert.equal(orders.getOrder(order.id).status, 'refunded');

  // the manager refunded in the admin panel first, Payme's cancel arrives afterwards → accepted
  const second = makeOrder().order;
  const tx2 = await create(second);
  await rpc('PerformTransaction', { id: tx2.id });
  orders.refund(second.id, { actor: 'admin:1' });
  assert.equal((await rpc('CancelTransaction', { id: tx2.id, reason: REASON.REFUND })).result.state, -2);
});

// ─────────────────────────────── subscriptions

test('subscription order: Perform activates the subscription, Cancel after perform reverts it', async () => {
  const { order, plan } = makeSubscriptionOrder({ price: 189000 });
  assert.equal((await rpc('CheckPerformTransaction', { amount: 18_900_000, account: account(order) })).result.allow, true);
  const { id } = await create(order);
  assert.equal((await rpc('PerformTransaction', { id })).result.state, 2);
  const paid = orders.getOrder(order.id);
  assert.equal(paid.status, 'paid');
  const sub = subscriptions.getCurrentForCustomer(paid.customer_id);
  assert.equal(sub.plan_id, plan.id);
  assert.equal(sub.status, 'active');
  await rpc('PerformTransaction', { id });
  assert.equal(subscriptions.getSubscription(sub.id).renewals, sub.renewals, 'a repeated Perform does not extend the period');
  assert.equal(subscriptions.getSubscription(sub.id).current_period_end, sub.current_period_end);

  assert.equal((await rpc('CancelTransaction', { id, reason: REASON.REFUND })).result.state, -2);
  assert.equal(orders.getOrder(order.id).status, 'refunded');
  assert.notEqual(subscriptions.getSubscription(sub.id).status, 'active');
});

// ─────────────────────────────── timeout

test('timeout: a transaction older than 12 hours is cancelled with reason 4 and cannot be performed', async () => {
  const { order, product } = makeOrder();
  const { id, res: created } = await create(order);
  // 11 hours: still fine
  paymentsRepo.updatePayment(row(id).id, { createTime: Date.now() - 11 * HOUR });
  assert.equal((await rpc('CreateTransaction', { id, time: Date.now(), amount: tiyin(order), account: account(order) })).result.state, 1);
  // 12 hours and a bit: expired
  paymentsRepo.updatePayment(row(id).id, { createTime: Date.now() - TIMEOUT_MS - 5000 });
  const res = await rpc('PerformTransaction', { id });
  assert.equal(res.error.code, -31008);
  const check = (await rpc('CheckTransaction', { id })).result;
  assert.equal(check.state, -1);
  assert.equal(check.reason, 4);
  assert.equal(check.reason, REASON.TIMEOUT);
  assert.ok(check.cancel_time > 0);
  assert.equal(check.transaction, created.result.transaction);
  assert.equal(orders.getOrder(order.id).is_paid, false);
  assert.equal(orders.getOrder(order.id).can_pay, true, 'the order can be paid again');
  assert.equal(stockOf(product), 10);
  assert.equal((await rpc('PerformTransaction', { id })).error.code, -31008);
  assert.equal((await rpc('CreateTransaction', { id, time: Date.now(), amount: tiyin(order), account: account(order) })).error.code, -31008);

  // expiry is also noticed by a repeated CreateTransaction…
  const b = makeOrder().order;
  const txB = await create(b);
  paymentsRepo.updatePayment(row(txB.id).id, { createTime: Date.now() - 13 * HOUR });
  assert.equal((await rpc('CreateTransaction', { id: txB.id, time: Date.now(), amount: tiyin(b), account: account(b) })).error.code, -31008);
  assert.deepEqual([row(txB.id).state, row(txB.id).reason], [-1, 4]);

  // …and an expired transaction no longer blocks the order for a new one
  const c = makeOrder().order;
  const txC = await create(c);
  paymentsRepo.updatePayment(row(txC.id).id, { createTime: Date.now() - 13 * HOUR });
  const fresh = await create(c);
  assert.equal(fresh.res.result.state, 1);
  assert.deepEqual([row(txC.id).state, row(txC.id).reason, row(txC.id).status], [-1, 4, 'cancelled']);
  assert.equal((await rpc('PerformTransaction', { id: fresh.id })).result.state, 2);
  assert.equal(orders.getOrder(c.id).status, 'paid');
});

// ─────────────────────────────── GetStatement

test('GetStatement returns the transactions of a period ordered by Payme time, with every field', async () => {
  const base = Date.now() - 3 * HOUR;
  const a = makeOrder().order;
  const b = makeOrder().order;
  const c = makeOrder().order;
  const txB = await create(b, { time: base + 2000 }); // created second in Payme
  const txA = await create(a, { time: base + 1000 }); // …but first by Payme time
  const txC = await create(c, { time: base + 3000 });
  await rpc('PerformTransaction', { id: txA.id });
  await rpc('CancelTransaction', { id: txB.id, reason: REASON.TIMEOUT });
  await startPayment(makeOrder().order, { providerId: 'payme' }); // an attempt without a Payme transaction is not listed

  const all = (await rpc('GetStatement', { from: base, to: base + 5000 })).result.transactions;
  assert.deepEqual(all.map((x) => x.id), [txA.id, txB.id, txC.id]);
  const [sa, sb, sc] = all;
  assert.deepEqual(sa, {
    id: txA.id, time: base + 1000, amount: a.total * 100, account: { order_id: String(a.id) },
    create_time: row(txA.id).create_time, perform_time: row(txA.id).perform_time, cancel_time: 0,
    transaction: String(row(txA.id).id), state: 2, reason: null,
  });
  assert.deepEqual([sb.state, sb.reason, sb.perform_time], [-1, 4, 0]);
  assert.ok(sb.cancel_time > 0);
  assert.deepEqual([sc.state, sc.reason, sc.perform_time, sc.cancel_time], [1, null, 0, 0]);

  // boundaries are inclusive, the period filters by Payme time
  assert.deepEqual((await rpc('GetStatement', { from: base + 1000, to: base + 2000 })).result.transactions.map((x) => x.id), [txA.id, txB.id]);
  assert.deepEqual((await rpc('GetStatement', { from: base + 2001, to: base + 2999 })).result.transactions, []);
  assert.deepEqual((await rpc('GetStatement', { from: 0, to: 1000 })).result.transactions, []);
});

// ─────────────────────────────── logging

test('callbacks are logged as structured entries without credentials', async () => {
  const { order } = makeOrder();
  logs.length = 0;
  const { id } = await create(order);
  await rpc('PerformTransaction', { id });
  await rpc('CheckTransaction', { id }, { auth: paymeAuth('stolen-key') });

  const entries = logs.filter((e) => e.event === 'payme.rpc');
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.method), ['CreateTransaction', 'PerformTransaction', 'CheckTransaction']);
  assert.deepEqual(entries.map((e) => e.ok), [true, true, false]);
  assert.equal(entries[2].code, -32504);
  assert.equal(entries[0].tx, id);
  assert.equal(entries[0].amount, order.total * 100);
  assert.equal(entries[1].state, 2);
  assert.equal(entries[0].scope, 'payments');
  assert.match(entries[0].ts, /^\d{4}-\d\d-\d\dT/);
  const dump = JSON.stringify(logs);
  assert.ok(!dump.includes(PAYME_KEY), 'the merchant key is never logged');
  assert.ok(!dump.includes('stolen-key'));
  assert.ok(!dump.includes(Buffer.from(`Paycom:${PAYME_KEY}`).toString('base64')));
  assert.ok(!/authorization/i.test(dump));
});

// ─────────────────────────────── stock and the half-performed state

test('stock is checked before Payme may charge: -31053 on CheckPerform / Create, -31008 on Perform', async () => {
  const { order, product } = makeOrder({ qty: 1, stock: 1 });
  const rival = makeOrderFor(product, 1);
  const waiting = await create(order);
  assert.equal(waiting.res.result.state, 1);

  // another customer gets the last unit
  orders.markPaid(rival.id, { provider: 'manual' });
  assert.equal(stockOf(product), 0);

  // the goods ran out after CreateTransaction: Perform is refused, Payme returns the money
  const perform = await rpc('PerformTransaction', { id: waiting.id });
  assert.equal(perform.error.code, ERROR.CANNOT_PERFORM);
  assert.deepEqual([row(waiting.id).state, row(waiting.id).status], [STATE.CANCELLED, 'cancelled']);
  let fresh = orders.getOrder(order.id);
  assert.deepEqual([fresh.is_paid, fresh.can_pay, fresh.payment_status], [false, true, 'failed']);
  assert.equal(stockOf(product), 0);

  // and a new payment cannot even start
  const check = await rpc('CheckPerformTransaction', { amount: tiyin(order), account: account(order) });
  assert.equal(check.error.code, ERROR.OUT_OF_STOCK);
  assert.equal(check.error.code, -31053);
  assert.equal(check.error.data, 'order_id');
  assert.equal((await create(order)).res.error.code, -31053);
  await assert.rejects(() => startPayment(orders.getOrder(order.id), { providerId: 'payme' }), (e) => e.code === 'out_of_stock' && e.status === 409);

  // the stock is back (the rival order was refunded) → payable again
  orders.refund(rival.id);
  assert.equal(stockOf(product), 1);
  assert.equal((await rpc('CheckPerformTransaction', { amount: tiyin(order), account: account(order) })).result.allow, true);
  const again = await create(order);
  assert.equal((await rpc('PerformTransaction', { id: again.id })).result.state, 2);
  fresh = orders.getOrder(order.id);
  assert.equal(fresh.is_paid, true);
  assert.equal(stockOf(product), 0);
});

test('CancelTransaction of a transaction that already paid the order (state not saved) is a refund, not a plain cancel', async () => {
  // the stop between orders.markPaid() and saving state 2 that PerformTransaction recovers from
  const { order, product } = makeOrder({ qty: 2 });
  const { id } = await create(order);
  orders.markPaid(order.id, { provider: 'payme', paymentId: row(id).id, txId: id, amount: order.total });
  assert.deepEqual([row(id).state, row(id).status], [1, 'paid']);
  assert.equal(stockOf(product), 8);

  const res = await rpc('CancelTransaction', { id, reason: REASON.EXECUTION_ERROR });
  assert.equal(res.result.state, STATE.CANCELLED_AFTER_PERFORM, 'Payme returns the money → the order must not stay paid');
  const fresh = orders.getOrder(order.id);
  assert.deepEqual([fresh.status, fresh.payment_status], ['refunded', 'refunded']);
  assert.equal(stockOf(product), 10, 'stock is returned');
  assert.deepEqual([row(id).state, row(id).status, row(id).reason], [-2, 'refunded', REASON.EXECUTION_ERROR]);
  // idempotent, and it can no longer be performed
  assert.equal((await rpc('CancelTransaction', { id, reason: REASON.EXECUTION_ERROR })).result.state, -2);
  assert.equal((await rpc('PerformTransaction', { id })).error.code, ERROR.CANNOT_PERFORM);

  // once the order has been shipped the money cannot be taken back (-31007), the order stays paid
  const shipped = makeOrder({ qty: 1 });
  const tx2 = await create(shipped.order);
  orders.markPaid(shipped.order.id, { provider: 'payme', paymentId: row(tx2.id).id, txId: tx2.id, amount: shipped.order.total });
  orders.setStatus(shipped.order.id, 'shipped');
  assert.equal((await rpc('CancelTransaction', { id: tx2.id, reason: REASON.REFUND })).error.code, ERROR.CANNOT_CANCEL);
  assert.equal(orders.getOrder(shipped.order.id).status, 'shipped');
});

test('PerformTransaction commits "order paid" and "state 2" together', async () => {
  const { order } = makeOrder({ qty: 1 });
  const { id } = await create(order);
  const res = await rpc('PerformTransaction', { id });
  assert.equal(res.result.state, 2);
  assert.deepEqual([row(id).state, row(id).status, orders.getOrder(order.id).is_paid], [2, 'paid', true]);
  assert.equal(res.result.perform_time, row(id).perform_time);
});
