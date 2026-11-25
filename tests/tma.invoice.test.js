// Mini App checkout with Telegram Payments configured: the API returns an invoice link for
// WebApp.openInvoice and falls back to the hosted page when an invoice is not possible.
import { FAKE_TG_PORT, PAYMENT_TOKEN } from './tma.env-invoice.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/http.js';
import { startFakeTelegram } from './helpers/fakeTelegram.js';
import { makeCatalog, makePlan } from './helpers/fixtures.js';
import * as orders from '../src/services/orders.js';
import * as notify from '../src/services/notify.js';
import * as telegramPayments from '../src/services/telegramPayments.js';
import { tmaClient, tgUser, CHECKOUT } from './tma.helpers.js';

let t;
let fake;
let products;
before(async () => {
  fake = await startFakeTelegram(FAKE_TG_PORT);
  t = await startTestApp();
  ({ products } = makeCatalog(2, { stock: 50 }));
});
after(async () => {
  await notify.flush();
  await t.close();
  await fake.close();
});

test('checkout returns an invoice link built for the order (payload "order:<id>", amounts in tiyin)', async () => {
  const user = tgUser();
  const api = tmaClient(t.baseUrl, user);
  assert.equal((await api.get('/bootstrap')).body.payments.invoice, true);
  await api.post('/cart/items', { productId: products[0].id, qty: 2 });
  fake.reset();

  const res = await api.post('/checkout', CHECKOUT);
  assert.equal(res.status, 201);
  assert.equal(res.body.provider, 'telegram');
  assert.equal(res.body.invoiceLink, 'https://t.me/$fake_invoice_link');
  assert.equal(res.body.redirectUrl, undefined);
  const { order } = res.body;
  assert.equal(order.status, 'pending_payment');
  assert.equal(order.payment_provider, 'telegram');

  const [invoice] = fake.callsTo('createInvoiceLink');
  assert.equal(invoice.payload, `order:${order.id}`);
  assert.equal(invoice.provider_token, PAYMENT_TOKEN);
  assert.equal(invoice.currency, 'UZS');
  assert.equal(invoice.prices.reduce((sum, p) => sum + p.amount, 0), order.total * 100);

  // Telegram charges the card → the bot receives successful_payment → the single markPaid entry point
  const pre = telegramPayments.validatePreCheckout({ invoice_payload: invoice.payload, currency: 'UZS', total_amount: order.total * 100 });
  assert.equal(pre.ok, true);
  const paid = telegramPayments.handleSuccessfulPayment({ invoice_payload: invoice.payload, currency: 'UZS', total_amount: order.total * 100, telegram_payment_charge_id: 'tg-charge-1' });
  assert.equal(paid.ok, true);
  assert.equal(paid.changed, true);

  const fresh = (await api.get(`/orders/${order.id}`)).body.order;
  assert.equal(fresh.is_paid, true, 'the Mini App sees the payment while polling the order');
  assert.equal((await api.post(`/orders/${order.id}/pay`, {})).body.error, 'already_paid');
});

test('a client that cannot open invoices gets the hosted payment page instead', async () => {
  const api = tmaClient(t.baseUrl, tgUser());
  await api.post('/cart/items', { productId: products[1].id });
  fake.reset();
  const res = await api.post('/checkout', { ...CHECKOUT, invoice: false, returnToApp: true });
  assert.equal(res.status, 201);
  assert.equal(res.body.invoiceLink, undefined);
  assert.match(res.body.redirectUrl, /\/pay\/mock\//);
  assert.equal(fake.callsTo('createInvoiceLink').length, 0);

  // later, from a Telegram client that supports invoices, the same order gets an invoice link
  const retry = await api.post(`/orders/${res.body.order.id}/pay`, { invoice: true });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.invoiceLink, 'https://t.me/$fake_invoice_link');
  assert.equal(orders.getOrder(res.body.order.id).payment_provider, 'telegram');
});

test('when Telegram refuses to create the invoice the order is kept and the hosted page is offered', async () => {
  const api = tmaClient(t.baseUrl, tgUser());
  await api.post('/cart/items', { productId: products[1].id });
  fake.on('createInvoiceLink', () => ({ error_code: 400, description: 'Bad Request: PAYMENT_PROVIDER_INVALID' }));
  try {
    const res = await api.post('/checkout', CHECKOUT);
    assert.equal(res.status, 201);
    assert.equal(res.body.invoiceLink, undefined);
    assert.match(res.body.redirectUrl, /\/pay\/mock\//);
    assert.equal(res.body.order.can_pay, true);
    assert.equal((await api.get('/orders')).body.items.length, 1);
  } finally {
    fake.off('createInvoiceLink');
  }
});

test('subscriptions are paid with an invoice too', async () => {
  const plan = makePlan({ price: 379000 });
  const user = tgUser();
  const api = tmaClient(t.baseUrl, user);
  fake.reset();
  const res = await api.post('/subscribe', { planId: plan.id, customer: CHECKOUT.customer });
  assert.equal(res.status, 201);
  assert.equal(res.body.invoiceLink, 'https://t.me/$fake_invoice_link');
  const [invoice] = fake.callsTo('createInvoiceLink');
  assert.equal(invoice.payload, `order:${res.body.order.id}`);
  assert.equal(invoice.prices[0].amount, 37900000);

  telegramPayments.handleSuccessfulPayment({ invoice_payload: invoice.payload, currency: 'UZS', total_amount: 37900000, telegram_payment_charge_id: 'tg-charge-2' });
  assert.equal((await api.get('/subscription')).body.subscription.status, 'active');
});
