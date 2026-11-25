// Mini App API: catalog → cart → checkout → hosted (mock) payment → my orders; plans → subscription.
import { FAKE_TG_PORT, ADMIN_CHAT_ID } from './helpers/env-telegram.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/http.js';
import { startFakeTelegram } from './helpers/fakeTelegram.js';
import { makeCatalog, makePlan } from './helpers/fixtures.js';
import { all } from '../src/db/index.js';
import * as catalog from '../src/services/catalog.js';
import * as orders from '../src/services/orders.js';
import * as paymentsRepo from '../src/services/payments.js';
import * as subscriptions from '../src/services/subscriptions.js';
import * as notify from '../src/services/notify.js';
import { tmaClient, tgUser, CHECKOUT } from './tma.helpers.js';

let t;
let fake;
let products;
let category;
let plan;

before(async () => {
  fake = await startFakeTelegram(FAKE_TG_PORT);
  t = await startTestApp();
  ({ products, category } = makeCatalog(3, { stock: 5 }));
  plan = makePlan({ title: 'Для себя', price: 199000, period_days: 30 });
});
after(async () => {
  await notify.flush();
  await t.close();
  await fake.close();
});

const events = (name, tgUserId) => all('SELECT * FROM events WHERE name = ? AND tg_user_id = ? ORDER BY id', name, tgUserId);

/** Pay (or fail) an order on the hosted mock checkout page, like a browser would. */
async function mockCheckout(redirectUrl, action = 'success') {
  const browser = t.newClient();
  const page = await browser.get(redirectUrl);
  assert.equal(page.status, 200, 'hosted payment page opens');
  const done = await browser.postForm(new URL(redirectUrl).pathname, { action });
  assert.equal(done.status, 303);
  return done.location;
}

test('bootstrap returns settings, texts, categories and an empty cart', async () => {
  const api = tmaClient(t.baseUrl, tgUser());
  const { status, body } = await api.get('/bootstrap');
  assert.equal(status, 200);
  assert.equal(body.cart.count, 0);
  assert.equal(body.subscription, null);
  assert.ok(body.categories.some((c) => c.slug === category.slug && c.product_count === 3));
  assert.equal(typeof body.settings.site_name, 'string');
  assert.equal(typeof body.settings.delivery_fee, 'number');
  assert.equal(typeof body.texts.home_title, 'string');
  assert.equal(body.payments.invoice, false, 'no TELEGRAM_PAYMENT_TOKEN in this test → hosted page');
  assert.equal(body.limits.maxQty, 20);
});

test('catalog: list, filters, search, detail by id and slug, hidden products', async () => {
  const user = tgUser();
  const api = tmaClient(t.baseUrl, user);

  const list = await api.get(`/products?category=${category.slug}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 3);
  const card = list.body.items[0];
  assert.deepEqual(Object.keys(card).sort(), ['category_slug', 'category_title', 'discount_percent', 'featured', 'id', 'image', 'in_stock', 'low_stock', 'max_qty', 'old_price', 'origin', 'price', 'roast', 'slug', 'subtitle', 'title', 'weight_g'].sort());
  assert.equal(card.max_qty, 5, 'stock is exposed only as a capped max quantity');

  const sorted = await api.get(`/products?category=${category.slug}&sort=price_desc&limit=2`);
  assert.deepEqual(sorted.body.items.map((p) => p.id), [products[2].id, products[1].id]);
  assert.equal(sorted.body.total, 3);

  const found = await api.get(`/products?search=${encodeURIComponent(products[1].title.toLowerCase())}`);
  assert.deepEqual(found.body.items.map((p) => p.id), [products[1].id]);
  assert.equal((await api.get('/products?search=%D1%87%D0%B0%D0%B9%D0%BD%D0%B8%D0%BA%20zzz')).body.total, 0);
  assert.equal((await api.get('/products?category=../../etc')).status, 200, 'a malformed filter is ignored, not an error');

  const byId = await api.get(`/products/${products[0].id}`);
  assert.equal(byId.status, 200);
  assert.equal(byId.body.product.title, products[0].title);
  assert.equal(byId.body.inCart, 0);
  assert.ok(Array.isArray(byId.body.related));
  const bySlug = await api.get(`/products/${products[0].slug}`);
  assert.equal(bySlug.body.product.id, products[0].id);

  const hidden = catalog.createProduct({ title: 'Скрытый лот', price: 50000, stock: 3, category_id: category.id, active: 0 });
  assert.equal((await api.get(`/products/${hidden.id}`)).status, 404);
  assert.equal((await api.get('/products/999999')).status, 404);
  assert.equal((await api.get('/products/%3Cscript%3E')).status, 404);

  // analytics events sent by the client
  assert.equal((await api.post('/events', { name: 'tma_open', platform: 'ios', version: '8.0' })).body.tracked, true);
  assert.equal((await api.post('/events', { name: 'view_product', productId: products[0].id })).status, 200);
  assert.equal((await api.post('/events', { name: 'view_product', productId: hidden.id })).status, 404);
  assert.equal((await api.post('/events', { name: 'purchase' })).status, 422, 'only whitelisted client events');
  assert.equal((await api.post('/events', { name: 'begin_checkout' })).body.tracked, false, 'no begin_checkout for an empty cart');
  const opened = events('tma_open', user.id);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].channel, 'tma');
  assert.equal(opened[0].session_id, `tg:${user.id}`);
  assert.equal(events('view_product', user.id)[0].product_id, products[0].id);
});

test('cart is stored on the server per Telegram user and validates input', async () => {
  const user = tgUser();
  const other = tgUser();
  const api = tmaClient(t.baseUrl, user);
  const [a, b] = products;

  const added = await api.post('/cart/items', { productId: a.id, qty: 2 });
  assert.equal(added.status, 201);
  assert.equal(added.body.added, 2);
  assert.equal(added.body.cart.count, 2);
  assert.equal(added.body.cart.subtotal, a.price * 2);

  const clamped = await api.post('/cart/items', { productId: a.id, qty: 10 });
  assert.equal(clamped.body.cart.items[0].qty, 5, 'quantity is clamped to stock');
  assert.equal(clamped.body.added, 3);

  await api.post('/cart/items', { productId: b.id });
  const addEvents = events('add_to_cart', user.id);
  assert.equal(addEvents.length, 3);
  assert.ok(addEvents.every((e) => e.channel === 'tma'));
  assert.equal(addEvents[0].value, a.price);

  for (const bad of [{ productId: 'abc' }, { productId: -1 }, { productId: a.id, qty: 0 }, { productId: a.id, qty: 'many' }, {}, { productId: 1.5 }]) {
    const res = await api.post('/cart/items', bad);
    assert.equal(res.status, 422, JSON.stringify(bad));
    assert.equal(res.body.error, 'validation');
  }
  assert.equal((await api.post('/cart/items', { productId: 999999 })).status, 404);

  const set = await api.put(`/cart/items/${a.id}`, { qty: 1 });
  assert.equal(set.body.cart.items.find((i) => i.product_id === a.id).qty, 1);
  assert.equal((await api.put(`/cart/items/${a.id}`, { qty: -3 })).status, 422);
  const removed = await api.del(`/cart/items/${b.id}`);
  assert.deepEqual(removed.body.cart.items.map((i) => i.product_id), [a.id]);

  const detail = await api.get(`/products/${a.id}`);
  assert.equal(detail.body.inCart, 1);

  // another Telegram user has their own cart
  assert.equal((await tmaClient(t.baseUrl, other).get('/cart')).body.cart.count, 0);
  assert.equal((await api.get('/bootstrap')).body.cart.count, 1);

  const cleared = await api.del('/cart');
  assert.equal(cleared.body.cart.count, 0);
});

test('checkout → hosted payment → paid order in "my orders"', async () => {
  const user = tgUser({ username: 'buyer_one' });
  const stranger = tgUser();
  const api = tmaClient(t.baseUrl, user);
  const product = catalog.createProduct({ title: 'Кения для теста', price: 150000, stock: 4, category_id: category.id, images: ['/img/placeholder.svg'] });
  fake.reset();

  assert.equal((await api.post('/checkout', CHECKOUT)).status, 409, 'empty cart');
  await api.post('/cart/items', { productId: product.id, qty: 2 });

  const invalid = await api.post('/checkout', { customer: { name: 'К', phone: '12345' }, delivery: { method: 'courier', address: '' } });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.error, 'validation');
  assert.deepEqual(Object.keys(invalid.body.details.fields).sort(), ['address', 'name', 'phone']);
  assert.equal((await api.get('/cart')).body.cart.count, 2, 'a failed checkout keeps the cart');

  assert.equal((await api.post('/events', { name: 'begin_checkout' })).body.tracked, true);
  assert.equal(events('begin_checkout', user.id)[0].value, 300000);

  const res = await api.post('/checkout', { ...CHECKOUT, returnToApp: true });
  assert.equal(res.status, 201);
  const { order, redirectUrl, provider, invoiceLink } = res.body;
  assert.equal(provider, 'mock');
  assert.equal(invoiceLink, undefined);
  assert.match(redirectUrl, /\/pay\/mock\/mock_[0-9a-f]{24}$/);
  assert.match(order.number, /^SC-\d+$/);
  assert.equal(order.status, 'pending_payment');
  assert.equal(order.is_paid, false);
  assert.equal(order.can_pay, true);
  assert.equal(order.subtotal, 300000);
  assert.equal(order.total, order.subtotal + order.delivery_fee);
  assert.equal(order.customer_phone, '+998901234567');
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].qty, 2);
  assert.equal('admin_note' in order, false, 'internal fields are not exposed');
  assert.equal('public_token' in order, false);

  const stored = orders.getOrder(order.id);
  assert.equal(stored.channel, 'tma');
  assert.equal(stored.tg_user_id, user.id);
  assert.equal(stored.session_id, `tg:${user.id}`);
  assert.equal(stored.comment, CHECKOUT.comment);
  assert.equal(paymentsRepo.findActiveForOrder(order.id, 'mock').raw.returnUrl.endsWith(`/tma/#/pay/${order.id}`), true, 'browser preview returns into the Mini App');
  assert.equal((await api.get('/cart')).body.cart.count, 0, 'the cart is emptied');
  assert.equal(catalog.getProduct(product.id).stock, 4, 'stock changes only when the order is paid');

  await notify.flush();
  assert.ok(fake.callsTo('sendMessage').some((m) => String(m.chat_id) === ADMIN_CHAT_ID && m.text.includes(order.number)), 'admins are told about the new order');

  // nobody else can see or pay this order
  const foreign = tmaClient(t.baseUrl, stranger);
  assert.equal((await foreign.get(`/orders/${order.id}`)).status, 404);
  assert.equal((await foreign.post(`/orders/${order.id}/pay`)).status, 404);
  assert.equal((await foreign.post(`/orders/${order.id}/cancel`)).status, 404);
  assert.deepEqual((await foreign.get('/orders')).body.items, []);

  // a failed attempt keeps the order payable; the next attempt succeeds
  await mockCheckout(redirectUrl, 'fail');
  const failed = (await api.get(`/orders/${order.id}`)).body.order;
  assert.equal(failed.payment_status, 'failed');
  assert.equal(failed.can_pay, true);

  const retry = await api.post(`/orders/${order.id}/pay`, {});
  assert.equal(retry.status, 200);
  assert.match(retry.body.redirectUrl, /\/pay\/mock\//);
  const back = await mockCheckout(retry.body.redirectUrl, 'success');
  assert.ok(back.endsWith(`/order/${stored.public_token}`), 'inside Telegram the hosted page returns to the public status page');

  const paid = (await api.get(`/orders/${order.id}`)).body.order;
  assert.equal(paid.is_paid, true);
  assert.equal(paid.status, 'paid');
  assert.equal(paid.can_pay, false);
  assert.equal(paid.can_cancel, false);
  assert.equal(catalog.getProduct(product.id).stock, 2, 'stock is decremented once');

  const purchase = events('purchase', user.id);
  assert.equal(purchase.length, 1);
  assert.equal(purchase[0].channel, 'tma');
  assert.equal(purchase[0].order_id, order.id);

  await notify.flush();
  assert.ok(fake.callsTo('sendMessage').some((m) => Number(m.chat_id) === user.id), 'the customer is notified in Telegram');

  const list = await api.get('/orders');
  assert.deepEqual(list.body.items.map((o) => o.id), [order.id]);
  assert.equal(list.body.items[0].items[0].title, 'Кения для теста');

  const again = await api.post(`/orders/${order.id}/pay`, {});
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'already_paid');
  assert.equal((await api.post(`/orders/${order.id}/cancel`)).status, 409, 'a paid order cannot be cancelled by the customer');
  assert.equal((await api.get('/orders/abc')).status, 422);

  // prefill for the next order comes from the last one
  const profile = (await api.get('/bootstrap')).body.profile;
  assert.deepEqual(profile, { name: CHECKOUT.customer.name, phone: '+998901234567', email: '', address: CHECKOUT.delivery.address, delivery_method: 'courier' });

  // "repeat order" puts the items back into the cart
  const repeat = await api.post(`/orders/${order.id}/repeat`);
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.cart.count, 2);
  assert.deepEqual(repeat.body.skipped, []);
});

test('an unpaid order can be cancelled and then is closed for payment', async () => {
  const api = tmaClient(t.baseUrl, tgUser());
  await api.post('/cart/items', { productId: products[2].id });
  const { order } = (await api.post('/checkout', { ...CHECKOUT, delivery: { method: 'pickup' } })).body;
  assert.equal(order.delivery_method, 'pickup');
  assert.equal(order.delivery_fee, 0);
  assert.equal(order.can_cancel, true);

  const cancelled = await api.post(`/orders/${order.id}/cancel`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.order.status, 'cancelled');
  assert.equal(cancelled.body.order.can_pay, false);

  const pay = await api.post(`/orders/${order.id}/pay`, {});
  assert.equal(pay.status, 409);
  assert.equal(pay.body.error, 'order_closed');
});

test('out-of-stock items block the checkout with a clear error', async () => {
  const api = tmaClient(t.baseUrl, tgUser());
  const scarce = catalog.createProduct({ title: 'Редкий лот', price: 90000, stock: 2, category_id: category.id });
  await api.post('/cart/items', { productId: scarce.id, qty: 2 });
  catalog.updateProduct(scarce.id, { stock: 1 });

  const cart = (await api.get('/cart')).body.cart;
  assert.equal(cart.has_unavailable, true);
  const res = await api.post('/checkout', CHECKOUT);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'out_of_stock');
  assert.equal(res.body.details.items[0].product_id, scarce.id);

  catalog.updateProduct(scarce.id, { stock: 0 });
  const add = await tmaClient(t.baseUrl, tgUser()).post('/cart/items', { productId: scarce.id });
  assert.equal(add.status, 409);
  assert.equal(add.body.error, 'out_of_stock');
});

test('plans → subscribe → payment activates the subscription; pause, resume, cancel', async () => {
  const user = tgUser();
  const api = tmaClient(t.baseUrl, user);

  const plans = await api.get('/plans');
  assert.equal(plans.status, 200);
  const listed = plans.body.items.find((p) => p.id === plan.id);
  assert.deepEqual(listed.perks, ['Раз', 'Два']);
  assert.equal(plans.body.subscription, null);
  assert.equal((await api.get('/subscription')).body.subscription, null);
  assert.equal((await api.post('/subscription/pause')).status, 404);

  assert.equal((await api.post('/subscribe', { ...CHECKOUT, planId: 999999 })).status, 404);
  assert.equal((await api.post('/subscribe', { ...CHECKOUT })).status, 422);
  const invalid = await api.post('/subscribe', { planId: plan.id, customer: { name: 'Камила', phone: '' } });
  assert.equal(invalid.status, 422);
  assert.ok(invalid.body.details.fields.phone);

  // the address is optional for a subscription
  const res = await api.post('/subscribe', { planId: plan.id, customer: CHECKOUT.customer, delivery: {} });
  assert.equal(res.status, 201);
  assert.equal(res.body.order.kind, 'subscription');
  assert.equal(res.body.order.total, 199000);
  assert.equal(res.body.order.delivery_fee, 0);
  assert.match(res.body.redirectUrl, /\/pay\/mock\//);
  assert.equal(orders.getOrder(res.body.order.id).channel, 'tma');
  assert.equal(events('subscribe', user.id).length, 1);

  await mockCheckout(res.body.redirectUrl, 'success');

  const current = await api.get('/subscription');
  assert.equal(current.body.subscription.status, 'active');
  assert.equal(current.body.subscription.plan_id, plan.id);
  assert.equal(current.body.subscription.is_active, true);
  assert.ok(current.body.subscription.days_left >= 29);
  assert.equal(current.body.plan.title, 'Для себя');
  assert.equal((await api.get('/bootstrap')).body.subscription.plan_title, 'Для себя');

  // renewing the same plan extends the paid period
  const renew = await api.post('/subscribe', { planId: plan.id, customer: CHECKOUT.customer });
  await mockCheckout(renew.body.redirectUrl, 'success');
  const extended = (await api.get('/subscription')).body.subscription;
  assert.ok(extended.days_left >= 59);
  assert.equal(extended.renewals, 1);

  const paused = await api.post('/subscription/pause');
  assert.equal(paused.body.subscription.status, 'paused');
  assert.equal((await api.post('/subscription/pause')).status >= 400, true, 'pausing twice is a bad transition');
  const resumed = await api.post('/subscription/resume');
  assert.equal(resumed.body.subscription.status, 'active');
  assert.equal((await api.post('/subscription/delete-everything')).status, 404);
  assert.equal((await api.post('/subscription/constructor')).status, 404);

  const cancelled = await api.post('/subscription/cancel');
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.subscription, null);
  assert.equal(subscriptions.getCurrentForTgUser(user.id), null);

  // somebody else's subscription is never touched
  assert.equal((await tmaClient(t.baseUrl, tgUser()).post('/subscription/cancel')).status, 404);
});

test('mutating endpoints are rate limited per Telegram user', async () => {
  const user = tgUser();
  const api = tmaClient(t.baseUrl, user);
  const scarce = catalog.createProduct({ title: 'Лот для лимита', price: 10000, stock: 500, category_id: category.id });
  let limited = null;
  for (let i = 0; i < 12 && !limited; i += 1) {
    await api.post('/cart/items', { productId: scarce.id });
    const res = await api.post('/checkout', { ...CHECKOUT, delivery: { method: 'pickup' } });
    if (res.status === 429) limited = res;
    else assert.equal(res.status, 201);
  }
  assert.ok(limited, 'the 11th order within the window is refused');
  assert.equal(limited.body.ok, false);
  assert.equal(limited.body.error, 'rate_limited');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  // the limit is per user: another customer is not affected
  const other = tmaClient(t.baseUrl, tgUser());
  await other.post('/cart/items', { productId: scarce.id });
  assert.equal((await other.post('/checkout', { ...CHECKOUT, delivery: { method: 'pickup' } })).status, 201);
});

test('a catalog longer than one page is reachable: the client pages through /products with offset', async () => {
  // the paging code of the Mini App itself (public/tma/js/paging.js), driven against the real API
  const { listQuery, hasMore, appendPage } = await import('../public/tma/js/paging.js');
  const big = makeCatalog(70, { stock: 3 });
  const api = tmaClient(t.baseUrl, tgUser());
  const params = { category: big.category.slug, search: '', sort: '' };

  const first = await api.get(`/products?${listQuery(params)}`);
  assert.deepEqual([first.body.items.length, first.body.total, first.body.limit, first.body.offset], [60, 70, 60, 0]);
  const list = { items: first.body.items, total: first.body.total };
  assert.equal(hasMore(list), true, 'the grid offers "Показать ещё"');

  let requests = 0;
  while (hasMore(list) && requests < 5) {
    const query = listQuery(params, list.items.length);
    assert.match(query, /offset=\d+/);
    appendPage(list, (await api.get(`/products?${query}`)).body);
    requests += 1;
  }
  assert.equal(requests, 1);
  assert.equal(list.items.length, 70);
  assert.deepEqual(list.items.map((p) => p.id).sort((a, b) => a - b), big.products.map((p) => p.id).sort((a, b) => a - b), 'every product of the category was loaded exactly once');
  assert.equal(hasMore(list), false);

  // the whole catalog ("Все") pages the same way
  const all70 = await api.get('/products');
  assert.ok(all70.body.total >= 73);
  assert.equal(all70.body.items.length, 60);

  // a page that brings nothing new ends the list (no endless "show more"), duplicates are dropped
  const stuck = { items: [{ id: 1 }, { id: 2 }], total: 5 };
  appendPage(stuck, { items: [{ id: 2 }], total: 5 });
  assert.deepEqual([stuck.items.length, hasMore(stuck)], [2, false]);
  assert.equal(listQuery({ category: '', search: '', sort: '', featured: true, limit: 8 }), 'featured=1&limit=8');
});
