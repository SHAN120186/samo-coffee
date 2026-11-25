// Customer identity: a phone / e-mail typed into a form is not proof of identity. Only a Telegram id
// (bot `from.id`, Mini App initData) or a phone verified with the user's own Telegram contact may
// attach somebody to an existing customer record.
import { FAKE_TG_PORT } from './bot.env.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeTelegram } from './helpers/fakeTelegram.js';
import { startTestApp } from './helpers/http.js';
import { makeCatalog, makePlan } from './helpers/fixtures.js';
import { BOT_INFO, makeUser, message, callback, lastText } from './bot.helpers.js';
import { tmaClient, tgUser } from './tma.helpers.js';
import { createBot } from '../src/bot/bot.js';
import { tick } from '../src/bot/scheduler.js';
import { all, get, run } from '../src/db/index.js';
import * as customers from '../src/services/customers.js';
import * as orders from '../src/services/orders.js';
import * as cart from '../src/services/cart.js';
import * as subscriptions from '../src/services/subscriptions.js';
import * as notify from '../src/services/notify.js';

let fake;
let bot;
let t;
let products;
let plan;

const send = async (update) => {
  await bot.handleUpdate(update);
  await notify.flush();
};

before(async () => {
  fake = await startFakeTelegram(FAKE_TG_PORT);
  bot = createBot({ botInfo: BOT_INFO });
  t = await startTestApp();
  ({ products } = makeCatalog(2, { stock: 50 }));
  plan = makePlan({ title: 'Клуб фильтра', price: 159000 });
});
after(async () => {
  await notify.flush();
  await t.close();
  await fake.close();
});
beforeEach(() => fake.reset());

/** A paid subscription bought on the public site through the real form + mock checkout. */
async function siteSubscription({ name, phone, email, address }) {
  const c = t.newClient();
  await c.get(`/subscriptions/${plan.slug}`);
  const placed = await c.postForm(`/subscriptions/${plan.slug}`, { name, phone, email, address });
  assert.equal(placed.status, 303);
  const order = orders.getOrderByToken(/\/pay\/order\/([0-9a-f]+)/.exec(placed.location)[1]);
  orders.markPaid(order.id, { provider: 'mock', amount: order.total });
  await notify.flush();
  return orders.getOrder(order.id);
}

test('Mini App: a phone typed at checkout does not capture the later site orders of that number', async () => {
  const attacker = tgUser({ first_name: 'Evil' });
  const api = tmaClient(t.baseUrl, attacker);
  assert.equal((await api.post('/cart/items', { productId: products[0].id })).status, 201);
  const squat = await api.post('/checkout', {
    customer: { name: 'Evil', phone: '+998 93 555 44 33' }, delivery: { method: 'pickup' }, invoice: false,
  });
  assert.equal(squat.status, 201);
  assert.equal((await api.post(`/orders/${squat.body.order.id}/cancel`)).status, 200);

  const victimOrder = await siteSubscription({
    name: 'Виктория', phone: '93 555 44 33', email: 'victoria@example.com', address: 'Ташкент, Приватная 1, кв. 5',
  });
  const attackerRow = customers.getCustomerByTgUserId(attacker.id);
  assert.notEqual(victimOrder.customer_id, attackerRow.id, 'the site order is not attached to the squatter');
  assert.equal(customers.getCustomer(victimOrder.customer_id).tg_user_id, null);
  assert.equal(attackerRow.email, null);
  assert.equal(attackerRow.address, '');

  const boot = await api.get('/bootstrap');
  assert.equal(boot.body.profile.email, '');
  assert.equal(boot.body.profile.address, '');
  assert.equal(boot.body.subscription, null, 'the subscription of the real owner is not visible');
  const cancel = await api.post('/subscription/cancel');
  assert.equal(cancel.status, 404);
  assert.equal(subscriptions.getCurrentForCustomer(victimOrder.customer_id).status, 'active');
});

test('bot: typing somebody else\'s phone at checkout does not take over their customer record', async () => {
  const victimOrder = await siteSubscription({
    name: 'Жертва', phone: '+998 94 700 11 22', email: 'victim@example.com', address: 'Ташкент, ул. Секретная, 7, кв. 12',
  });
  const attacker = makeUser(666001, { first_name: 'Evil', last_name: '' });
  // first contact through the deep link of an unclaimed site order: no customer row is created yet
  await send(message(attacker, `/start order_${victimOrder.number}`));
  assert.equal(customers.getCustomerByTgUserId(attacker.id), undefined);
  await send(message(attacker, '✖️ Отмена'));
  await send(callback(attacker, `buy:${products[0].id}`));
  await send(message(attacker, '+998947001122'));
  await send(callback(attacker, 'co:pickup'));
  await send(callback(attacker, 'co:ok'));

  const victim = customers.getCustomer(victimOrder.customer_id);
  assert.equal(victim.tg_user_id, null, 'the record of the site customer is not linked to the attacker');
  assert.equal(victim.name, 'Жертва');
  assert.equal(victim.email, 'victim@example.com');
  const own = customers.getCustomerByTgUserId(attacker.id);
  assert.ok(own && own.id !== victim.id, 'the attacker got a record of their own');
  assert.equal(own.email, null);
  assert.equal(own.address, '');
  assert.equal(subscriptions.getCurrentForTgUser(attacker.id), null);
  assert.equal(orders.getOrder(victimOrder.id).tg_user_id, null);

  const api = tmaClient(t.baseUrl, { id: attacker.id, first_name: 'Evil' });
  const boot = await api.get('/bootstrap');
  assert.equal(boot.body.profile.email, '');
  assert.equal(boot.body.subscription, null);
  assert.equal((await api.post('/subscription/cancel')).status, 404);
  assert.equal(subscriptions.getCurrentForCustomer(victim.id).status, 'active');
});

test('site: an anonymous checkout never rewrites a customer record (Telegram-linked or not)', async () => {
  // Telegram-linked record: not matched at all
  const linked = customers.upsertCustomer({
    name: 'Victim', phone: '+998901234599', email: 'v@example.com', address: 'Real street 1', tgUserId: 4242, source: 'bot',
  });
  const c = t.newClient();
  await c.get('/catalog');
  await c.postForm('/cart/add', { product_id: String(products[1].id), qty: '1', redirect: '/catalog' });
  await c.get('/checkout');
  const placed = await c.postForm('/checkout', {
    name: 'Mallory', phone: '90 123 45 99', email: 'mallory@evil.example', method: 'courier', address: 'Attacker drop address 9',
  });
  assert.equal(placed.status, 303);
  const after = customers.getCustomer(linked.id);
  assert.deepEqual([after.name, after.email, after.address, after.tg_user_id], ['Victim', 'v@example.com', 'Real street 1', 4242]);
  const order = orders.getOrderByToken(/\/pay\/order\/([0-9a-f]+)/.exec(placed.location)[1]);
  assert.notEqual(order.customer_id, linked.id);
  const siteRow = customers.getCustomer(order.customer_id);
  assert.equal(siteRow.tg_user_id, null);
  assert.equal(siteRow.name, 'Mallory');

  // unlinked record of the same phone: the order is grouped under it, stored contacts are kept,
  // only empty fields are filled in
  const first = customers.upsertCustomer({ name: 'Первый', phone: '+998901230001', source: 'site' });
  const second = customers.upsertCustomer({ name: 'Второй', phone: '90 123 00 01', email: 'second@example.com', address: 'Адрес 2', source: 'site' });
  assert.equal(second.id, first.id);
  assert.deepEqual([second.name, second.email, second.address], ['Первый', 'second@example.com', 'Адрес 2']);
  const third = customers.upsertCustomer({ name: 'Третий', phone: '+998901230001', email: 'third@example.com', address: 'Адрес 3', source: 'site' });
  assert.deepEqual([third.id, third.name, third.email, third.address], [first.id, 'Первый', 'second@example.com', 'Адрес 2']);

  // an e-mail alone never matches a record that has a phone (it could belong to anyone)
  const byEmail = customers.upsertCustomer({ name: 'Кто-то', phone: '+998901230002', email: 'second@example.com', source: 'site' });
  assert.notEqual(byEmail.id, first.id);
  assert.notEqual(customers.upsertCustomer({ email: 'second@example.com' }).id, first.id);
});

test('linkTelegramAccount ignores unverifiable input and never touches another Telegram account', () => {
  assert.equal(customers.linkTelegramAccount({ tgUserId: 0, phone: '+998901112200' }), null);
  assert.equal(customers.linkTelegramAccount({ tgUserId: 5151, phone: '12' }), null);
  const other = customers.upsertCustomer({ name: 'Чужой', phone: '+998901112201', email: 'other@example.com', tgUserId: 5152, source: 'tma' });
  const mine = customers.linkTelegramAccount({ tgUserId: 5153, phone: '+998901112201', customerId: other.id, name: 'Я' });
  assert.notEqual(mine.id, other.id);
  assert.equal(mine.tg_user_id, 5153);
  assert.equal(mine.email, null);
  assert.equal(customers.getCustomer(other.id).tg_user_id, 5152);
});

test('a returning bot user who links a site order gets one customer record: subscription visible, reminders sent', async () => {
  const user = makeUser(7001);
  await send(message(user, '/start'));
  const own = customers.getCustomerByTgUserId(user.id);
  assert.ok(own, '/start created the customer record');

  const order = await siteSubscription({ name: 'Сайт Клиент', phone: '+998 90 111 22 33', email: 'site@example.com', address: 'Ташкент, Мирабад, 3' });
  const siteCustomerId = order.customer_id;
  assert.notEqual(siteCustomerId, own.id);
  assert.equal(subscriptions.getCurrentForTgUser(user.id), null);

  await send(message(user, `/start order_${order.number}`));
  fake.reset();
  await send(message(user, null, { contact: { phone_number: '+998901112233', first_name: 'Алишер', user_id: user.id } }));
  assert.match(fake.callsTo('sendMessage').map((p) => p.text).join('\n'), /заказ привязан/);

  const rows = all('SELECT id, tg_user_id FROM customers WHERE phone = ?', '+998901112233');
  assert.deepEqual(rows, [{ id: own.id, tg_user_id: user.id }], 'the two records were merged into the user\'s own one');
  assert.equal(customers.getCustomer(siteCustomerId), undefined);
  const merged = customers.getCustomer(own.id);
  assert.equal(merged.email, 'site@example.com');
  assert.equal(merged.address, 'Ташкент, Мирабад, 3');
  const linkedOrder = orders.getOrder(order.id);
  assert.deepEqual([linkedOrder.customer_id, linkedOrder.tg_user_id], [own.id, user.id]);

  const sub = subscriptions.getCurrentForTgUser(user.id);
  assert.ok(sub, 'the site subscription is now the subscription of the Telegram user');
  fake.reset();
  await send(message(user, '🔁 Моя подписка'));
  assert.ok(lastText(fake, user.id).text.includes(plan.title));

  // the reminder reaches the user
  run('UPDATE subscriptions SET current_period_end = ? WHERE id = ?', new Date(Date.now() + 2 * 86_400_000).toISOString(), sub.id);
  fake.reset();
  const result = await tick({ force: true });
  assert.equal(result.reminded, 1);

  // a renewal from the bot extends the same subscription instead of starting a second one
  const renewal = orders.createSubscriptionOrder({
    planId: plan.id, customer: { name: 'Алишер', phone: '+998901112233' }, channel: 'bot', tgUserId: user.id,
  });
  orders.markPaid(renewal.id, { provider: 'mock', amount: renewal.total });
  await notify.flush();
  assert.equal(get(`SELECT COUNT(*) AS n FROM subscriptions WHERE customer_id = ? AND status = 'active'`, own.id).n, 1);
  assert.equal(subscriptions.getCurrentForTgUser(user.id).renewals, 1);
});

test('contacts typed into anonymous forms are not inherited when a record is taken over', async () => {
  // somebody pre-seeds a site record for the victim's number with their own drop address
  const ref = { token: cart.newToken() };
  cart.addItem(ref, products[0].id, 1);
  orders.createFromCart(ref, {
    customer: { name: 'Курьеру сюда', phone: '+998 95 300 40 50', email: 'drop@evil.example' },
    delivery: { method: 'courier', address: 'Чужой адрес, 99' },
  });
  // the real owner orders on the site (pickup) and links that order in the bot
  const ref2 = { token: cart.newToken() };
  cart.addItem(ref2, products[0].id, 1);
  const own = orders.createFromCart(ref2, { customer: { name: 'Настоящий Владелец', phone: '95 300 40 50' }, delivery: { method: 'pickup' } });
  await notify.flush();
  const user = makeUser(7010);
  await send(message(user, `/start order_${own.number}`));
  await send(message(user, null, { contact: { phone_number: '+998953004050', first_name: 'Владелец', user_id: user.id } }));
  const customer = customers.getCustomerByTgUserId(user.id);
  assert.equal(customer.id, own.customer_id, 'the site record is taken over (verified phone)');
  assert.equal(customer.name, 'Настоящий Владелец');
  assert.equal(customer.email, null, 'the e-mail of the earlier anonymous order is not trusted');
  assert.equal(customer.address, '', 'the address of the earlier anonymous order is not trusted');
});
