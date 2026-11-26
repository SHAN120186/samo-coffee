// Telegram Payments provider against a fake Bot API server (TELEGRAM_API_ROOT): invoice parameters,
// the invoice link for the Mini App, the "pay in Telegram" page of the site, failures.
import { FAKE_TG_PORT, PAYMENT_TOKEN } from './payments.env-telegram.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/http.js';
import { startFakeTelegram } from './helpers/fakeTelegram.js';
import { config } from '../src/config.js';
import { formatSum } from '../src/lib/money.js';
import * as orders from '../src/services/orders.js';
import * as settings from '../src/services/settings.js';
import * as notify from '../src/services/notify.js';
import * as paymentsRepo from '../src/services/payments.js';
import * as telegramPayments from '../src/services/telegramPayments.js';
import { startPayment, getProvider, buildInvoiceParams, invoicePayload, parseInvoicePayload } from '../src/payments/index.js';
import { makeOrder, makeSubscriptionOrder, stockOf, purchaseEvents, paidRows } from './payments.helpers.js';

let t;
let fake;
before(async () => {
  fake = await startFakeTelegram(FAKE_TG_PORT);
  t = await startTestApp();
});
after(async () => {
  settings.set('payment_provider', '');
  await notify.flush();
  await t.close();
  await fake.close();
});

const sum = (prices) => prices.reduce((s, p) => s + p.amount, 0);

test('buildInvoiceParams: title, description, payload "order:<id>", UZS, prices in tiyin that add up to the total', () => {
  assert.equal(getProvider('telegram').isConfigured(), true);
  const { order, product } = makeOrder({ qty: 2, price: 120000 });
  const params = buildInvoiceParams(order);
  assert.equal(params.title, `Заказ ${order.number}`);
  assert.ok(params.title.length <= 32);
  assert.ok(params.description.includes(product.title));
  assert.ok(params.description.length <= 255);
  assert.equal(params.payload, `order:${order.id}`);
  assert.equal(params.payload, invoicePayload(order.id));
  assert.equal(parseInvoicePayload(params.payload), order.id);
  assert.equal(params.provider_token, PAYMENT_TOKEN);
  assert.equal(params.currency, 'UZS');
  assert.deepEqual(params.prices[0], { label: `${product.title} × 2`, amount: 24_000_000 });
  assert.ok(params.prices.every((p) => Number.isInteger(p.amount) && typeof p.label === 'string' && p.label.length > 0));
  assert.equal(sum(params.prices), order.total * 100, 'minor units: sum × 100');
  if (order.delivery_fee > 0) assert.ok(params.prices.some((p) => p.label === 'Доставка' && p.amount === order.delivery_fee * 100));
  assert.equal('need_phone_number' in params, false, 'the phone is not requested by default');

  assert.equal(buildInvoiceParams(order, { needPhone: true }).need_phone_number, true);

  const sub = makeSubscriptionOrder({ price: 189000 }).order;
  const subParams = buildInvoiceParams(sub);
  assert.equal(subParams.payload, `order:${sub.id}`);
  assert.equal(sum(subParams.prices), 18_900_000);

  // an invoice whose lines do not add up to the order total is never issued
  assert.throws(() => buildInvoiceParams({ ...order, total: order.total + 1 }), (e) => e.code === 'amount_mismatch');
});

test('startPayment(telegram) calls createInvoiceLink with the invoice and records the attempt', async () => {
  const { order } = makeOrder({ qty: 1 });
  fake.reset();
  const result = await startPayment(order, { providerId: 'telegram', channel: 'tma', returnUrl: '/tma/#/pay/3' });
  assert.deepEqual(result, { provider: 'telegram', invoiceLink: 'https://t.me/$fake_invoice_link' });

  const calls = fake.calls.filter((c) => c.method === 'createInvoiceLink');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].token, config.bot.token, 'the call goes through telegramApi with the bot token');
  const sent = calls[0].params;
  const expected = buildInvoiceParams(order);
  assert.deepEqual(sent, expected, 'exactly the documented invoice fields are sent');
  assert.equal(sent.payload, `order:${order.id}`);
  assert.equal(sent.currency, 'UZS');
  assert.equal(sent.provider_token, PAYMENT_TOKEN);
  assert.equal(sum(sent.prices), order.total * 100);

  const fresh = orders.getOrder(order.id);
  assert.deepEqual([fresh.status, fresh.payment_status, fresh.payment_provider], ['pending_payment', 'pending', 'telegram']);
  const [attempt] = paymentsRepo.listByOrder(order.id);
  assert.deepEqual([attempt.provider, attempt.status, attempt.amount, attempt.provider_tx_id], ['telegram', 'pending', order.total, null]);
  assert.equal(attempt.raw.invoiceLink, 'https://t.me/$fake_invoice_link');
  assert.equal(attempt.raw.payload, `order:${order.id}`);
  assert.equal(attempt.raw.returnUrl, `${config.baseUrl}/tma/#/pay/3`);

  // asking again reuses the attempt row
  await startPayment(fresh, { providerId: 'telegram' });
  assert.equal(paymentsRepo.listByOrder(order.id).length, 1);

  // TELEGRAM_PAYMENT_NEED_PHONE=1 → need_phone_number in the invoice
  config.payments.telegram.needPhone = true;
  try {
    fake.reset();
    await startPayment(makeOrder().order, { providerId: 'telegram' });
    assert.equal(fake.callsTo('createInvoiceLink')[0].need_phone_number, true);
  } finally {
    config.payments.telegram.needPhone = false;
  }
});

test('site: /pay/order → "pay in Telegram" page → successful_payment → the page lets the customer through', async () => {
  settings.set('payment_provider', 'telegram');
  const { order, product } = makeOrder({ qty: 2 });
  const c = t.newClient();

  const start = await c.get(`/pay/order/${order.public_token}?return=/order/${order.public_token}`);
  assert.equal(start.status, 302);
  assert.equal(start.location, `/pay/invoice/${order.public_token}`);

  const page = await c.get(start.location);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.headers.get('x-robots-tag'), /noindex/);
  assert.match(page.text, /href="https:\/\/t\.me\/\$fake_invoice_link"[^>]*data-testid="telegram-invoice-link"/);
  assert.ok(page.text.includes(order.number));
  assert.ok(page.text.includes(formatSum(order.total)), 'the total is shown');
  assert.match(page.text, /<script nonce="[^"]+">/, 'the polling script carries the CSP nonce');
  assert.ok(page.text.includes(`/pay/status/${order.public_token}`));

  const waiting = (await c.get(`/pay/status/${order.public_token}`)).json();
  assert.deepEqual(waiting, { ok: true, number: order.number, status: 'pending_payment', payment_status: 'pending', paid: false, can_pay: true });

  // Telegram asks the bot before charging, then reports the payment (BOT module → shared helpers)
  const invoice = fake.callsTo('createInvoiceLink').at(-1);
  const pre = telegramPayments.validatePreCheckout({ invoice_payload: invoice.payload, currency: 'UZS', total_amount: order.total * 100 });
  assert.equal(pre.ok, true);
  const paid = telegramPayments.handleSuccessfulPayment({
    invoice_payload: invoice.payload, currency: 'UZS', total_amount: order.total * 100,
    telegram_payment_charge_id: 'tg-charge-site-1', provider_payment_charge_id: 'prov-1',
  });
  assert.deepEqual([paid.ok, paid.changed], [true, true]);

  const done = (await c.get(`/pay/status/${order.public_token}`)).json();
  assert.deepEqual([done.paid, done.status, done.can_pay], [true, 'paid', false]);
  const after = await c.get(`/pay/invoice/${order.public_token}`);
  assert.equal(after.status, 303);
  assert.equal(new URL(after.location, 'http://localhost').pathname, `/order/${order.public_token}`);
  assert.equal((await c.get(`/pay/order/${order.public_token}`)).status, 302, 'a paid order is not sent to pay again');

  // exactly one paid row (the Telegram charge); the invoice attempt is closed
  const rows = paymentsRepo.listByOrder(order.id);
  assert.equal(paidRows(order.id).length, 1);
  assert.equal(paidRows(order.id)[0].provider_tx_id, 'tg-charge-site-1');
  assert.ok(rows.every((p) => p.status === 'paid' || p.status === 'cancelled'), 'no attempt is left open');
  assert.equal(stockOf(product), 8);

  // Telegram may deliver the update again, and an invoice link can be opened again
  const dup = telegramPayments.handleSuccessfulPayment({ invoice_payload: invoice.payload, currency: 'UZS', total_amount: order.total * 100, telegram_payment_charge_id: 'tg-charge-site-1' });
  assert.deepEqual([dup.ok, dup.changed], [true, false]);
  assert.equal(telegramPayments.validatePreCheckout({ invoice_payload: invoice.payload, currency: 'UZS', total_amount: order.total * 100 }).ok, false, 'a paid order is refused at pre-checkout');
  assert.equal(stockOf(product), 8);
  assert.equal(purchaseEvents(order.id), 1);
  settings.set('payment_provider', '');
});

test('pre-checkout refuses a wrong amount, a wrong currency, foreign payloads and cancelled orders', () => {
  const { order } = makeOrder();
  const q = (over) => telegramPayments.validatePreCheckout({ invoice_payload: `order:${order.id}`, currency: 'UZS', total_amount: order.total * 100, ...over });
  assert.equal(q({}).ok, true);
  assert.equal(q({ total_amount: order.total }).ok, false, 'sums instead of tiyin');
  assert.equal(q({ total_amount: order.total * 100 - 100 }).ok, false);
  assert.equal(q({ currency: 'USD' }).ok, false);
  assert.equal(q({ invoice_payload: 'order:999999' }).ok, false);
  assert.equal(q({ invoice_payload: `sub:${order.id}` }).ok, false);
  const wrong = telegramPayments.handleSuccessfulPayment({ invoice_payload: `order:${order.id}`, currency: 'UZS', total_amount: order.total * 100 - 100, telegram_payment_charge_id: 'tg-x' });
  assert.deepEqual(wrong, { ok: false, reason: 'amount_mismatch' });
  assert.equal(orders.getOrder(order.id).is_paid, false);
  orders.cancel(order.id);
  assert.equal(q({}).ok, false);
});

test('when Telegram refuses the invoice the attempt is recorded as failed and the order stays payable', async () => {
  const { order } = makeOrder();
  fake.on('createInvoiceLink', () => ({ error_code: 400, description: 'Bad Request: PAYMENT_PROVIDER_INVALID' }));
  try {
    await assert.rejects(
      () => startPayment(order, { providerId: 'telegram' }),
      (err) => err.name === 'TelegramError' && /PAYMENT_PROVIDER_INVALID/.test(err.description),
      'the Bot API error is passed through (the Mini App falls back to the hosted page)',
    );
    const [attempt] = paymentsRepo.listByOrder(order.id);
    assert.equal(attempt.status, 'failed');
    assert.match(attempt.error, /PAYMENT_PROVIDER_INVALID/);
    assert.equal(orders.getOrder(order.id).can_pay, true);

    // the site shows a friendly "payment unavailable" page instead of a stack trace
    settings.set('payment_provider', 'telegram');
    const res = await t.newClient().get(`/pay/order/${order.public_token}`);
    assert.equal(res.status, 503);
    assert.ok(res.text.includes('Не удалось начать оплату'));
    assert.ok(!res.text.includes('PAYMENT_PROVIDER_INVALID'));

    // a link that is not a t.me URL is not trusted either
    fake.on('createInvoiceLink', () => 'https://evil.example/invoice');
    await assert.rejects(() => startPayment(order, { providerId: 'telegram' }), /invalid invoice link/);
    assert.equal((await t.newClient().get(`/pay/invoice/${order.public_token}`)).status, 303, 'no invoice page without a valid link');
  } finally {
    fake.off('createInvoiceLink');
    settings.set('payment_provider', '');
  }
  // …and the next attempt works
  const retry = await startPayment(orders.getOrder(order.id), { providerId: 'telegram' });
  assert.equal(retry.invoiceLink, 'https://t.me/$fake_invoice_link');
});
