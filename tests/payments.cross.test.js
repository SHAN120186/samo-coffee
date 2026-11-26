// Cross-provider rules: with mock, Telegram, Payme and Click all configured, an order can be paid
// EXACTLY ONCE whichever provider reports first and however many duplicates follow; the hosted
// entry sends the customer to the active provider; the return page waits for in-flight callbacks.
import { FAKE_TG_PORT } from './payments.env-telegram.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/http.js';
import { startFakeTelegram } from './helpers/fakeTelegram.js';
import { config } from '../src/config.js';
import * as orders from '../src/services/orders.js';
import * as settings from '../src/services/settings.js';
import * as notify from '../src/services/notify.js';
import * as paymentsRepo from '../src/services/payments.js';
import * as telegramPayments from '../src/services/telegramPayments.js';
import { startPayment, listProviders, resolveProvider } from '../src/payments/index.js';
import { checkoutUrl } from '../src/payments/providers/payme.js';
import { payUrl } from '../src/payments/providers/click.js';
import {
  makeOrder, makeSubscriptionOrder, paymeClient, paymeTxId, clickClient, clickFields,
  stockOf, purchaseEvents, paidRows,
} from './payments.helpers.js';
import * as subscriptions from '../src/services/subscriptions.js';

let t;
let fake;
let rpc;
let click;
before(async () => {
  fake = await startFakeTelegram(FAKE_TG_PORT);
  t = await startTestApp();
  rpc = paymeClient(t.baseUrl);
  click = clickClient(t.baseUrl);
});
after(async () => {
  settings.set('payment_provider', '');
  await notify.flush();
  await t.close();
  await fake.close();
});

const pathOf = (url) => new URL(url, t.baseUrl).pathname;
const paymeCreate = async (order, id = paymeTxId()) => ({ id, res: await rpc('CreateTransaction', { id, time: Date.now(), amount: order.total * 100, account: { order_id: String(order.id) } }) });
const clickPrepare = async (order) => {
  const fields = clickFields(order);
  return { fields, res: await click('prepare', fields) };
};
const clickComplete = (order, prepared, over = {}) => click('complete', clickFields(order, { clickTransId: prepared.fields.click_trans_id, prepareId: prepared.res.merchant_prepare_id, ...over }));
/** [ok, reason, repeated] of a handleSuccessfulPayment result. */
const dup = (r) => [r.ok, r.reason, r.repeated];
const tgPaid = (order, chargeId) => telegramPayments.handleSuccessfulPayment({ invoice_payload: `order:${order.id}`, currency: 'UZS', total_amount: order.total * 100, telegram_payment_charge_id: chargeId });

/** Open an attempt with every provider for one order; returns the handles. */
async function openEverywhere(order) {
  const c = t.newClient();
  const mock = await startPayment(order, { providerId: 'mock' });
  await c.get(mock.redirectUrl); // CSRF token for the mock form
  const tg = await startPayment(order, { providerId: 'telegram' });
  const payme = await paymeCreate(order);
  assert.equal(payme.res.result.state, 1);
  const prepared = await clickPrepare(order);
  assert.equal(prepared.res.error, 0);
  return { c, mockPath: pathOf(mock.redirectUrl), tg, payme, prepared };
}

function assertPaidOnce(order, product, { qty, provider }) {
  const fresh = orders.getOrder(order.id);
  assert.deepEqual([fresh.status, fresh.payment_status, fresh.payment_provider], ['paid', 'paid', provider]);
  assert.equal(stockOf(product), 10 - qty, 'stock decremented exactly once');
  assert.equal(purchaseEvents(order.id), 1, 'one purchase event');
  const rows = paymentsRepo.listByOrder(order.id);
  assert.equal(rows.filter((p) => p.status === 'paid').length, 1, 'exactly one paid payment row');
  assert.equal(paidRows(order.id)[0].provider, provider);
  assert.equal(orders.getOrderEvents(order.id).filter((e) => e.type === 'payment' && e.to_value === 'paid').length, 1);
}

test('all four providers are configured; the hosted entry follows the active one', async () => {
  assert.deepEqual(listProviders().map((p) => [p.id, p.configured]), [['mock', true], ['telegram', true], ['payme', true], ['click', true]]);
  const { order } = makeOrder();
  const c = t.newClient();
  const entry = `/pay/order/${order.public_token}`;

  assert.match((await c.get(entry)).location, /\/pay\/mock\/mock_[0-9a-f]{24}$/);
  settings.set('payment_provider', 'payme');
  assert.equal(resolveProvider().id, 'payme');
  assert.equal((await c.get(entry)).location, checkoutUrl(order));
  assert.match((await c.get(entry)).location, /^https:\/\/checkout\.test\.paycom\.uz\/[A-Za-z0-9+/=]+$/);
  settings.set('payment_provider', 'click');
  assert.equal((await c.get(entry)).location, payUrl(order));
  settings.set('payment_provider', 'telegram');
  assert.equal((await c.get(entry)).location, `/pay/invoice/${order.public_token}`);
  settings.set('payment_provider', '');

  const fresh = orders.getOrder(order.id);
  assert.deepEqual([fresh.status, fresh.payment_provider, fresh.is_paid], ['pending_payment', 'telegram', false]);
  // one open attempt per provider, each with the right amount
  const rows = paymentsRepo.listByOrder(order.id);
  assert.deepEqual(rows.map((p) => p.provider).sort(), ['click', 'mock', 'payme', 'telegram']);
  assert.ok(rows.every((p) => p.amount === order.total && ['created', 'pending'].includes(p.status)));
});

test('Click completes first → Payme, mock, Telegram and a second Click are all refused', async () => {
  const { order, product } = makeOrder({ qty: 2 });
  const h = await openEverywhere(order);
  const rival = await clickPrepare(order);

  assert.equal((await clickComplete(order, h.prepared)).error, 0);
  assertPaidOnce(order, product, { qty: 2, provider: 'click' });

  assert.equal((await rpc('PerformTransaction', { id: h.payme.id })).error.code, -31008);
  assert.equal((await rpc('CheckTransaction', { id: h.payme.id })).result.state, -1, 'the Payme transaction is cancelled, Payme returns the money');
  assert.equal((await paymeCreate(order)).res.error.code, -31051);
  assert.equal((await rpc('CheckPerformTransaction', { amount: order.total * 100, account: { order_id: String(order.id) } })).error.code, -31051);
  assert.equal((await h.c.postForm(h.mockPath, { action: 'success' })).status, 303);
  // a real Telegram charge that arrives after the order was paid is NOT a replay: it is recorded and reported
  assert.deepEqual(dup(tgPaid(order, 'tg-late-1')), [false, 'duplicate_charge', false]);
  assert.deepEqual(dup(tgPaid(order, 'tg-late-1')), [false, 'duplicate_charge', true], 're-delivery of that update is recognised');
  assert.equal(telegramPayments.validatePreCheckout({ invoice_payload: `order:${order.id}`, currency: 'UZS', total_amount: order.total * 100 }).ok, false);
  assert.equal((await clickComplete(order, rival)).error, -9, 'a second Click charge is refused (Click reverses it), not confirmed');
  await notify.flush();
  assert.ok(fake.callsTo('sendMessage').some((p) => p.text.includes('Click: второе списание') && p.text.includes(order.number)), 'the admins are told about the second Click charge');
  assert.equal((await clickComplete(order, h.prepared)).error, -4, 'only a repeat of the winning Complete is "already paid"');
  await assert.rejects(() => startPayment(orders.getOrder(order.id)), (e) => e.code === 'already_paid');

  assertPaidOnce(order, product, { qty: 2, provider: 'click' });
  assert.ok(paymentsRepo.listByOrder(order.id).every((p) => ['paid', 'cancelled', 'failed'].includes(p.status)), 'no attempt is left open');
  const late = paymentsRepo.findByProviderTx('telegram', 'tg-late-1');
  assert.deepEqual([late.status, late.amount], ['failed', order.total], 'the duplicate Telegram charge is on record');
  assert.match(late.error, /Повторное списание/);
});

test('Payme performs first → Click, mock and Telegram are refused', async () => {
  const { order, product } = makeOrder({ qty: 3 });
  const h = await openEverywhere(order);

  assert.equal((await rpc('PerformTransaction', { id: h.payme.id })).result.state, 2);
  assertPaidOnce(order, product, { qty: 3, provider: 'payme' });

  assert.equal((await clickComplete(order, h.prepared)).error, -9);
  assert.equal((await clickPrepare(order)).res.error, -4, 'a new Prepare for a paid order: nothing was charged yet');
  assert.equal((await h.c.postForm(h.mockPath, { action: 'success' })).status, 303);
  assert.equal(tgPaid(order, 'tg-late-2').reason, 'duplicate_charge');
  assert.equal((await rpc('PerformTransaction', { id: h.payme.id })).result.state, 2, 'the winner stays idempotent');
  assert.equal((await paymeCreate(order)).res.error.code, -31051);

  assertPaidOnce(order, product, { qty: 3, provider: 'payme' });
});

test('mock pays first → Payme and Click callbacks are refused; Telegram first → the same', async () => {
  const a = makeOrder({ qty: 1 });
  const ha = await openEverywhere(a.order);
  assert.equal((await ha.c.postForm(ha.mockPath, { action: 'success' })).status, 303);
  assertPaidOnce(a.order, a.product, { qty: 1, provider: 'mock' });
  assert.equal((await rpc('PerformTransaction', { id: ha.payme.id })).error.code, -31008);
  assert.equal((await clickComplete(a.order, ha.prepared)).error, -9);
  assert.equal(tgPaid(a.order, 'tg-late-3').reason, 'duplicate_charge');
  assertPaidOnce(a.order, a.product, { qty: 1, provider: 'mock' });

  const b = makeOrder({ qty: 4 });
  const hb = await openEverywhere(b.order);
  assert.deepEqual([tgPaid(b.order, 'tg-first-1').ok, tgPaid(b.order, 'tg-first-1').changed], [true, false], 'second delivery of the same update');
  assertPaidOnce(b.order, b.product, { qty: 4, provider: 'telegram' });
  assert.equal(paidRows(b.order.id)[0].provider_tx_id, 'tg-first-1');
  assert.equal((await rpc('PerformTransaction', { id: hb.payme.id })).error.code, -31008);
  assert.equal((await clickComplete(b.order, hb.prepared)).error, -9);
  assert.equal((await hb.c.postForm(hb.mockPath, { action: 'success' })).status, 303);
  // a second, different Telegram charge for the order Telegram already paid
  assert.deepEqual(dup(tgPaid(b.order, 'tg-second-1')), [false, 'duplicate_charge', false]);
  assertPaidOnce(b.order, b.product, { qty: 4, provider: 'telegram' });
});

test('a subscription paid twice by different providers is extended once', async () => {
  const { order, plan } = makeSubscriptionOrder({ price: 329000 });
  const payme = await paymeCreate(order);
  const prepared = await clickPrepare(order);
  assert.equal((await clickComplete(order, prepared)).error, 0);
  const sub = subscriptions.getCurrentForCustomer(orders.getOrder(order.id).customer_id);
  assert.deepEqual([sub.plan_id, sub.status], [plan.id, 'active']);
  assert.equal((await rpc('PerformTransaction', { id: payme.id })).error.code, -31008);
  assert.equal(tgPaid(order, 'tg-sub-late').reason, 'duplicate_charge');
  const after = subscriptions.getSubscription(sub.id);
  assert.deepEqual([after.current_period_end, after.renewals], [sub.current_period_end, sub.renewals]);
});

test('a failed attempt with one provider does not block paying with another', async () => {
  const { order, product } = makeOrder({ qty: 1 });
  const payme = await paymeCreate(order);
  assert.equal((await rpc('CancelTransaction', { id: payme.id, reason: 2 })).result.state, -1);
  const prepared = await clickPrepare(order);
  assert.equal((await clickComplete(order, prepared, { error: '-5017', errorNote: 'Insufficient funds' })).error, -9);
  assert.equal(orders.getOrder(order.id).can_pay, true);

  const c = t.newClient();
  const start = await c.get(order.pay_url);
  await c.get(start.location);
  await c.postForm(pathOf(start.location), { action: 'success' });
  assertPaidOnce(order, product, { qty: 1, provider: 'mock' });
  assert.deepEqual(paymentsRepo.listByOrder(order.id).map((p) => [p.provider, p.status]), [['mock', 'paid'], ['click', 'cancelled'], ['payme', 'cancelled']]);
});

test('/pay/return waits while a provider transaction is in flight and never believes the query string', async () => {
  settings.set('payment_provider', 'payme');
  const { order } = makeOrder();
  const c = t.newClient();
  const ret = `/pay/return/${order.public_token}`;
  await c.get(`/pay/order/${order.public_token}?return=${encodeURIComponent(`/order/${order.public_token}?from=payme`)}`);
  const target = `/order/${order.public_token}?from=payme`;

  // the customer came back without paying: straight to the order
  const idle = await c.get(`${ret}?status=success`);
  assert.equal(idle.status, 303);
  assert.equal(idle.location, target);

  // Payme created the transaction (the customer entered the card) but has not confirmed it yet
  const payme = await paymeCreate(order);
  const waiting = await c.get(`${ret}?payment_status=2&paid=true`);
  assert.equal(waiting.status, 200);
  assert.equal(waiting.headers.get('cache-control'), 'no-store');
  assert.ok(waiting.text.includes(order.number));
  assert.ok(waiting.text.includes('data-pay-wait'));
  assert.ok(waiting.text.includes(`/pay/status/${order.public_token}`));
  assert.match(waiting.text, /<noscript><meta http-equiv="refresh"/);
  assert.equal(orders.getOrder(order.id).is_paid, false, 'the query string pays nothing');
  assert.equal((await c.get(`/pay/status/${order.public_token}`)).json().paid, false);

  await rpc('PerformTransaction', { id: payme.id });
  assert.equal((await c.get(`/pay/status/${order.public_token}`)).json().paid, true);
  const done = await c.get(ret);
  assert.equal(done.status, 303);
  assert.equal(done.location, target);

  // Click: prepared but not completed → wait; cancelled by Click → no more waiting
  settings.set('payment_provider', 'click');
  const second = makeOrder().order;
  await c.get(`/pay/order/${second.public_token}`);
  const prepared = await clickPrepare(second);
  assert.equal((await c.get(`/pay/return/${second.public_token}`)).status, 200);
  await clickComplete(second, prepared, { error: '-1' });
  const back = await c.get(`/pay/return/${second.public_token}`);
  assert.equal(back.status, 303);
  assert.equal(back.location, `/order/${second.public_token}`);
  settings.set('payment_provider', '');
});
