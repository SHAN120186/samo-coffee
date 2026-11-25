import { FAKE_TG_PORT, ADMIN_CHAT_ID, PAYMENT_TOKEN } from './bot.env-payments.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeTelegram } from './helpers/fakeTelegram.js';
import { makeCatalog, makePlan } from './helpers/fixtures.js';
import { BOT_INFO, makeUser, message, callback, preCheckout, successfulPayment, callsToChat, lastText } from './bot.helpers.js';
import { createBot } from '../src/bot/bot.js';
import { all, get } from '../src/db/index.js';
import * as catalog from '../src/services/catalog.js';
import * as cart from '../src/services/cart.js';
import * as orders from '../src/services/orders.js';
import * as payments from '../src/services/payments.js';
import * as subscriptions from '../src/services/subscriptions.js';
import * as notify from '../src/services/notify.js';

let fake;
let bot;
let shop;
let plan;

const send = async (update) => {
  await bot.handleUpdate(update);
  await notify.flush();
};

/** Walk the chat checkout for one product (pickup) and return the created order. */
async function buy(user, product, { qty = 1 } = {}) {
  await send(callback(user, `buy:${product.id}`));
  if (!orders.listForTgUser(user.id).length) await send(message(user, `+998 90 ${String(user.id).padStart(7, '0')}`));
  await send(callback(user, 'co:pickup'));
  for (let i = 1; i < qty; i += 1) await send(callback(user, 'co:qty:+'));
  await send(callback(user, 'co:ok'));
  return orders.listForTgUser(user.id)[0];
}

before(async () => {
  fake = await startFakeTelegram(FAKE_TG_PORT);
  bot = createBot({ botInfo: BOT_INFO });
  shop = makeCatalog(3);
  plan = makePlan({ title: 'Фильтр-клуб', price: 189000, period_days: 30 });
});
after(async () => {
  await fake.close();
});
beforeEach(() => fake.reset());

test('"Купить" with TELEGRAM_PAYMENT_TOKEN sends an invoice: payload order:<id>, UZS, amounts in tiyin', async () => {
  const user = makeUser(9001);
  const product = shop.products[0]; // 100 000 сум
  await send(message(user, '/start'));
  fake.reset();
  const order = await buy(user, product, { qty: 2 });

  const [invoice] = fake.callsTo('sendInvoice');
  assert.ok(invoice, 'sendInvoice is called');
  assert.equal(String(invoice.chat_id), String(user.id));
  assert.equal(invoice.payload, `order:${order.id}`);
  assert.equal(invoice.currency, 'UZS');
  assert.equal(invoice.provider_token, PAYMENT_TOKEN);
  assert.equal(invoice.title, `Заказ ${order.number}`);
  assert.deepEqual(invoice.prices, [{ label: `${product.title} × 2`, amount: 20_000_000 }]);
  assert.equal(invoice.prices.reduce((sum, p) => sum + p.amount, 0), order.total * 100);
  assert.equal(invoice.start_parameter, `order_${order.number}`);

  const fresh = orders.getOrder(order.id);
  assert.equal(fresh.status, 'pending_payment');
  assert.equal(fresh.payment_provider, 'telegram');
  assert.ok(!callsToChat(fake, 'sendMessage', user.id).some((p) => p.text.includes('/pay/order/')), 'no hosted-page link when the invoice was sent');
});

test('pre_checkout_query is approved for a payable order with the right amount', async () => {
  const user = makeUser(9002);
  const order = await buy(user, shop.products[1]); // 120 000 сум
  fake.reset();
  await send(preCheckout(user, { payload: `order:${order.id}`, amount: 12_000_000 }));
  const [answer] = fake.callsTo('answerPreCheckoutQuery');
  assert.equal(answer.ok, true);
  assert.equal(answer.error_message, undefined);
});

test('pre_checkout_query is rejected with a Russian message: wrong amount, unknown, cancelled, paid, out of stock', async () => {
  const user = makeUser(9003);
  const product = shop.products[2]; // 140 000 сум
  const order = await buy(user, product);
  const answer = async (query) => {
    fake.reset();
    await send(preCheckout(user, query));
    const [a] = fake.callsTo('answerPreCheckoutQuery');
    return a;
  };

  let a = await answer({ payload: `order:${order.id}`, amount: 13_999_900 });
  assert.equal(a.ok, false);
  assert.match(a.error_message, /Сумма заказа изменилась/);

  a = await answer({ payload: `order:${order.id}`, amount: 14_000_000, currency: 'USD' });
  assert.equal(a.ok, false);

  a = await answer({ payload: 'order:987654', amount: 14_000_000 });
  assert.equal(a.ok, false);
  assert.match(a.error_message, /Заказ не найден/);

  a = await answer({ payload: 'something-else', amount: 14_000_000 });
  assert.equal(a.ok, false);

  // the product ran out while the invoice was waiting
  const stock = catalog.getProduct(product.id).stock;
  catalog.adjustStock(product.id, -stock);
  a = await answer({ payload: `order:${order.id}`, amount: 14_000_000 });
  assert.equal(a.ok, false);
  assert.match(a.error_message, /закончился/);
  catalog.adjustStock(product.id, stock);
  a = await answer({ payload: `order:${order.id}`, amount: 14_000_000 });
  assert.equal(a.ok, true);

  orders.cancel(order.id, { actor: 'customer' });
  a = await answer({ payload: `order:${order.id}`, amount: 14_000_000 });
  assert.equal(a.ok, false);
  assert.match(a.error_message, /отменён/);

  const paid = await buy(user, shop.products[1]);
  orders.markPaid(paid.id, { provider: 'mock', amount: paid.total });
  await notify.flush();
  a = await answer({ payload: `order:${paid.id}`, amount: 12_000_000 });
  assert.equal(a.ok, false);
  assert.match(a.error_message, /уже оплачен/);
});

test('successful_payment marks the order paid exactly once (provider "telegram", charge id, stock, event, notifications)', async () => {
  const user = makeUser(9004);
  const product = shop.products[0];
  const stockBefore = catalog.getProduct(product.id).stock;
  const order = await buy(user, product, { qty: 3 });
  fake.reset();

  const update = successfulPayment(user, { payload: `order:${order.id}`, amount: 30_000_000, chargeId: 'tg_charge_9004' });
  await send(update);

  let fresh = orders.getOrder(order.id);
  assert.equal(fresh.status, 'paid');
  assert.equal(fresh.payment_status, 'paid');
  assert.equal(fresh.payment_provider, 'telegram');
  const rows = payments.listByOrder(order.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'telegram');
  assert.equal(rows[0].provider_tx_id, 'tg_charge_9004');
  assert.equal(rows[0].status, 'paid');
  assert.equal(rows[0].amount, 300000);
  assert.equal(catalog.getProduct(product.id).stock, stockBefore - 3);
  assert.equal(all(`SELECT id FROM events WHERE name = 'purchase' AND order_id = ?`, order.id).length, 1);

  // the customer and the admins are told (notify service)
  const toUser = callsToChat(fake, 'sendMessage', user.id);
  assert.equal(toUser.length, 1);
  assert.match(toUser[0].text, /Оплата получена/);
  assert.ok(toUser[0].text.includes(order.number));
  assert.ok(callsToChat(fake, 'sendMessage', ADMIN_CHAT_ID).some((p) => p.text.includes(`Оплачен заказ ${order.number}`)));

  // Telegram re-delivers the update, and a duplicate with the same charge id arrives: nothing changes
  fake.reset();
  await send(update);
  await send(successfulPayment(user, { payload: `order:${order.id}`, amount: 30_000_000, chargeId: 'tg_charge_9004' }));
  fresh = orders.getOrder(order.id);
  assert.equal(fresh.status, 'paid');
  assert.equal(payments.listByOrder(order.id).length, 1);
  assert.equal(catalog.getProduct(product.id).stock, stockBefore - 3, 'stock is decremented once');
  assert.equal(all(`SELECT id FROM events WHERE name = 'purchase' AND order_id = ?`, order.id).length, 1);
  assert.equal(fake.calls.length, 0, 'no second round of notifications');
});

test('a subscription paid in Telegram is activated, and "Продлить" extends it with a new invoice', async () => {
  const user = makeUser(9005);
  await send(callback(user, `sub:${plan.id}`));
  await send(message(user, null, { contact: { phone_number: '+998907000005', first_name: 'Алишер', user_id: user.id } }));
  await send(callback(user, 'co:courier'));
  await send(message(user, 'Ташкент, Мирабад, 21'));
  fake.reset();
  await send(callback(user, 'co:ok'));
  const [order] = orders.listForTgUser(user.id);
  const [invoice] = fake.callsTo('sendInvoice');
  assert.equal(invoice.payload, `order:${order.id}`);
  assert.deepEqual(invoice.prices, [{ label: 'Подписка «Фильтр-клуб»', amount: 18_900_000 }]);

  await send(preCheckout(user, { payload: invoice.payload, amount: 18_900_000 }));
  assert.equal(fake.callsTo('answerPreCheckoutQuery')[0].ok, true);
  fake.reset();
  await send(successfulPayment(user, { payload: invoice.payload, amount: 18_900_000 }));
  const sub = subscriptions.getCurrentForTgUser(user.id);
  assert.equal(sub.status, 'active');
  assert.equal(sub.plan_id, plan.id);
  assert.equal(sub.days_left, 30);
  assert.ok(callsToChat(fake, 'sendMessage', user.id).some((p) => /Подписка оформлена/.test(p.text)));

  // renew: one tap → a new order + invoice; after the payment the period is 60 days
  fake.reset();
  await send(callback(user, 'renew'));
  const [renewal] = orders.listForTgUser(user.id);
  assert.notEqual(renewal.id, order.id);
  assert.equal(renewal.delivery_address, 'Ташкент, Мирабад, 21', 'the saved address is reused');
  assert.equal(fake.callsTo('sendInvoice')[0].payload, `order:${renewal.id}`);
  await send(successfulPayment(user, { payload: `order:${renewal.id}`, amount: 18_900_000 }));
  const renewed = subscriptions.getCurrentForTgUser(user.id);
  assert.equal(renewed.id, sub.id);
  assert.equal(renewed.renewals, 1);
  assert.equal(renewed.days_left, 60);
  assert.ok(callsToChat(fake, 'sendMessage', user.id).some((p) => /Подписка продлена/.test(p.text)));
});

test('a payment that cannot be matched to an order is escalated to the admins, not swallowed', async () => {
  const user = makeUser(9006);
  const order = await buy(user, shop.products[1]);
  fake.reset();
  await send(successfulPayment(user, { payload: `order:${order.id}`, amount: 11_000_000, chargeId: 'tg_charge_wrong' }));
  assert.equal(orders.getOrder(order.id).payment_status, 'pending', 'a wrong amount never marks the order paid');
  const alert = lastText(fake, ADMIN_CHAT_ID);
  assert.match(alert.text, /Платёж в Telegram требует проверки/);
  assert.ok(alert.text.includes('amount_mismatch'));
  assert.ok(alert.text.includes('tg_charge_wrong'));
  assert.match(lastText(fake, user.id).text, /получили платёж/);
});

test('an invoice link paid for an order without a Telegram user links the payer; a refused invoice falls back to the hosted page', async () => {
  const product = shop.products[2];
  const ref = { token: cart.newToken() };
  cart.addItem(ref, product.id, 1);
  const siteOrder = orders.createFromCart(ref, { customer: { name: 'Сайт Клиент', phone: '+998 91 222 33 44' }, delivery: { method: 'pickup' } });
  await notify.flush();
  const payer = makeUser(9007);
  await send(successfulPayment(payer, { payload: `order:${siteOrder.id}`, amount: 14_000_000 }));
  const fresh = orders.getOrder(siteOrder.id);
  assert.equal(fresh.payment_status, 'paid');
  assert.equal(fresh.tg_user_id, payer.id);
  assert.ok(callsToChat(fake, 'sendMessage', payer.id).some((p) => /Оплата получена/.test(p.text)));

  // Telegram refuses the invoice (bad provider token) → the customer still gets a way to pay
  const user = makeUser(9008);
  fake.on('sendInvoice', () => ({ error_code: 400, description: 'Bad Request: PAYMENT_PROVIDER_INVALID' }));
  const order = await buy(user, shop.products[1]);
  assert.ok(lastText(fake, user.id).text.includes(`/pay/order/${order.public_token}`));
  assert.equal(get('SELECT payment_status FROM orders WHERE id = ?', order.id).payment_status, 'unpaid');
});
