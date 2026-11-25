// Click SHOP API (POST /pay/click/prepare, /pay/click/complete): signature check, every answer
// code, repeated and duplicate callbacks, cancellation by Click — plus the pay URL.
import { CLICK_SERVICE_ID, CLICK_MERCHANT_ID, CLICK_SECRET_KEY, CLICK_MERCHANT_USER_ID } from './payments.env.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestApp } from './helpers/http.js';
import { config } from '../src/config.js';
import * as orders from '../src/services/orders.js';
import * as paymentsRepo from '../src/services/payments.js';
import * as subscriptions from '../src/services/subscriptions.js';
import { startPayment, getProvider } from '../src/payments/index.js';
import { payUrl, signString, ERROR } from '../src/payments/providers/click.js';
import { setLogSink } from '../src/payments/log.js';
import { makeOrder, makeOrderFor, makeSubscriptionOrder, clickClient, clickFields, clickSign, clickTransId, stockOf, purchaseEvents, paidRows } from './payments.helpers.js';

let t;
let click;
const logs = [];
let restoreLog;
before(async () => {
  restoreLog = setLogSink((entry) => logs.push(entry));
  t = await startTestApp();
  click = clickClient(t.baseUrl);
});
after(async () => {
  restoreLog();
  await t.close();
});

/** Prepare + return { fields, res }. */
async function prepare(order, overrides = {}) {
  const fields = clickFields(order, overrides);
  return { fields, res: await click('prepare', fields) };
}
/** Complete for a prepared transaction. */
function complete(order, prepared, overrides = {}) {
  return click('complete', clickFields(order, { clickTransId: prepared.fields.click_trans_id, prepareId: prepared.res.merchant_prepare_id, ...overrides }));
}

// ─────────────────────────────── configuration and pay URL

test('provider is registered, configured and builds the pay URL', async () => {
  const provider = getProvider('click');
  assert.equal(provider.id, 'click');
  assert.equal(provider.isConfigured(), true);

  const { order } = makeOrder();
  const url = new URL(payUrl(order));
  assert.equal(`${url.origin}${url.pathname}`, 'https://my.click.uz/services/pay');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    service_id: CLICK_SERVICE_ID,
    merchant_id: CLICK_MERCHANT_ID,
    amount: `${order.total}.00`,
    transaction_param: String(order.id),
    return_url: `${config.baseUrl}/pay/return/${order.public_token}`,
    merchant_user_id: CLICK_MERCHANT_USER_ID,
  });

  const result = await startPayment(order, { providerId: 'click', returnUrl: '/tma/#/pay/7' });
  assert.equal(result.provider, 'click');
  assert.equal(result.redirectUrl, payUrl(order));
  assert.equal(orders.getOrder(order.id).payment_provider, 'click');
  const [attempt] = paymentsRepo.listByOrder(order.id);
  assert.deepEqual([attempt.provider, attempt.status, attempt.provider_tx_id, attempt.amount], ['click', 'created', null, order.total]);
  assert.equal(attempt.raw.returnUrl, `${config.baseUrl}/tma/#/pay/7`);
});

test('sign_string follows the documented md5 formulas', () => {
  const f = { click_trans_id: '111', service_id: '222', merchant_trans_id: '333', merchant_prepare_id: '444', amount: '1000', action: '0', sign_time: '2026-01-01 00:00:00' };
  const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
  assert.equal(signString(f), md5(`111222${CLICK_SECRET_KEY}33310000${'2026-01-01 00:00:00'}`));
  assert.equal(signString({ ...f, action: '1' }, { complete: true }), md5(`111222${CLICK_SECRET_KEY}33344410001${'2026-01-01 00:00:00'}`));
  assert.equal(signString(f), clickSign(f));
  assert.notEqual(signString(f), signString(f, { complete: true }));
});

// ─────────────────────────────── the happy path

test('Prepare → Complete marks the order paid exactly once; a second Complete answers -4', async () => {
  const { order, product } = makeOrder({ qty: 3 });
  const prepared = await prepare(order);
  assert.equal(prepared.res.error, 0);
  assert.equal(prepared.res.error_note, 'Success');
  assert.equal(prepared.res.click_trans_id, Number(prepared.fields.click_trans_id));
  assert.equal(prepared.res.merchant_trans_id, String(order.id));
  assert.ok(Number.isInteger(prepared.res.merchant_prepare_id));

  let p = paymentsRepo.getPayment(prepared.res.merchant_prepare_id);
  assert.deepEqual([p.provider, p.provider_tx_id, p.status, p.amount, p.order_id], ['click', prepared.fields.click_trans_id, 'pending', order.total, order.id]);
  assert.equal(p.raw.click_paydoc_id, prepared.fields.click_paydoc_id);
  let fresh = orders.getOrder(order.id);
  assert.deepEqual([fresh.status, fresh.payment_status, fresh.payment_provider], ['pending_payment', 'pending', 'click']);
  assert.equal(stockOf(product), 10, 'Prepare reserves nothing');

  // Prepare repeated by Click → the same prepare id, no second row
  const again = await click('prepare', prepared.fields);
  assert.deepEqual(again, prepared.res);
  assert.equal(paymentsRepo.listByOrder(order.id).length, 1);

  const done = await complete(order, prepared);
  assert.deepEqual(done, {
    click_trans_id: Number(prepared.fields.click_trans_id), merchant_trans_id: String(order.id),
    merchant_confirm_id: prepared.res.merchant_prepare_id, error: 0, error_note: 'Success',
  });
  fresh = orders.getOrder(order.id);
  assert.deepEqual([fresh.status, fresh.payment_status, fresh.payment_provider], ['paid', 'paid', 'click']);
  assert.equal(stockOf(product), 7);
  assert.equal(purchaseEvents(order.id), 1);
  p = paymentsRepo.getPayment(prepared.res.merchant_prepare_id);
  assert.equal(p.status, 'paid');
  assert.ok(p.perform_time > 0);
  assert.ok(orders.getOrderEvents(order.id).some((e) => e.type === 'payment' && e.to_value === 'paid' && e.actor === 'provider:click'));

  // double Complete: "Already paid", nothing changes
  for (let i = 0; i < 3; i += 1) {
    const dup = await complete(order, prepared);
    assert.equal(dup.error, -4);
    assert.equal(dup.error_note, 'Already paid');
    assert.equal(dup.merchant_confirm_id, prepared.res.merchant_prepare_id);
  }
  assert.equal(stockOf(product), 7);
  assert.equal(purchaseEvents(order.id), 1);
  assert.equal(paidRows(order.id).length, 1);

  // the paid order accepts neither the old nor a new transaction
  assert.equal((await click('prepare', prepared.fields)).error, -4);
  assert.equal((await prepare(order)).res.error, -4);
  assert.equal(paymentsRepo.listByOrder(order.id).length, 1);
});

test('Prepare adopts the attempt recorded by startPayment; "129000.00" amounts and order numbers are accepted', async () => {
  const { order } = makeOrder();
  await startPayment(order, { providerId: 'click', returnUrl: '/order/back-here' });
  const [attempt] = paymentsRepo.listByOrder(order.id);
  const prepared = await prepare(order, { amount: `${order.total}.00` });
  assert.equal(prepared.res.error, 0);
  assert.equal(prepared.res.merchant_prepare_id, attempt.id, 'the attempt row became the Click transaction');
  assert.equal(paymentsRepo.listByOrder(order.id).length, 1);
  assert.equal(paymentsRepo.getPayment(attempt.id).raw.returnUrl, `${config.baseUrl}/order/back-here`);
  assert.equal((await complete(order, prepared, { amount: `${order.total}.00` })).error, 0);
  assert.equal(orders.getOrder(order.id).status, 'paid');

  // merchant_trans_id may be the human order number (payment started inside the Click app)
  const second = makeOrder().order;
  const fields = { ...clickFields(second), merchant_trans_id: second.number };
  const res = await click('prepare', fields);
  assert.equal(res.error, 0);
  assert.equal(res.merchant_trans_id, second.number);
  assert.equal(paymentsRepo.getPayment(res.merchant_prepare_id).order_id, second.id);
  const fin = await click('complete', { ...fields, action: '1', merchant_prepare_id: String(res.merchant_prepare_id) });
  assert.equal(fin.error, 0);
  assert.equal(orders.getOrder(second.id).status, 'paid');
});

test('subscription order paid through Click activates the subscription once', async () => {
  const { order, plan } = makeSubscriptionOrder({ price: 249000 });
  const prepared = await prepare(order);
  assert.equal((await complete(order, prepared)).error, 0);
  const sub = subscriptions.getCurrentForCustomer(orders.getOrder(order.id).customer_id);
  assert.equal(sub.plan_id, plan.id);
  assert.equal(sub.status, 'active');
  assert.equal((await complete(order, prepared)).error, -4);
  assert.equal(subscriptions.getSubscription(sub.id).current_period_end, sub.current_period_end);
});

// ─────────────────────────────── refusals

test('Prepare: -1 bad signature, -8 bad request, -3 wrong action, -5 unknown order, -2 wrong amount, -4 paid, -9 cancelled', async () => {
  const { order } = makeOrder();
  const good = clickFields(order);

  // -1: wrong / foreign / tampered signatures
  assert.equal((await click('prepare', { ...good, sign_string: 'deadbeefdeadbeefdeadbeefdeadbeef' })).error, -1);
  assert.equal((await click('prepare', good, { secret: 'not-the-secret' })).error, -1);
  assert.equal((await click('prepare', { ...good, sign_string: clickSign({ ...good, merchant_prepare_id: '1' }, { complete: true }) })).error, -1, 'Complete formula on Prepare');
  const signed = { ...good, sign_string: clickSign(good) };
  assert.equal((await click('prepare', { ...signed, amount: '1000' })).error, -1, 'amount changed after signing');
  assert.equal((await click('prepare', { ...signed, merchant_trans_id: String(order.id + 1) })).error, -1, 'order changed after signing');
  assert.equal((await click('prepare', { ...signed, sign_time: '2026-03-01 12:30:46' })).error, -1);
  const badSign = await click('prepare', { ...good, sign_string: 'x' });
  assert.deepEqual(badSign, { click_trans_id: Number(good.click_trans_id), merchant_trans_id: String(order.id), error: -1, error_note: 'SIGN CHECK FAILED!' });
  // the signature is compared case-insensitively (hex)
  assert.equal((await click('prepare', { ...good, sign_string: clickSign(good).toUpperCase() })).error, 0);

  // -8: required fields are missing, or the request is for another service
  for (const missing of ['click_trans_id', 'service_id', 'merchant_trans_id', 'amount', 'action', 'sign_time', 'sign_string']) {
    const fields = { ...signed };
    delete fields[missing];
    assert.equal((await click('prepare', fields, { sign: false })).error, -8, `without ${missing}`);
  }
  assert.equal((await click('prepare', {}, { sign: false })).error, -8);
  assert.equal((await click('prepare', { ...clickFields(order), service_id: '99999' })).error, -8, 'correctly signed, but not our service');

  // -3: Prepare must come with action=0
  assert.equal((await click('prepare', { ...clickFields(order), action: '1' })).error, -3);
  assert.equal((await click('prepare', { ...clickFields(order), action: '2' })).error, -3);

  // -5: unknown order
  for (const ref of ['987654321', 'SC-999999', 'abc', '0']) {
    const res = await click('prepare', { ...clickFields(order), merchant_trans_id: ref });
    assert.equal(res.error, -5, ref);
    assert.equal(res.error_note, 'User does not exist');
  }

  // -2: amount differs from the order total
  for (const amount of [order.total - 1, order.total + 1, `${order.total}.50`, '0', '-100', 'abc', order.total * 100]) {
    assert.equal((await prepare(order, { amount })).res.error, -2, `amount ${amount}`);
  }

  assert.equal(paymentsRepo.listByOrder(order.id).filter((p) => p.provider_tx_id).length, 1, 'only the valid Prepare stored a transaction');

  // -4: already paid
  const paid = makeOrder().order;
  orders.markPaid(paid.id, { provider: 'manual' });
  assert.equal((await prepare(paid)).res.error, -4);

  // -9: cancelled / refunded order
  const cancelled = makeOrder().order;
  orders.cancel(cancelled.id);
  const res = await prepare(cancelled);
  assert.equal(res.res.error, -9);
  assert.equal(res.res.error_note, 'Transaction cancelled');
  const refunded = makeOrder().order;
  orders.markPaid(refunded.id, { provider: 'manual' });
  orders.refund(refunded.id);
  assert.equal((await prepare(refunded)).res.error, -9);
  assert.equal(paymentsRepo.listByOrder(cancelled.id).length, 0);
});

test('Complete: -1 bad signature, -8, -3, -5, -6 unknown transaction, -2 wrong amount', async () => {
  const { order, product } = makeOrder();
  const prepared = await prepare(order);
  const good = clickFields(order, { clickTransId: prepared.fields.click_trans_id, prepareId: prepared.res.merchant_prepare_id });

  assert.equal((await click('complete', { ...good, sign_string: clickSign(good) })).error, -1, 'Prepare formula on Complete');
  assert.equal((await click('complete', good, { secret: 'not-the-secret' })).error, -1);
  const signed = { ...good, sign_string: clickSign(good, { complete: true }) };
  assert.equal((await click('complete', { ...signed, merchant_prepare_id: String(prepared.res.merchant_prepare_id + 1) })).error, -1, 'prepare id changed after signing');

  const noPrepareId = { ...signed };
  delete noPrepareId.merchant_prepare_id;
  assert.equal((await click('complete', noPrepareId, { sign: false })).error, -8);
  assert.equal((await click('complete', { ...good, action: '0' })).error, -3);
  assert.equal((await click('complete', { ...good, merchant_trans_id: '987654321' })).error, -5);

  // -6: the prepare id is unknown, belongs to another order, another Click transaction, or another provider
  const other = makeOrder().order;
  const otherPrepared = await prepare(other);
  const mockRow = paymentsRepo.createPayment({ orderId: order.id, provider: 'mock', providerTxId: 'mock_aaaaaaaaaaaaaaaaaaaaaaaa', amount: order.total, status: 'pending' });
  for (const prepareId of [999999, otherPrepared.res.merchant_prepare_id, mockRow.id, 'abc', '0']) {
    const res = await click('complete', clickFields(order, { clickTransId: prepared.fields.click_trans_id, prepareId }));
    assert.equal(res.error, -6, `prepare id ${prepareId}`);
    assert.equal(res.error_note, 'Transaction does not exist');
  }
  assert.equal((await click('complete', clickFields(order, { clickTransId: clickTransId(), prepareId: prepared.res.merchant_prepare_id }))).error, -6, 'another click_trans_id');

  for (const amount of [order.total - 1000, order.total + 1, '1']) {
    assert.equal((await complete(order, prepared, { amount })).error, -2, `amount ${amount}`);
  }

  // none of the refused calls touched the order; the right Complete still works
  assert.equal(orders.getOrder(order.id).is_paid, false);
  assert.equal(stockOf(product), 10);
  assert.equal((await complete(order, prepared)).error, 0);
  assert.equal(orders.getOrder(order.id).is_paid, true);
  assert.equal(orders.getOrder(other.id).is_paid, false);
});

// ─────────────────────────────── cancellation

test('Complete with error < 0 cancels the transaction (-9); the order stays payable and a new attempt succeeds', async () => {
  const { order, product } = makeOrder({ qty: 2 });
  const prepared = await prepare(order);
  const failed = await complete(order, prepared, { error: '-5017', errorNote: 'Insufficient funds' });
  assert.equal(failed.error, -9);
  assert.equal(failed.error_note, 'Transaction cancelled');

  const p = paymentsRepo.getPayment(prepared.res.merchant_prepare_id);
  assert.equal(p.status, 'cancelled');
  assert.ok(p.cancel_time > 0);
  assert.match(p.error, /Insufficient funds/);
  const fresh = orders.getOrder(order.id);
  assert.deepEqual([fresh.status, fresh.payment_status, fresh.can_pay], ['pending_payment', 'failed', true]);
  assert.equal(stockOf(product), 10);
  assert.equal(purchaseEvents(order.id), 0);

  // repeated cancel and a late "successful" Complete of the cancelled transaction → still -9
  assert.equal((await complete(order, prepared, { error: '-5017' })).error, -9);
  assert.equal((await complete(order, prepared)).error, -9);
  assert.equal((await click('prepare', prepared.fields)).error, -9, 'a cancelled click_trans_id cannot be prepared again');
  assert.equal(orders.getOrder(order.id).is_paid, false);

  // a new Click transaction pays the order
  const retry = await prepare(order);
  assert.notEqual(retry.res.merchant_prepare_id, prepared.res.merchant_prepare_id);
  assert.equal((await complete(order, retry)).error, 0);
  assert.equal(orders.getOrder(order.id).status, 'paid');
  assert.equal(stockOf(product), 8);
  assert.equal(paidRows(order.id).length, 1);
});

test('Complete is refused with -9 when the order was cancelled or paid another way after Prepare; -4 only for a repeat of the winner', async () => {
  const a = makeOrder();
  const preparedA = await prepare(a.order);
  orders.cancel(a.order.id, { actor: 'admin:1' });
  assert.equal((await complete(a.order, preparedA)).error, -9);
  assert.equal(orders.getOrder(a.order.id).status, 'cancelled');
  assert.equal(stockOf(a.product), 10);

  // paid in the panel between Prepare and Complete: Click charged the customer, we must not keep it —
  // "-4 Already paid" would mean "this transaction was confirmed", so the answer is -9 (reversal)
  const b = makeOrder({ qty: 1 });
  const preparedB = await prepare(b.order);
  orders.markPaid(b.order.id, { provider: 'manual', actor: 'admin:1' });
  const res = await complete(b.order, preparedB);
  assert.equal(res.error, -9);
  assert.equal(res.merchant_confirm_id, undefined, 'nothing is confirmed');
  assert.equal(stockOf(b.product), 9, 'charged once');
  assert.equal(purchaseEvents(b.order.id), 1);
  assert.equal(paidRows(b.order.id).length, 1);
  const refusedB = paymentsRepo.getPayment(preparedB.res.merchant_prepare_id);
  assert.equal(refusedB.status, 'cancelled');
  assert.equal(refusedB.raw.duplicate_reported, true, 'the staff is told about the charge that has to go back');
  assert.ok(orders.getOrderEvents(b.order.id).some((e) => e.type === 'note' && /повторное списание/i.test(e.note)));
  // Click repeats the refused Complete: the same answer, reported once
  assert.equal((await complete(b.order, preparedB)).error, -9);
  assert.equal(orders.getOrderEvents(b.order.id).filter((e) => e.type === 'note' && /повторное списание/i.test(e.note)).length, 1);

  // two Click transactions prepared for one order: the first Complete wins, the second gets -9;
  // a repeated Complete of the WINNER is the only case answered with -4
  const c = makeOrder({ qty: 1 });
  const first = await prepare(c.order);
  const second = await prepare(c.order);
  assert.notEqual(first.res.merchant_prepare_id, second.res.merchant_prepare_id);
  assert.equal((await complete(c.order, second)).error, 0);
  const loser = await complete(c.order, first);
  assert.equal(loser.error, -9);
  assert.equal(loser.merchant_confirm_id, undefined);
  const repeat = await complete(c.order, second);
  assert.deepEqual([repeat.error, repeat.merchant_confirm_id], [-4, second.res.merchant_prepare_id]);
  assert.equal(stockOf(c.product), 9);
  assert.equal(paidRows(c.order.id).length, 1);
  assert.equal(paymentsRepo.getPayment(first.res.merchant_prepare_id).status, 'cancelled');

  // Click reports that it could NOT charge (error < 0) for an already paid order: nothing to return, no alert
  const d = makeOrder({ qty: 1 });
  const preparedD = await prepare(d.order);
  orders.markPaid(d.order.id, { provider: 'manual', actor: 'admin:1' });
  assert.equal((await complete(d.order, preparedD, { error: '-5017', errorNote: 'Insufficient funds' })).error, -9);
  assert.equal(paymentsRepo.getPayment(preparedD.res.merchant_prepare_id).raw.duplicate_reported, undefined);
});

test('stock is checked before Click may charge: Prepare and Complete answer -9 when the goods ran out', async () => {
  const a = makeOrder({ qty: 2, stock: 2 });
  const rival = makeOrderFor(a.product, 2);
  // the rival order takes the whole stock
  orders.markPaid(rival.id, { provider: 'manual' });
  assert.equal(stockOf(a.product), 0);
  assert.equal((await prepare(a.order)).res.error, -9, 'Prepare refuses: nothing is charged');
  assert.equal(orders.getOrder(a.order.id).can_pay, true, 'the order stays payable for when the stock is back');

  // stock runs out between Prepare and Complete
  const b = makeOrder({ qty: 1, stock: 1 });
  const preparedB = await prepare(b.order);
  assert.equal(preparedB.res.error, 0);
  const rivalB = makeOrderFor(b.product, 1);
  orders.markPaid(rivalB.id, { provider: 'manual' });
  assert.equal((await complete(b.order, preparedB)).error, -9);
  assert.equal(orders.getOrder(b.order.id).is_paid, false);
  assert.equal(paymentsRepo.getPayment(preparedB.res.merchant_prepare_id).status, 'cancelled');
  assert.equal(stockOf(b.product), 0);
});

// ─────────────────────────────── transport details

test('callbacks: CSRF-exempt, JSON answers for junk input, structured log without the secret', async () => {
  const { order } = makeOrder();
  logs.length = 0;
  const prepared = await prepare(order);
  await complete(order, prepared);

  const entries = logs.filter((e) => e.event.startsWith('click.'));
  assert.deepEqual(entries.map((e) => [e.event, e.error]), [['click.prepare', 0], ['click.complete', 0]]);
  assert.equal(entries[0].order, String(order.id));
  assert.equal(entries[0].prepare_id, prepared.res.merchant_prepare_id);
  assert.equal(entries[1].confirm_id, prepared.res.merchant_prepare_id);
  const dump = JSON.stringify(logs);
  assert.ok(!dump.includes(CLICK_SECRET_KEY), 'the secret key is never logged');
  assert.ok(!dump.includes(clickSign(prepared.fields)), 'signatures are not logged');

  // JSON bodies are understood as well
  const second = makeOrder().order;
  const fields = clickFields(second);
  const viaJson = await fetch(`${t.baseUrl}/pay/click/prepare`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...fields, sign_string: clickSign(fields) }),
  });
  assert.equal((await viaJson.json()).error, 0);

  // junk never produces an HTML error page or a 5xx
  for (const [contentType, body] of [
    ['application/json', '{"click_trans_id":'],
    ['application/x-www-form-urlencoded', 'amount[]=1&amount[]=2&click_trans_id[a]=1'],
    ['text/plain', 'hello'],
    ['application/x-www-form-urlencoded', ''],
  ]) {
    for (const step of ['prepare', 'complete']) {
      const res = await fetch(`${t.baseUrl}/pay/click/${step}`, { method: 'POST', headers: { 'content-type': contentType }, body });
      assert.equal(res.status, 200, `${step} ${contentType}`);
      assert.equal((await res.json()).error, -8);
    }
  }
  assert.equal(ERROR.BAD_REQUEST, -8);
  assert.equal((await fetch(`${t.baseUrl}/pay/click/prepare`)).status, 404, 'GET is not a callback');
});
