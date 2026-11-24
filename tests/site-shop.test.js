import './helpers/env.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/http.js';
import { get, all } from '../src/db/index.js';
import * as catalog from '../src/services/catalog.js';
import * as orders from '../src/services/orders.js';
import * as settings from '../src/services/settings.js';
import * as subscriptions from '../src/services/subscriptions.js';
import * as content from '../src/services/content.js';
import { pageContent } from '../src/site/blocks.js';
import { makeCatalog, makePlan } from './helpers/fixtures.js';

let t;
let products;
let plan;
before(async () => {
  ({ products } = makeCatalog(3, { stock: 5 })); // 100 000, 120 000, 140 000 сум
  plan = makePlan({ title: 'Для двоих', price: 379000 });
  t = await startTestApp();
});
after(async () => {
  await t.close();
});

const count = (sql, ...params) => get(sql, ...params).n;
const path = (url) => new URL(url, 'http://localhost').pathname;
const ADDRESS = 'Ташкент, ул. Амира Темура, 15';
const PERSON = { name: 'Алишер Навоий', phone: '+998 90 123 45 67', email: 'alisher@example.com' };

/** Fresh visitor with a CSRF token and `qty` units of a product in the cart. */
async function shopper(items = [[0, 1]]) {
  const c = t.newClient();
  await c.get('/catalog');
  for (const [index, qty] of items) {
    const res = await c.postForm('/cart/add', { product_id: String(products[index].id), qty: String(qty), redirect: '/catalog' });
    assert.equal(res.status, 303);
  }
  return c;
}

/** Walk the hosted mock payment page: returns the response of the final redirect target. */
async function payMock(c, payUrl, action = 'success') {
  const start = await c.get(payUrl);
  assert.equal(start.status, 302);
  assert.match(start.location, /\/pay\/mock\/mock_[0-9a-f]{24}$/);
  const page = await c.get(start.location);
  assert.equal(page.status, 200);
  const done = await c.postForm(path(start.location), { action });
  assert.equal(done.status, 303);
  return c.get(done.location);
}

test('cart without JavaScript: add → flash + redirect back, update, remove, clear', async () => {
  const c = t.newClient();
  const empty = await c.get('/cart');
  assert.ok(empty.text.includes(content.get('cart', 'empty_title')));
  assert.equal(c.jar.has('sc_cart'), false, 'no cart cookie until something is added');

  const product = products[0];
  const page = await c.get(product.url);
  assert.match(page.text, /<form class="buy" method="post" action="\/cart\/add"/);
  const added = await c.postForm('/cart/add', { product_id: String(product.id), qty: '2', redirect: product.url });
  assert.equal(added.status, 303);
  assert.equal(added.location, product.url);
  assert.ok(c.jar.has('sc_cart'));

  const back = await c.get(added.location);
  assert.ok(back.text.includes(`«${product.title}» — в корзине`), 'flash message');
  assert.match(back.text, /data-cart-count>2<\/span>/, 'header counter');
  assert.ok(back.text.includes('Уже в корзине: 2 шт.'));

  const event = get(`SELECT * FROM events WHERE name = 'add_to_cart' ORDER BY id DESC LIMIT 1`);
  assert.equal(event.product_id, product.id);
  assert.equal(event.value, product.price);
  assert.equal(event.session_id, c.jar.get('sc_sid'));
  assert.equal(event.channel, 'site');

  let cart = await c.get('/cart');
  assert.equal(cart.headers.get('cache-control'), 'no-store');
  assert.ok(cart.text.includes(product.title));
  assert.match(cart.text, /data-testid="cart-total">225 000 сум</, '2 × 100 000 + 25 000 delivery');
  assert.ok(cart.text.includes('До бесплатной доставки'));

  const updated = await c.postForm('/cart/update', { product_id: String(product.id), qty: '3' });
  assert.equal(updated.status, 303);
  assert.equal(updated.location, '/cart');
  cart = await c.get('/cart');
  assert.match(cart.text, /data-testid="cart-total">300 000 сум</, 'free delivery from 300 000');
  assert.ok(cart.text.includes('Доставка по Ташкенту — бесплатно'));

  await c.postForm('/cart/add', { product_id: String(products[1].id), qty: '1', redirect: '//evil.example/x' }).then((res) => {
    assert.equal(res.location, '/cart', 'open redirects are refused');
  });
  await c.postForm('/cart/remove', { product_id: String(product.id) });
  cart = await c.get('/cart');
  assert.ok(!cart.text.includes(`data-cart-line="${product.id}"`));
  assert.ok(cart.text.includes(`data-cart-line="${products[1].id}"`));

  await c.postForm('/cart/clear', {});
  assert.ok((await c.get('/cart')).text.includes('data-testid="cart-empty"'));
});

test('cart with fetch(): JSON contract, stock limits, errors', async () => {
  const c = t.newClient();
  await c.get('/');
  const product = products[2]; // stock 5

  const first = await c.postJson('/cart/add', { product_id: product.id, qty: 2 });
  assert.equal(first.status, 200);
  const body = first.json();
  assert.equal(body.ok, true);
  assert.equal(body.cart.count, 2);
  assert.equal(body.cart.subtotal, 280000);
  assert.equal(body.cart.text.subtotal, '280 000 сум');
  assert.equal(body.cart.text.count, '2 товара');
  assert.equal(body.cart.items[0].line_total_text, '280 000 сум');
  assert.match(body.message, /в корзине$/);

  const clamped = (await c.postJson('/cart/add', { product_id: product.id, qty: 20 })).json();
  assert.equal(clamped.cart.count, 5, 'quantity is clamped to stock');
  assert.equal(clamped.cart.text.delivery, 'Бесплатно');

  const set = (await c.postJson('/cart/update', { product_id: product.id, qty: 1 })).json();
  assert.equal(set.cart.count, 1);
  assert.equal(set.cart.total, 140000 + 25000);
  assert.equal(set.cart.free_delivery_left, 160000);

  const missing = await c.postJson('/cart/add', { product_id: 999999, qty: 1 });
  assert.equal(missing.status, 404);
  assert.equal(missing.json().ok, false);

  const sold = catalog.createProduct({ title: 'Распроданный лот', price: 90000, stock: 0 });
  const out = await c.postJson('/cart/add', { product_id: sold.id });
  assert.equal(out.status, 409);
  assert.equal(out.json().error, 'out_of_stock');
  const outForm = await c.postForm('/cart/add', { product_id: String(sold.id), redirect: '/catalog' });
  assert.equal(outForm.status, 303);
  assert.ok((await c.get('/catalog')).text.includes('закончился'), 'the error is shown as a flash message');

  const removed = (await c.postJson('/cart/remove', { product_id: product.id })).json();
  assert.equal(removed.cart.count, 0);

  const noCsrf = await c.request('POST', '/cart/add', { headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ product_id: product.id }) });
  assert.equal(noCsrf.status, 403);
});

test('checkout → mock payment → paid order page (courier, delivery fee)', async () => {
  const c = await shopper([[0, 2]]); // 200 000 сум → delivery 25 000
  const stockBefore = catalog.getProduct(products[0].id).stock;

  const form = await c.get('/checkout');
  assert.equal(form.status, 200);
  assert.match(form.text, /data-testid="checkout-total">225 000 сум</);
  const begin = get(`SELECT * FROM events WHERE name = 'begin_checkout' ORDER BY id DESC LIMIT 1`);
  assert.equal(begin.session_id, c.jar.get('sc_sid'));
  assert.equal(begin.value, 200000);

  const invalid = await c.postForm('/checkout', { name: '', phone: '12345', method: 'courier', address: '', comment: 'Помол под воронку' });
  assert.equal(invalid.status, 422);
  assert.match(invalid.text, /data-testid="checkout-errors"/);
  for (const message of ['Укажите имя', 'Укажите телефон в формате', 'Укажите адрес доставки']) assert.ok(invalid.text.includes(message), message);
  assert.ok(invalid.text.includes('value="12345"'), 'entered values are kept');
  assert.ok(invalid.text.includes('Помол под воронку</textarea>'));
  assert.equal(count('SELECT COUNT(*) AS n FROM orders'), 0);

  const placed = await c.postForm('/checkout', { ...PERSON, method: 'courier', address: ADDRESS, comment: 'Помол под воронку' });
  assert.equal(placed.status, 303);
  assert.match(placed.location, /^\/pay\/order\/[0-9a-f]{32}$/);
  const order = orders.getOrderByToken(placed.location.split('/').pop());
  assert.equal(order.channel, 'site');
  assert.equal(order.status, 'new');
  assert.equal(order.subtotal, 200000);
  assert.equal(order.delivery_fee, 25000);
  assert.equal(order.total, 225000);
  assert.equal(order.customer_phone, '+998901234567');
  assert.equal(order.delivery_address, ADDRESS);
  assert.equal(order.comment, 'Помол под воронку');
  assert.equal(order.session_id, c.jar.get('sc_sid'), 'the order is linked to the analytics session');
  assert.ok((await c.get('/cart')).text.includes('data-testid="cart-empty"'), 'the cart is emptied');

  // the status page before paying: payable, not indexed, not cached
  const pending = await c.get(order.url);
  assert.equal(pending.status, 200);
  assert.equal(pending.headers.get('cache-control'), 'no-store');
  assert.match(pending.text, /<meta name="robots" content="noindex, nofollow">/);
  assert.ok(pending.text.includes(content.get('order', 'pending_title')));
  assert.match(pending.text, new RegExp(`href="${order.pay_url}" data-testid="pay-order"`));

  const paid = await payMock(c, placed.location);
  assert.equal(paid.status, 200);
  assert.ok(paid.text.includes(content.get('order', 'paid_title')));
  assert.match(paid.text, /data-testid="order-status">Оплачен</);
  assert.match(paid.text, /data-testid="payment-status">Оплачен</);
  assert.match(paid.text, /data-testid="order-total">225 000 сум</);
  assert.ok(paid.text.includes(order.number));
  assert.ok(paid.text.includes(ADDRESS));
  assert.ok(!paid.text.includes('data-testid="pay-order"'));

  const fresh = orders.getOrder(order.id);
  assert.equal(fresh.payment_status, 'paid');
  assert.equal(fresh.payment_provider, 'mock');
  assert.equal(catalog.getProduct(products[0].id).stock, stockBefore - 2, 'stock is decremented once');
  const purchase = get(`SELECT * FROM events WHERE name = 'purchase' AND order_id = ?`, order.id);
  assert.equal(purchase.session_id, c.jar.get('sc_sid'), 'purchase closes the funnel of the same session');
  assert.equal(purchase.value, 225000);

  const status = await c.get(`${order.url}/status`);
  assert.deepEqual(status.json(), { ok: true, status: 'paid', payment_status: 'paid', state: 'paid' });
  assert.equal((await c.get('/order/0123456789abcdef0123456789abcdef')).status, 404);
  assert.equal((await c.get('/order/0123456789abcdef0123456789abcdef/status')).status, 404);
});

test('checkout with pickup: no address needed, no delivery fee', async () => {
  const c = await shopper([[1, 1]]); // 120 000 сум
  const placed = await c.postForm('/checkout', { name: 'Малика', phone: '90 987 65 43', method: 'pickup', address: '' });
  assert.equal(placed.status, 303);
  const order = orders.getOrderByToken(placed.location.split('/').pop());
  assert.equal(order.delivery_method, 'pickup');
  assert.equal(order.delivery_fee, 0);
  assert.equal(order.total, 120000);
  const page = await c.get(order.url);
  assert.ok(page.text.includes(settings.get('pickup_address')));
  assert.ok(page.text.includes('Готов к выдаче'), 'pickup wording in the progress line');
});

test('failed payment keeps the order payable; retry succeeds', async () => {
  const c = await shopper([[1, 1]]);
  const placed = await c.postForm('/checkout', { ...PERSON, method: 'courier', address: ADDRESS });
  const order = orders.getOrderByToken(placed.location.split('/').pop());

  const failed = await payMock(c, placed.location, 'fail');
  assert.ok(failed.text.includes(content.get('order', 'failed_title')));
  assert.match(failed.text, /data-testid="payment-status">Ошибка оплаты</);
  assert.match(failed.text, /data-testid="pay-order">Попробовать ещё раз/);
  assert.equal(orders.getOrder(order.id).can_pay, true);

  const cancelled = await payMock(c, order.pay_url, 'cancel');
  assert.match(cancelled.text, /data-testid="pay-order"/);
  assert.match(cancelled.text, /data-order-poll="\/order\/[0-9a-f]{32}\/status"/, 'pending payments are polled');

  const paid = await payMock(c, order.pay_url, 'success');
  assert.ok(paid.text.includes(content.get('order', 'paid_title')));
  assert.equal(orders.getOrder(order.id).payment_status, 'paid');
});

test('checkout guards: empty cart, unavailable items, CSRF', async () => {
  const c = t.newClient();
  await c.get('/');
  const empty = await c.get('/checkout');
  assert.equal(empty.status, 302);
  assert.equal(empty.location, '/cart');
  const emptyPost = await c.postForm('/checkout', { ...PERSON, method: 'courier', address: ADDRESS });
  assert.equal(emptyPost.status, 303);
  assert.equal(emptyPost.location, '/cart');
  assert.ok((await c.get('/cart')).text.includes('Корзина пуста'));

  const limited = catalog.createProduct({ title: 'Последняя пачка', price: 110000, stock: 2 });
  await c.postForm('/cart/add', { product_id: String(limited.id), qty: '2', redirect: '/cart' });
  catalog.updateProduct(limited.id, { stock: 1 }); // someone else bought one meanwhile
  const blocked = await c.get('/checkout');
  assert.equal(blocked.status, 302);
  assert.equal(blocked.location, '/cart');
  const cart = await c.get('/cart');
  assert.ok(cart.text.includes('В наличии только 1 шт.'));
  assert.match(cart.text, /data-testid="go-checkout" aria-disabled="true"/);
  const raced = await c.postForm('/checkout', { ...PERSON, method: 'pickup' });
  assert.equal(raced.status, 303);
  assert.equal(raced.location, '/cart');
  assert.equal(count('SELECT COUNT(*) AS n FROM order_items WHERE product_id = ?', limited.id), 0);

  const noToken = await c.request('POST', '/checkout', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=A' });
  assert.equal(noToken.status, 403);
});

test('subscription: plan page → form → payment → active subscription', async () => {
  const c = t.newClient();
  const list = await c.get('/subscriptions');
  assert.ok(list.text.includes(plan.title));
  assert.match(list.text, new RegExp(`href="/subscriptions/${plan.slug}"`));

  const form = await c.get(`/subscriptions/${plan.slug}`);
  assert.equal(form.status, 200);
  assert.match(form.text, /data-testid="checkout-total">379 000 сум</);
  const begin = get(`SELECT * FROM events WHERE name = 'begin_checkout' ORDER BY id DESC LIMIT 1`);
  assert.equal(begin.value, 379000);
  assert.equal(JSON.parse(begin.meta).kind, 'subscription');

  const invalid = await c.postForm(`/subscriptions/${plan.slug}`, { name: 'Я', phone: '' });
  assert.equal(invalid.status, 422);
  assert.ok(invalid.text.includes('Укажите имя'));

  const placed = await c.postForm(`/subscriptions/${plan.slug}`, { name: 'Камила Рахимова', phone: '+998 93 555 44 33', address: '', comment: 'Люблю Эфиопию' });
  assert.equal(placed.status, 303, 'the address is optional for subscriptions');
  const order = orders.getOrderByToken(placed.location.split('/').pop());
  assert.equal(order.kind, 'subscription');
  assert.equal(order.total, 379000);
  assert.equal(count(`SELECT COUNT(*) AS n FROM events WHERE name = 'subscribe' AND order_id = ?`, order.id), 1);

  const paid = await payMock(c, placed.location);
  assert.ok(paid.text.includes(content.get('order', 'paid_title')));
  assert.ok(paid.text.includes(`Подписка «${plan.title}» активна до`));
  assert.ok(paid.text.includes('Подписка активна'), 'subscription progress line');
  const subscription = subscriptions.getCurrentForCustomer(order.customer_id);
  assert.equal(subscription.status, 'active');
  assert.equal(subscription.plan_id, plan.id);

  subscriptions.updatePlan(plan.id, { active: 0 });
  try {
    assert.equal((await c.get(`/subscriptions/${plan.slug}`)).status, 404, 'inactive plans cannot be bought');
    assert.equal((await c.postForm(`/subscriptions/${plan.slug}`, { name: 'Камила', phone: '+998 93 555 44 33' })).status, 404);
  } finally {
    subscriptions.updatePlan(plan.id, { active: 1 });
  }
});

test('order status page follows the order lifecycle', async () => {
  const c = await shopper([[2, 1]]);
  const placed = await c.postForm('/checkout', { ...PERSON, method: 'courier', address: ADDRESS });
  const order = orders.getOrderByToken(placed.location.split('/').pop());
  await payMock(c, placed.location);

  for (const [status, block] of [['processing', 'processing_title'], ['shipped', 'shipped_title'], ['delivered', 'delivered_title']]) {
    orders.setStatus(order.id, status, { actor: 'admin:1' });
    const page = await c.get(order.url);
    assert.ok(page.text.includes(pageContent('order')[block]), `${status}: title from the content block`);
    assert.match(page.text, new RegExp(`data-testid="order-status">${orders.ORDER_STATUS_LABELS[status]}<`));
  }
  orders.refund(order.id, { actor: 'admin:1' });
  const refunded = await c.get(order.url);
  assert.match(refunded.text, /data-testid="payment-status">Возвращён</);
  assert.ok(!refunded.text.includes('class="steps-line"'), 'no progress line for closed orders');
  assert.ok(!refunded.text.includes('data-testid="pay-order"'));

  const d = await shopper([[2, 1]]);
  const second = await d.postForm('/checkout', { ...PERSON, method: 'pickup' });
  const unpaid = orders.getOrderByToken(second.location.split('/').pop());
  orders.cancel(unpaid.id, { actor: 'admin:1' });
  const cancelled = await d.get(unpaid.url);
  assert.ok(cancelled.text.includes(content.get('order', 'cancelled_title')));
  assert.ok(!cancelled.text.includes('data-testid="pay-order"'));
  const redirect = await d.get(unpaid.pay_url);
  assert.equal(redirect.status, 302);
  assert.equal(path(redirect.location), unpaid.url, 'a closed order cannot start a payment');
  assert.equal(all('SELECT id FROM payments WHERE order_id = ?', unpaid.id).length, 0);
});
