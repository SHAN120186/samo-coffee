import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { get, all, run } from '../src/db/index.js';
import * as cart from '../src/services/cart.js';
import * as catalog from '../src/services/catalog.js';
import * as orders from '../src/services/orders.js';
import * as subscriptions from '../src/services/subscriptions.js';
import * as paymentsRepo from '../src/services/payments.js';
import * as settings from '../src/services/settings.js';
import { bus } from '../src/lib/bus.js';
import { makeCatalog, makePlan, CUSTOMER, DELIVERY } from './helpers/fixtures.js';

const DAY = 86400000;

function placeOrder(products, qty = 2, extra = {}) {
  const ref = { token: cart.newToken() };
  for (const p of products) cart.addItem(ref, p.id, qty);
  return orders.createFromCart(ref, { customer: CUSTOMER, delivery: DELIVERY, sessionId: 'sess-test-1', ...extra });
}

test('cart: add, clamp to stock, totals and delivery fee', () => {
  const { products } = makeCatalog(2, { stock: 3 });
  const ref = { token: cart.newToken() };
  assert.equal(cart.getCart(ref).count, 0);
  cart.addItem(ref, products[0].id, 2);
  let view = cart.addItem(ref, products[0].id, 5);
  assert.equal(view.items[0].qty, 3, 'clamped to stock');
  view = cart.addItem(ref, products[1].id, 1);
  assert.equal(view.count, 4);
  assert.equal(view.subtotal, 3 * 100000 + 120000);
  assert.equal(view.delivery_fee, 0, 'free delivery from 300 000');
  view = cart.setQty(ref, products[0].id, 1);
  assert.equal(view.subtotal, 220000);
  assert.equal(view.delivery_fee, settings.getInt('delivery_fee'));
  assert.equal(view.total, 220000 + 25000);
  assert.equal(view.free_delivery_left, 80000);
  view = cart.removeItem(ref, products[1].id);
  assert.equal(view.items.length, 1);
  assert.equal(cart.calcDelivery(100000, 'pickup'), 0);
  // tg carts are separate
  assert.equal(cart.getCart({ tgUserId: 555 }).count, 0);
  cart.addItem({ tgUserId: 555 }, products[1].id);
  assert.equal(cart.getCart({ tgUserId: 555 }).count, 1);
  assert.equal(cart.getCart(ref).count, 1);
});

test('cart: out of stock and inactive products are rejected', () => {
  const { products } = makeCatalog(1, { stock: 0 });
  assert.throws(() => cart.addItem({ token: cart.newToken() }, products[0].id), (e) => e.code === 'out_of_stock');
  const p2 = catalog.createProduct({ title: 'Скрытый', price: 1000, stock: 5, active: 0 });
  assert.throws(() => cart.addItem({ token: cart.newToken() }, p2.id), (e) => e.code === 'not_found');
});

test('createFromCart: validates input, snapshots items, clears the cart', () => {
  const { products } = makeCatalog(2);
  const ref = { token: cart.newToken() };
  assert.throws(() => orders.createFromCart(ref, { customer: CUSTOMER, delivery: DELIVERY }), (e) => e.code === 'empty_cart');
  cart.addItem(ref, products[0].id, 1);
  assert.throws(() => orders.createFromCart(ref, { customer: { name: '', phone: '123' }, delivery: {} }), (e) => {
    assert.equal(e.code, 'validation');
    assert.deepEqual(Object.keys(e.details.fields).sort(), ['address', 'name', 'phone']);
    return true;
  });
  const order = orders.createFromCart(ref, { customer: CUSTOMER, delivery: DELIVERY, comment: 'Помол под воронку' });
  assert.match(order.number, /^SC-\d{6}$/);
  assert.equal(order.status, 'new');
  assert.equal(order.payment_status, 'unpaid');
  assert.equal(order.customer_phone, '+998901234567');
  assert.equal(order.subtotal, 100000);
  assert.equal(order.delivery_fee, 25000);
  assert.equal(order.total, 125000);
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].title, products[0].title);
  assert.equal(order.can_pay, true);
  assert.match(order.public_token, /^[0-9a-f]{32}$/);
  assert.equal(cart.getCart(ref).count, 0);
  assert.equal(orders.getOrderByToken(order.public_token).id, order.id);
  assert.equal(orders.getOrderByNumber(order.number).id, order.id);
  // pickup: no fee, no address needed
  cart.addItem(ref, products[1].id, 1);
  const pickup = orders.createFromCart(ref, { customer: CUSTOMER, delivery: { method: 'pickup' } });
  assert.equal(pickup.delivery_fee, 0);
  assert.equal(pickup.customer_id, order.customer_id, 'same phone → same customer');
});

test('markPaid: is idempotent and applies side effects exactly once', async () => {
  const { products } = makeCatalog(2, { stock: 10 });
  const order = placeOrder(products, 2);
  const paidEvents = [];
  const listener = (e) => paidEvents.push(e);
  bus.on('order.paid', listener);

  const first = orders.markPaid(order.id, { provider: 'mock', txId: 'tx-1', amount: order.total });
  assert.equal(first.changed, true);
  assert.equal(first.order.status, 'paid');
  assert.equal(first.order.payment_status, 'paid');
  assert.equal(first.order.payment_provider, 'mock');
  assert.ok(first.order.paid_at);
  assert.equal(first.payment.status, 'paid');
  assert.equal(first.payment.provider_tx_id, 'tx-1');
  assert.equal(catalog.getProduct(products[0].id).stock, 8);
  assert.equal(catalog.getProduct(products[1].id).stock, 8);

  const second = orders.markPaid(order.id, { provider: 'mock', txId: 'tx-1', amount: order.total });
  const third = orders.markPaid(order.id, { provider: 'payme', txId: 'another-tx' });
  assert.equal(second.changed, false);
  assert.equal(third.changed, false);
  assert.equal(second.payment.id, first.payment.id);
  assert.equal(catalog.getProduct(products[0].id).stock, 8, 'stock decremented once');
  assert.equal(paymentsRepo.listByOrder(order.id).length, 1, 'one payment row');
  assert.equal(get(`SELECT COUNT(*) AS n FROM events WHERE name = 'purchase' AND order_id = ?`, order.id).n, 1, 'one purchase event');
  assert.equal(get(`SELECT session_id FROM events WHERE name = 'purchase' AND order_id = ?`, order.id).session_id, 'sess-test-1');
  assert.equal(all(`SELECT * FROM order_events WHERE order_id = ? AND type = 'payment'`, order.id).length, 1);
  assert.equal(paidEvents.length, 1, 'bus event emitted once');
  bus.off('order.paid', listener);
});

test('markPaid: rejects a wrong amount and closed orders, reuses provider transactions', () => {
  const { products } = makeCatalog(1);
  const order = placeOrder(products, 1);
  assert.throws(() => orders.markPaid(order.id, { provider: 'mock', txId: 'x', amount: order.total - 1 }), (e) => e.code === 'amount_mismatch');
  assert.equal(orders.getOrder(order.id).payment_status, 'unpaid', 'nothing changed after a failed attempt');
  assert.equal(catalog.getProduct(products[0].id).stock, 10);

  // a provider created its transaction first (Payme-style), markPaid must reuse that row
  const pending = paymentsRepo.createPayment({ orderId: order.id, provider: 'payme', providerTxId: 'payme-tx-9', amount: order.total, status: 'pending', state: 1 });
  const result = orders.markPaid(order.id, { provider: 'payme', txId: 'payme-tx-9', amount: order.total });
  assert.equal(result.payment.id, pending.id);
  assert.equal(result.payment.status, 'paid');
  assert.ok(result.payment.perform_time > 0);
  assert.equal(paymentsRepo.listByOrder(order.id).length, 1);

  const cancelled = placeOrder(products, 1);
  orders.cancel(cancelled.id, { reason: 'test' });
  assert.throws(() => orders.markPaid(cancelled.id, { provider: 'mock' }), (e) => e.code === 'order_closed');
  assert.throws(() => orders.markPaid(999999, {}), (e) => e.code === 'not_found');
});

test('markPaymentFailed keeps the order payable; markPendingPayment is idempotent', () => {
  const { products } = makeCatalog(1);
  const order = placeOrder(products, 1);
  const pending = orders.markPendingPayment(order.id, 'mock');
  assert.equal(pending.status, 'pending_payment');
  assert.equal(pending.payment_status, 'pending');
  orders.markPendingPayment(order.id, 'mock');
  assert.equal(orders.getOrderEvents(order.id).filter((e) => e.to_value === 'pending_payment').length, 1);
  const failed = orders.markPaymentFailed(order.id, { provider: 'mock', reason: 'declined' });
  assert.equal(failed.order.payment_status, 'failed');
  assert.equal(failed.order.can_pay, true);
  const paid = orders.markPaid(order.id, { provider: 'mock', txId: 'retry-1' });
  assert.equal(paid.changed, true);
  assert.equal(orders.markPaymentFailed(order.id, {}).changed, false, 'no-op after payment');
  assert.equal(orders.getOrder(order.id).payment_status, 'paid');
});

test('status machine: setStatus, cancel, refund', () => {
  const { products } = makeCatalog(1, { stock: 5 });
  const order = placeOrder(products, 2);
  assert.throws(() => orders.setStatus(order.id, 'shipped'), (e) => e.code === 'bad_transition');
  assert.throws(() => orders.refund(order.id), (e) => e.code === 'not_paid');
  assert.equal(orders.setStatus(order.id, 'paid', { actor: 'admin:1' }).order.payment_status, 'paid', 'manual payment goes through markPaid');
  assert.equal(catalog.getProduct(products[0].id).stock, 3);
  assert.throws(() => orders.cancel(order.id), (e) => e.code === 'paid_order');
  assert.equal(orders.setStatus(order.id, 'processing').order.status, 'processing');
  assert.equal(orders.setStatus(order.id, 'shipped').order.status, 'shipped');
  assert.equal(orders.setStatus(order.id, 'shipped').changed, false);
  assert.deepEqual(orders.allowedTransitions(orders.getOrder(order.id)).map((t) => t.status), ['delivered', 'refunded']);

  const refunded = orders.refund(order.id, { reason: 'test' });
  assert.equal(refunded.changed, true);
  assert.equal(refunded.order.status, 'refunded');
  assert.equal(refunded.order.payment_status, 'refunded');
  assert.equal(catalog.getProduct(products[0].id).stock, 5, 'stock returned');
  assert.equal(paymentsRepo.listByOrder(order.id)[0].status, 'refunded');
  assert.equal(orders.refund(order.id).changed, false, 'refund is idempotent');
  assert.equal(catalog.getProduct(products[0].id).stock, 5);
  assert.throws(() => orders.setStatus(order.id, 'delivered'), (e) => e.code === 'bad_transition');
});

test('subscription order: markPaid activates, second payment extends, refund reverts', () => {
  const plan = makePlan({ period_days: 30 });
  const input = { planId: plan.id, customer: { name: 'Подписчик', phone: '+998 93 555 00 11' }, tgUserId: 424242, channel: 'tma' };
  const order = orders.createSubscriptionOrder(input);
  assert.equal(order.kind, 'subscription');
  assert.equal(order.total, plan.price);
  assert.equal(order.delivery_fee, 0);
  assert.equal(order.items[0].plan_id, plan.id);
  assert.equal(subscriptions.getCurrentForTgUser(424242), null, 'no subscription before payment');

  const paid = orders.markPaid(order.id, { provider: 'telegram', txId: 'tg-charge-1', amount: plan.price });
  assert.equal(paid.changed, true);
  const sub = subscriptions.getCurrentForTgUser(424242);
  assert.ok(sub);
  assert.equal(sub.id, paid.subscription.id);
  assert.equal(sub.status, 'active');
  assert.equal(sub.plan_id, plan.id);
  assert.equal(sub.renewals, 0);
  const end1 = Date.parse(sub.current_period_end);
  assert.ok(Math.abs(end1 - (Date.now() + 30 * DAY)) < 5000);

  orders.markPaid(order.id, { provider: 'telegram', txId: 'tg-charge-1' });
  assert.equal(Date.parse(subscriptions.getSubscription(sub.id).current_period_end), end1, 'idempotent: no double extension');
  assert.equal(get('SELECT COUNT(*) AS n FROM subscriptions WHERE customer_id = ?', order.customer_id).n, 1);

  const renewal = orders.createSubscriptionOrder(input);
  orders.markPaid(renewal.id, { provider: 'telegram', txId: 'tg-charge-2' });
  const renewed = subscriptions.getSubscription(sub.id);
  assert.equal(renewed.renewals, 1);
  assert.equal(Date.parse(renewed.current_period_end), end1 + 30 * DAY, 'extended from the current period end');
  assert.equal(renewed.last_order_id, renewal.id);
  assert.equal(renewed.days_left, 60);

  orders.refund(renewal.id);
  const reverted = subscriptions.getSubscription(sub.id);
  assert.equal(reverted.renewals, 0);
  assert.equal(Date.parse(reverted.current_period_end), end1);

  // switching plan cancels the old subscription and starts a new one
  const plan2 = makePlan({ title: 'Другой план', price: 379000 });
  const switchOrder = orders.createSubscriptionOrder({ ...input, planId: plan2.id });
  const switched = orders.markPaid(switchOrder.id, { provider: 'mock' });
  assert.notEqual(switched.subscription.id, sub.id);
  assert.equal(subscriptions.getSubscription(sub.id).status, 'cancelled');
  assert.equal(subscriptions.getCurrentForTgUser(424242).plan_id, plan2.id);

  // pause / resume / expire
  assert.equal(subscriptions.pauseSubscription(switched.subscription.id).status, 'paused');
  assert.equal(subscriptions.resumeSubscription(switched.subscription.id).status, 'active');
  assert.throws(() => subscriptions.setSubscriptionStatus(sub.id, 'active'), (e) => e.code === 'bad_transition');
});

test('listOrders: filters and counters', () => {
  const { products } = makeCatalog(1);
  const a = placeOrder(products, 1, { customer: { name: 'Уникальный Покупатель', phone: '+998 97 700 11 22' }, channel: 'tma', tgUserId: 9001 });
  orders.markPaid(a.id, { provider: 'mock' });
  assert.equal(orders.listOrders({ search: 'уникальный покуп' }).items[0].id, a.id, 'case-insensitive cyrillic search');
  assert.equal(orders.listOrders({ search: '977001122' }).items[0].id, a.id);
  assert.equal(orders.listOrders({ search: a.number }).total, 1);
  assert.equal(orders.listOrders({ tgUserId: 9001 }).total, 1);
  assert.equal(orders.listForTgUser(9001)[0].items.length, 1);
  assert.ok(orders.listOrders({ status: 'paid', channel: 'tma' }).items.every((o) => o.status === 'paid' && o.channel === 'tma'));
  const counts = orders.countByStatus();
  assert.equal(counts.all, orders.listOrders({ limit: 500 }).total);
  assert.ok(counts.paid >= 1);
});

test('refunding ANY order of a subscription reverts exactly its period; the subscription ends when nothing paid is left', () => {
  const plan = makePlan({ period_days: 30 });
  const subscribe = (phone, planId = plan.id) => {
    const order = orders.createSubscriptionOrder({ planId, customer: { name: 'Подписчик', phone } });
    orders.markPaid(order.id, { provider: 'mock', amount: order.total });
    return orders.getOrder(order.id);
  };
  const daysLeft = (id) => Math.round((Date.parse(subscriptions.getSubscription(id).current_period_end) - Date.now()) / DAY);

  // refund the FIRST order, then the renewal
  const a1 = subscribe('+998 93 700 00 01');
  const b1 = subscribe('+998 93 700 00 01');
  const sub1 = subscriptions.getCurrentForCustomer(a1.customer_id);
  assert.deepEqual([sub1.renewals, daysLeft(sub1.id), sub1.last_order_id], [1, 60, b1.id]);
  orders.refund(a1.id);
  let s = subscriptions.getSubscription(sub1.id);
  assert.deepEqual([s.status, s.renewals, daysLeft(s.id), s.last_order_id], ['active', 0, 30, b1.id], 'the older order is reverted too');
  orders.refund(b1.id);
  s = subscriptions.getSubscription(sub1.id);
  assert.equal(s.status, 'cancelled', 'both orders refunded → no subscription');
  assert.equal(subscriptions.getCurrentForCustomer(a1.customer_id), null);

  // refund the renewal, then the first order
  const a2 = subscribe('+998 93 700 00 02');
  const b2 = subscribe('+998 93 700 00 02');
  const sub2 = subscriptions.getCurrentForCustomer(a2.customer_id);
  orders.refund(b2.id);
  s = subscriptions.getSubscription(sub2.id);
  assert.deepEqual([s.status, s.renewals, daysLeft(s.id), s.last_order_id], ['active', 0, 30, a2.id]);
  orders.refund(a2.id);
  assert.equal(subscriptions.getSubscription(sub2.id).status, 'cancelled');
  assert.equal(orders.refund(a2.id).changed, false, 'idempotent');
  assert.equal(subscriptions.getSubscription(sub2.id).status, 'cancelled');

  // three periods, the middle one refunded: one period less, still active
  const a3 = subscribe('+998 93 700 00 03');
  const b3 = subscribe('+998 93 700 00 03');
  const c3 = subscribe('+998 93 700 00 03');
  const sub3 = subscriptions.getCurrentForCustomer(a3.customer_id);
  assert.equal(daysLeft(sub3.id), 90);
  orders.refund(b3.id);
  s = subscriptions.getSubscription(sub3.id);
  assert.deepEqual([s.status, s.renewals, daysLeft(s.id), s.last_order_id], ['active', 1, 60, c3.id]);
  assert.deepEqual(all('SELECT order_id, reverted_at IS NOT NULL AS reverted FROM subscription_periods WHERE subscription_id = ? ORDER BY id', sub3.id),
    [{ order_id: a3.id, reverted: 0 }, { order_id: b3.id, reverted: 1 }, { order_id: c3.id, reverted: 0 }]);

  // an order for ANOTHER plan replaced the subscription; refunding it gives the paid one back
  const plan2 = makePlan({ title: 'Второй план', period_days: 30 });
  const a4 = subscribe('+998 93 700 00 04');
  const first = subscriptions.getCurrentForCustomer(a4.customer_id);
  const b4 = subscribe('+998 93 700 00 04', plan2.id);
  const second = subscriptions.getCurrentForCustomer(a4.customer_id);
  assert.deepEqual([subscriptions.getSubscription(first.id).status, second.plan_id], ['cancelled', plan2.id]);
  orders.refund(b4.id);
  assert.equal(subscriptions.getSubscription(second.id).status, 'cancelled');
  const restored = subscriptions.getSubscription(first.id);
  assert.deepEqual([restored.status, restored.cancelled_at, daysLeft(first.id)], ['active', null, 30], 'the subscription the customer still paid for is back');
  assert.equal(subscriptions.getCurrentForCustomer(a4.customer_id).id, first.id);

  // a subscription paid before periods were recorded (no subscription_periods rows) still reverts
  const a5 = subscribe('+998 93 700 00 05');
  const b5 = subscribe('+998 93 700 00 05');
  const sub5 = subscriptions.getCurrentForCustomer(a5.customer_id);
  run('DELETE FROM subscription_periods WHERE subscription_id = ?', sub5.id);
  orders.refund(a5.id);
  s = subscriptions.getSubscription(sub5.id);
  assert.deepEqual([s.status, s.renewals, daysLeft(s.id)], ['active', 0, 30]);
  orders.refund(b5.id);
  assert.equal(subscriptions.getSubscription(sub5.id).status, 'cancelled');
});

test('an oversold order takes only what the stock has; the refund returns exactly that (no phantom stock)', () => {
  const { products } = makeCatalog(1, { stock: 1 });
  const [product] = products;
  const a = placeOrder([product], 1);
  const b = placeOrder([product], 1, { customer: { ...CUSTOMER, phone: '+998 90 222 33 44' } });
  assert.deepEqual(orders.stockShortage(a), []);

  orders.markPaid(a.id, { provider: 'mock' });
  assert.equal(catalog.getProduct(product.id).stock, 0);
  assert.equal(orders.getOrder(a.id).items[0].stock_taken, 1);
  assert.deepEqual(orders.stockShortage(orders.getOrder(b.id)), [{ product_id: product.id, title: product.title, qty: 1, stock: 0 }]);
  assert.match(orders.stockShortageMessage(orders.getOrder(b.id)), /закончился/);

  // B is paid anyway (e.g. "mark as paid" in the panel): nothing is taken, and that is on record
  orders.markPaid(b.id, { provider: 'manual', actor: 'admin:1' });
  assert.equal(catalog.getProduct(product.id).stock, 0);
  assert.equal(orders.getOrder(b.id).items[0].stock_taken, 0);
  assert.ok(orders.getOrderEvents(b.id).some((e) => e.type === 'note' && /Не хватило на складе/.test(e.note)));

  orders.refund(b.id);
  assert.equal(catalog.getProduct(product.id).stock, 0, 'the only unit went to order A — refunding B creates nothing');
  orders.refund(a.id);
  assert.equal(catalog.getProduct(product.id).stock, 1);

  // subscription orders never have a shortage
  const plan = makePlan();
  assert.deepEqual(orders.stockShortage(orders.createSubscriptionOrder({ planId: plan.id, customer: CUSTOMER })), []);
});
