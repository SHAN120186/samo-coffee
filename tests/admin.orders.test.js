import './helpers/env.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/http.js';
import { get } from '../src/db/index.js';
import * as cart from '../src/services/cart.js';
import * as orders from '../src/services/orders.js';
import * as catalog from '../src/services/catalog.js';
import * as customers from '../src/services/customers.js';
import * as subscriptions from '../src/services/subscriptions.js';
import * as paymentsRepo from '../src/services/payments.js';
import * as auth from '../src/services/auth.js';
import { makeCatalog, makePlan, CUSTOMER, DELIVERY } from './helpers/fixtures.js';
import { ADMIN, login } from './admin.helpers.js';

let t;
let c;
let adminId;
let products;
before(async () => {
  t = await startTestApp();
  c = t.client;
  await login(c);
  adminId = get('SELECT id FROM admins ORDER BY id LIMIT 1').id;
  ({ products } = makeCatalog(2, { stock: 10 }));
});
after(async () => {
  await t.close();
});

function makeOrder(overrides = {}, qty = 2) {
  const ref = { token: cart.newToken() };
  cart.addItem(ref, products[0].id, qty);
  return orders.createFromCart(ref, { customer: CUSTOMER, delivery: DELIVERY, ...overrides });
}

test('orders: empty state, list, filters and search', async () => {
  const empty = await c.get('/admin/orders');
  assert.equal(empty.status, 200);
  assert.match(empty.text, /Заказов пока нет/);

  const a = makeOrder();
  const b = makeOrder({ customer: { name: 'Зарина Петрова', phone: '+998 93 555 44 33' }, channel: 'tma', tgUserId: 777 });
  orders.markPaid(b.id, { provider: 'mock' });

  const list = await c.get('/admin/orders');
  assert.ok(list.text.includes(a.number) && list.text.includes(b.number));
  assert.match(list.text, /Зарина Петрова/);

  const paid = await c.get('/admin/orders?status=paid');
  assert.ok(paid.text.includes(b.number) && !paid.text.includes(a.number));
  const tma = await c.get('/admin/orders?channel=tma');
  assert.ok(tma.text.includes(b.number) && !tma.text.includes(a.number));
  const unpaid = await c.get('/admin/orders?payment=unpaid');
  assert.ok(unpaid.text.includes(a.number) && !unpaid.text.includes(b.number));
  const byNumber = await c.get(`/admin/orders?search=${a.number.toLowerCase()}`);
  assert.ok(byNumber.text.includes(a.number) && !byNumber.text.includes(b.number));
  const byPhone = await c.get('/admin/orders?search=5554433');
  assert.ok(byPhone.text.includes(b.number) && !byPhone.text.includes(a.number));
  const future = await c.get('/admin/orders?from=2099-01-01');
  assert.match(future.text, /Заказов с такими условиями нет/);
  const garbage = await c.get('/admin/orders?status[]=x&from=not-a-date&page=-5&channel=%27%20OR%201=1');
  assert.equal(garbage.status, 200, 'invalid filters are ignored');
  assert.match((await c.get('/admin')).text, /class="adm-nav__count"[^>]*>1</, 'paid orders waiting for processing are counted in the sidebar');
});

test('orders: detail page shows items, customer and history', async () => {
  const order = makeOrder({ comment: 'Позвонить за час <b>до</b>' });
  const page = await c.get(`/admin/orders/${order.id}`);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes(order.number));
  assert.ok(page.text.includes(products[0].title));
  assert.match(page.text, /Тест Тестов/);
  assert.match(page.text, /\+998 90 123 45 67/);
  assert.match(page.text, /Заказ оформлен/);
  assert.match(page.text, /Позвонить за час &lt;b&gt;до&lt;\/b&gt;/, 'customer comment is escaped');
  assert.match(page.text, /Отметить оплаченным/);
  assert.match(page.text, /Отменить заказ/);
  assert.ok(!page.text.includes('Оформить возврат'), 'refund is offered for paid orders only');
});

test('orders: manual mark-paid, status changes, refund — all through the order service', async () => {
  const order = makeOrder({}, 3);
  const stock = catalog.getProduct(products[0].id).stock;
  await c.get(`/admin/orders/${order.id}`);

  const paid = await c.postForm(`/admin/orders/${order.id}/mark-paid`, {});
  assert.equal(paid.status, 302);
  let fresh = orders.getOrder(order.id);
  assert.equal(fresh.status, 'paid');
  assert.equal(fresh.payment_status, 'paid');
  assert.equal(fresh.payment_provider, 'manual');
  assert.equal(catalog.getProduct(products[0].id).stock, stock - 3, 'stock is decremented by markPaid');
  assert.equal(paymentsRepo.listByOrder(order.id)[0].status, 'paid');
  const payEvent = orders.getOrderEvents(order.id).find((e) => e.type === 'payment');
  assert.equal(payEvent.actor, `admin:${adminId}`);
  assert.equal(get("SELECT COUNT(*) AS n FROM events WHERE name = 'purchase' AND order_id = ?", order.id).n, 1, 'purchase event recorded once');

  // idempotent: a second click changes nothing
  await c.postForm(`/admin/orders/${order.id}/mark-paid`, {});
  assert.equal(catalog.getProduct(products[0].id).stock, stock - 3);
  assert.equal(get("SELECT COUNT(*) AS n FROM events WHERE name = 'purchase' AND order_id = ?", order.id).n, 1);

  const next = await c.postForm(`/admin/orders/${order.id}/status`, { status: 'processing', note: 'Обжарили утром' });
  assert.equal(next.status, 302);
  fresh = orders.getOrder(order.id);
  assert.equal(fresh.status, 'processing');
  const statusEvent = orders.getOrderEvents(order.id).at(-1);
  assert.equal(statusEvent.note, 'Обжарили утром');
  assert.equal(statusEvent.actor, `admin:${adminId}`);
  const page = await c.get(`/admin/orders/${order.id}`);
  assert.match(page.text, /Статус заказа .* «Собирается»/);
  assert.match(page.text, /Обжарили утром/);
  assert.match(page.text, /Администратор/, 'history shows who changed the status');

  // the status machine is enforced
  const bad = await c.postForm(`/admin/orders/${order.id}/status`, { status: 'new' });
  assert.equal(bad.status, 302);
  assert.equal(orders.getOrder(order.id).status, 'processing');
  assert.match((await c.get(bad.location)).text, /Нельзя перевести заказ/);
  const cancelPaid = await c.postForm(`/admin/orders/${order.id}/cancel`, {});
  assert.equal(cancelPaid.status, 302);
  assert.equal(orders.getOrder(order.id).status, 'processing', 'paid orders cannot be cancelled');

  await c.get(`/admin/orders/${order.id}`);
  await c.postForm(`/admin/orders/${order.id}/status`, { status: 'shipped' });
  await c.postForm(`/admin/orders/${order.id}/status`, { status: 'delivered' });
  assert.equal(orders.getOrder(order.id).status, 'delivered');

  const refund = await c.postForm(`/admin/orders/${order.id}/refund`, {});
  assert.equal(refund.status, 302);
  fresh = orders.getOrder(order.id);
  assert.equal(fresh.status, 'refunded');
  assert.equal(fresh.payment_status, 'refunded');
  assert.equal(catalog.getProduct(products[0].id).stock, stock, 'stock is returned by refund');
});

test('orders: cancel an unpaid order, notes', async () => {
  const order = makeOrder();
  await c.get(`/admin/orders/${order.id}`);
  await c.postForm(`/admin/orders/${order.id}/note`, { admin_note: 'Постоянный клиент' });
  assert.equal(orders.getOrder(order.id).admin_note, 'Постоянный клиент');
  await c.postForm(`/admin/orders/${order.id}/comment`, { note: 'Клиент просил перезвонить' });
  assert.equal(orders.getOrderEvents(order.id).at(-1).note, 'Клиент просил перезвонить');
  assert.equal((await c.postForm(`/admin/orders/${order.id}/comment`, { note: '' })).status, 302);

  const cancelled = await c.postForm(`/admin/orders/${order.id}/cancel`, {});
  assert.equal(cancelled.status, 302);
  assert.equal(orders.getOrder(order.id).status, 'cancelled');
  const refundUnpaid = await c.postForm(`/admin/orders/${order.id}/refund`, {});
  assert.equal(refundUnpaid.status, 302);
  assert.equal(orders.getOrder(order.id).status, 'cancelled');
  const paidAfterCancel = await c.postForm(`/admin/orders/${order.id}/mark-paid`, {});
  assert.equal(paidAfterCancel.status, 302);
  assert.equal(orders.getOrder(order.id).payment_status, 'unpaid', 'a cancelled order cannot be marked paid');
});

test('orders: CSV export honours filters and neutralises spreadsheet formulas', async () => {
  const evil = makeOrder({ customer: { name: '=HYPERLINK("http://evil","x")', phone: '+998 90 000 00 01' }, comment: 'a;b "quoted"\nnew line' });
  const res = await c.get('/admin/orders/export.csv');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="samo-orders-\d{4}-\d{2}-\d{2}\.csv"/);
  assert.ok(res.text.startsWith('"Номер";"Создан"'), 'header row');
  // fetch().text() strips the BOM, so check the raw bytes: Excel needs it to detect UTF-8
  const raw = await fetch(`${t.baseUrl}/admin/orders/export.csv`, { headers: { cookie: [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.deepEqual([...new Uint8Array(await raw.arrayBuffer()).slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM');
  const rows = res.text.split('\r\n').filter(Boolean);
  assert.equal(rows.length, orders.countByStatus().all + 1);
  const row = rows.find((r) => r.includes(evil.number));
  assert.ok(row.includes(`"'=HYPERLINK(""http://evil"",""x"")"`), row);
  assert.ok(row.includes('"a;b ""quoted""'), 'quotes and separators are escaped');
  assert.ok(row.includes('"+998900000001"') || row.includes('"+998 90 000 00 01"'), 'phone numbers are kept as text');

  const filtered = await c.get('/admin/orders/export.csv?status=refunded');
  assert.equal(filtered.text.split('\r\n').filter(Boolean).length, orders.countByStatus().refunded + 1);
});

test('customers: list, search, profile with order history, edit', async () => {
  const list = await c.get('/admin/customers');
  assert.equal(list.status, 200);
  assert.match(list.text, /Тест Тестов/);
  const found = await c.get(`/admin/customers?search=${encodeURIComponent('зарина')}`);
  assert.match(found.text, /Зарина Петрова/);
  assert.ok(!found.text.includes('Тест Тестов'));
  assert.match((await c.get('/admin/customers?search=nobody-here')).text, /Никого не нашли/);

  const customer = customers.listCustomers({ search: 'Тест Тестов' }).items[0];
  const page = await c.get(`/admin/customers/${customer.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /История заказов/);
  for (const o of orders.listOrders({ customerId: customer.id }).items) assert.ok(page.text.includes(o.number));

  const bad = await c.postForm(`/admin/customers/${customer.id}`, { name: 'Тест', phone: '12', email: 'x' });
  assert.equal(bad.status, 422);
  assert.match(bad.text, /Некорректный номер телефона/);
  const ok = await c.postForm(`/admin/customers/${customer.id}`, { name: 'Тест Тестович', phone: '90 123 45 67', email: 'new@example.com', address: 'Ташкент', notes: 'Любит Кению' });
  assert.equal(ok.status, 302);
  const saved = customers.getCustomer(customer.id);
  assert.equal(saved.name, 'Тест Тестович');
  assert.equal(saved.phone, '+998901234567');
  assert.equal(saved.notes, 'Любит Кению');

  const csv = await c.get('/admin/customers/export.csv');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.text, /Тест Тестович/);
  assert.equal((await c.get('/admin/customers/999999')).status, 404);
});

test('subscriptions: list, pause, resume, cancel', async () => {
  assert.match((await c.get('/admin/subscriptions')).text, /Подписок пока нет/);
  const plan = makePlan({ title: 'Для двоих' });
  const order = orders.createSubscriptionOrder({ planId: plan.id, customer: { name: 'Олег Подписчик', phone: '+998 90 777 66 55' } });
  await c.get(`/admin/orders/${order.id}`);
  await c.postForm(`/admin/orders/${order.id}/mark-paid`, {});
  const sub = subscriptions.listSubscriptions().items[0];
  assert.equal(sub.status, 'active', 'manual payment activates the subscription');

  const page = await c.get('/admin/subscriptions');
  assert.match(page.text, /Олег Подписчик/);
  assert.match(page.text, /Для двоих/);
  await c.postForm(`/admin/subscriptions/${sub.id}/pause`, {});
  assert.equal(subscriptions.getSubscription(sub.id).status, 'paused');
  assert.match((await c.get('/admin/subscriptions?status=paused')).text, /Олег Подписчик/);
  assert.ok(!(await c.get('/admin/subscriptions?status=active')).text.includes('Олег Подписчик'));
  await c.postForm(`/admin/subscriptions/${sub.id}/resume`, {});
  assert.equal(subscriptions.getSubscription(sub.id).status, 'active');
  await c.postForm(`/admin/subscriptions/${sub.id}/cancel`, {});
  assert.equal(subscriptions.getSubscription(sub.id).status, 'cancelled');
  const again = await c.postForm(`/admin/subscriptions/${sub.id}/resume`, {});
  assert.equal(again.status, 302, 'invalid transition → flash, no crash');
  assert.equal(subscriptions.getSubscription(sub.id).status, 'cancelled');
  assert.equal((await c.postForm(`/admin/subscriptions/${sub.id}/explode`, {})).status, 404);

  // a plan with subscribers is deactivated instead of deleted
  await c.get('/admin/plans');
  await c.postForm(`/admin/plans/${plan.id}/delete`, {});
  assert.equal(subscriptions.getPlan(plan.id).active, 0);
});

test('account: profile, password change keeps this session and closes the others', async () => {
  const other = t.newClient();
  await login(other);
  assert.equal((await other.get('/admin')).status, 200);

  await c.get('/admin/account');
  const wrong = await c.postForm('/admin/account/password', { current_password: 'nope', new_password: 'new-password-1', new_password_confirm: 'new-password-1' });
  assert.equal(wrong.status, 422);
  assert.match(wrong.text, /Текущий пароль указан неверно/);
  const mismatch = await c.postForm('/admin/account/password', { current_password: ADMIN.password, new_password: 'new-password-1', new_password_confirm: 'new-password-2' });
  assert.equal(mismatch.status, 422);
  const short = await c.postForm('/admin/account/password', { current_password: ADMIN.password, new_password: 'short', new_password_confirm: 'short' });
  assert.equal(short.status, 422);

  const ok = await c.postForm('/admin/account/password', { current_password: ADMIN.password, new_password: 'new-password-1', new_password_confirm: 'new-password-1' });
  assert.equal(ok.status, 302);
  assert.equal((await c.get('/admin/account')).status, 200, 'the current session survives');
  assert.equal((await other.get('/admin')).status, 302, 'other sessions are closed');
  assert.equal((await login(t.newClient())).status, 401, 'the old password no longer works');
  assert.equal((await login(t.newClient(), { email: ADMIN.email, password: 'new-password-1' })).status, 302);
  const hash = get('SELECT password_hash FROM admins WHERE id = ?', adminId).password_hash;
  assert.match(hash, /^scrypt\$/);
  assert.ok(!hash.includes('new-password-1'));

  await c.postForm('/admin/account/profile', { name: 'Тимур', email: 'owner@samo.coffee' });
  assert.equal(auth.getAdmin(adminId).name, 'Тимур');
  assert.equal(auth.getAdmin(adminId).email, 'owner@samo.coffee');
  assert.equal((await c.postForm('/admin/account/profile', { name: 'Тимур', email: 'broken' })).status, 422);
});

test('admins: owner creates, edits and deletes other admins; the owner account is protected', async () => {
  const page = await c.get('/admin/admins');
  assert.equal(page.status, 200);
  await c.get('/admin/admins/new');
  assert.equal((await c.postForm('/admin/admins', { email: 'bad', password: 'long-enough-password' })).status, 422);
  assert.equal((await c.postForm('/admin/admins', { email: 'm@samo.coffee', password: 'short' })).status, 422);
  const created = await c.postForm('/admin/admins', { email: 'M@Samo.Coffee', name: 'Мадина', password: 'manager-pass-1', role: 'manager' });
  assert.equal(created.status, 302);
  const manager = auth.listAdmins().find((a) => a.email === 'm@samo.coffee');
  assert.equal(manager.role, 'manager');

  const m = t.newClient();
  assert.equal((await login(m, { email: 'm@samo.coffee', password: 'manager-pass-1' })).status, 302);

  await c.get(`/admin/admins/${manager.id}`);
  assert.equal((await c.postForm(`/admin/admins/${manager.id}`, { name: 'Мадина', email: 'm@samo.coffee', role: 'admin', active: '1', password: '123' })).status, 422);
  const edited = await c.postForm(`/admin/admins/${manager.id}`, { name: 'Мадина А.', email: 'm@samo.coffee', role: 'admin', active: '1', password: 'manager-pass-2' });
  assert.equal(edited.status, 302);
  assert.equal(auth.getAdmin(manager.id).role, 'admin');
  assert.equal((await m.get('/admin')).status, 302, 'a password reset closes that admin\'s sessions');
  assert.equal((await login(t.newClient(), { email: 'm@samo.coffee', password: 'manager-pass-2' })).status, 302);

  // the owner cannot demote / deactivate / delete themselves
  await c.postForm(`/admin/admins/${adminId}`, { name: 'Тимур', email: 'owner@samo.coffee', role: 'manager' });
  assert.equal(auth.getAdmin(adminId).role, 'owner');
  assert.equal(auth.getAdmin(adminId).active, 1);
  await c.postForm(`/admin/admins/${adminId}/delete`, {});
  assert.ok(auth.getAdmin(adminId));

  await c.postForm(`/admin/admins/${manager.id}/delete`, {});
  assert.equal(auth.getAdmin(manager.id), null);
});
