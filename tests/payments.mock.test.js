// The built-in demo checkout (mock provider) over HTTP, the return/status handlers that never trust
// the query string, the registry rules, and the production switch (ALLOW_MOCK_PAYMENTS).
import './payments.env.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startTestApp } from './helpers/http.js';
import { run } from '../src/db/index.js';
import { config } from '../src/config.js';
import { formatSum } from '../src/lib/money.js';
import * as orders from '../src/services/orders.js';
import * as settings from '../src/services/settings.js';
import * as paymentsRepo from '../src/services/payments.js';
import { startPayment, listProviders, resolveProvider, activeProviderId, getProvider, registerProvider, safeReturnUrl } from '../src/payments/index.js';
import { redact, setLogSink, paymentLog } from '../src/payments/log.js';
import { makeOrder, stockOf, purchaseEvents, paidRows } from './payments.helpers.js';

let t;
before(async () => {
  t = await startTestApp();
});
after(async () => {
  settings.set('payment_provider', '');
  await t.close();
});

const pathOf = (url) => new URL(url, t.baseUrl).pathname;

test('checkout page: order summary, test card, three actions, CSRF token, not cacheable', async () => {
  const { order, product } = makeOrder({ qty: 2 });
  const c = t.newClient();
  const start = await c.get(order.pay_url);
  assert.equal(start.status, 302);
  assert.match(start.location, /\/pay\/mock\/mock_[0-9a-f]{24}$/);

  const page = await c.get(start.location);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.headers.get('x-robots-tag'), /noindex/);
  assert.ok(page.text.includes(order.number));
  assert.ok(page.text.includes(formatSum(order.total)));
  assert.ok(page.text.includes(product.title));
  assert.ok(page.text.includes('Демо-режим'));
  assert.ok(page.text.includes('Тестовая карта'));
  assert.match(page.text, /name="_csrf" value="[^"]+"/);
  assert.match(page.text, /<button[^>]*value="success"[^>]*data-testid="mock-pay-success">Оплатить /);
  assert.match(page.text, /<button[^>]*value="fail"[^>]*data-testid="mock-pay-fail">Отклонить</);
  assert.match(page.text, /<button[^>]*value="cancel"[^>]*data-testid="mock-pay-cancel">/);
  assert.ok(!/<script(?![^>]*(nonce|application\/json))/.test(page.text), 'no inline script without a nonce');
});

test('POST needs a CSRF token and a known action; success is applied exactly once', async () => {
  const { order, product } = makeOrder({ qty: 3 });
  const c = t.newClient();
  const start = await c.get(order.pay_url);
  const txPath = pathOf(start.location);
  await c.get(txPath);

  // no token / wrong token → 403, nothing changes
  const noToken = await c.request('POST', txPath, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'action=success' });
  assert.equal(noToken.status, 403);
  const badToken = await c.request('POST', txPath, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'action=success&_csrf=forged' });
  assert.equal(badToken.status, 403);
  const stranger = await t.newClient().request('POST', txPath, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `action=success&_csrf=${c.csrfToken}` });
  assert.equal(stranger.status, 403, 'a token from another session is useless');
  assert.equal(orders.getOrder(order.id).is_paid, false);

  for (const action of ['', 'paid', 'SUCCESS', 'refund']) {
    assert.equal((await c.postForm(txPath, { action })).status, 400, `action "${action}"`);
  }
  assert.equal(orders.getOrder(order.id).is_paid, false);

  const paid = await c.postForm(txPath, { action: 'success' });
  assert.equal(paid.status, 303);
  assert.equal(pathOf(paid.location), `/order/${order.public_token}`);
  const fresh = orders.getOrder(order.id);
  assert.deepEqual([fresh.status, fresh.payment_status, fresh.payment_provider], ['paid', 'paid', 'mock']);
  assert.equal(stockOf(product), 7);

  // replays and other actions after the payment change nothing
  for (const action of ['success', 'fail', 'cancel', 'success']) {
    assert.equal((await c.postForm(txPath, { action })).status, 303);
  }
  assert.equal(orders.getOrder(order.id).status, 'paid');
  assert.equal(stockOf(product), 7);
  assert.equal(purchaseEvents(order.id), 1);
  assert.equal(paidRows(order.id).length, 1);
  assert.equal((await c.get(txPath)).status, 302, 'a used attempt has no checkout page');
  await assert.rejects(() => startPayment(orders.getOrder(order.id)), (e) => e.code === 'already_paid');
});

test('"Отклонить" keeps the order payable with a new attempt; "Вернуться" changes nothing', async () => {
  const { order, product } = makeOrder();
  const c = t.newClient();
  const first = pathOf((await c.get(order.pay_url)).location);
  await c.get(first);

  // back to the shop: same attempt stays usable
  assert.equal((await c.postForm(first, { action: 'cancel' })).status, 303);
  let fresh = orders.getOrder(order.id);
  assert.deepEqual([fresh.status, fresh.payment_status], ['pending_payment', 'pending']);
  assert.equal(pathOf((await c.get(order.pay_url)).location), first, 'the pending attempt is reused');
  assert.equal(paymentsRepo.listByOrder(order.id).length, 1);

  // declined by the "bank"
  await c.get(first);
  assert.equal((await c.postForm(first, { action: 'fail' })).status, 303);
  fresh = orders.getOrder(order.id);
  assert.deepEqual([fresh.status, fresh.payment_status, fresh.can_pay], ['pending_payment', 'failed', true]);
  assert.equal(paymentsRepo.listByOrder(order.id)[0].status, 'failed');
  assert.equal((await c.get(first)).status, 302, 'a failed attempt cannot be reused');
  assert.equal((await c.postForm(first, { action: 'success' })).status, 303);
  assert.equal(orders.getOrder(order.id).is_paid, false, 'paying through a failed attempt does nothing');

  const second = pathOf((await c.get(order.pay_url)).location);
  assert.notEqual(second, first);
  await c.get(second);
  await c.postForm(second, { action: 'success' });
  assert.equal(orders.getOrder(order.id).status, 'paid');
  assert.equal(stockOf(product), 8);
  assert.deepEqual(paymentsRepo.listByOrder(order.id).map((p) => p.status), ['paid', 'failed']);
});

test('unknown or malformed attempts are 404; an attempt whose amount no longer matches cannot be paid', async () => {
  const c = t.newClient();
  for (const tx of ['mock_000000000000000000000000', 'mock_xyz', 'abc', 'mock_0123456789abcdef0123456']) {
    assert.equal((await c.get(`/pay/mock/${tx}`)).status, 404, tx);
  }
  const { order } = makeOrder();
  const txPath = pathOf((await c.get(order.pay_url)).location);
  await c.get(txPath);
  const [attempt] = paymentsRepo.listByOrder(order.id);
  paymentsRepo.updatePayment(attempt.id, { amount: order.total - 1000 });
  assert.equal((await c.get(txPath)).status, 302);
  assert.equal((await c.postForm(txPath, { action: 'success' })).status, 303);
  assert.equal(orders.getOrder(order.id).is_paid, false);
  // starting again issues a correct attempt
  const next = pathOf((await c.get(order.pay_url)).location);
  assert.notEqual(next, txPath);
  assert.equal(paymentsRepo.listByOrder(order.id)[0].amount, order.total);
});

test('return URLs: only same-site targets are honoured; /pay/return and /pay/status read the database, not the query', async () => {
  const { order } = makeOrder();
  const c = t.newClient();

  // open redirect attempts fall back to the order page
  for (const evil of ['https://evil.example/', '//evil.example', '/\\evil.example', 'javascript:alert(1)', `${config.baseUrl}.evil.example/x`,
    '/.//evil.example/', '/a/..//evil.example/', `${config.baseUrl}/.//evil.example/`]) {
    const res = await c.get(`/pay/order/${order.public_token}?return=${encodeURIComponent(evil)}`);
    await c.get(res.location);
    const back = await c.postForm(pathOf(res.location), { action: 'cancel' });
    assert.equal(back.location, `${config.baseUrl}/order/${order.public_token}`, evil);
  }
  assert.equal(safeReturnUrl('/tma/#/pay/1', order), `${config.baseUrl}/tma/#/pay/1`);
  assert.equal(safeReturnUrl('/ok\r\nSet-Cookie: x=1', order), `${config.baseUrl}/order/${order.public_token}`);

  // a "successful" looking return does not pay anything
  const status = `/pay/status/${order.public_token}`;
  const forged = await c.get(`/pay/return/${order.public_token}?payment_status=2&status=success&paid=1&error=0&amount=${order.total}`);
  assert.equal(forged.status, 303);
  assert.equal(forged.location, `${config.baseUrl}/order/${order.public_token}`);
  assert.equal(orders.getOrder(order.id).is_paid, false);
  assert.deepEqual((await c.get(`${status}?paid=1`)).json(), { ok: true, number: order.number, status: 'pending_payment', payment_status: 'pending', paid: false, can_pay: true });

  // the stored return URL of the attempt is used — and never one from the query string
  const start = await c.get(`/pay/order/${order.public_token}?return=${encodeURIComponent('/tma/#/pay/9')}`);
  await c.get(start.location);
  const ret = await c.get(`/pay/return/${order.public_token}?return=https://evil.example/&return_url=https://evil.example/`);
  assert.equal(ret.location, `${config.baseUrl}/tma/#/pay/9`);
  await c.postForm(pathOf(start.location), { action: 'success' });
  const paidStatus = (await c.get(status)).json();
  assert.deepEqual([paidStatus.paid, paidStatus.status, paidStatus.payment_status, paidStatus.can_pay], [true, 'paid', 'paid', false]);
  assert.equal((await c.get(`/pay/return/${order.public_token}`)).location, `${config.baseUrl}/tma/#/pay/9`);

  // a messenger building a link preview does not start a payment
  const shared = makeOrder().order;
  const preview = await c.get(shared.pay_url, { headers: { 'user-agent': 'TelegramBot (like TwitterBot)' } });
  assert.equal(preview.status, 302);
  assert.equal(preview.location, `${config.baseUrl}/order/${shared.public_token}`);
  assert.equal(orders.getOrder(shared.id).status, 'new');
  assert.equal(paymentsRepo.listByOrder(shared.id).length, 0);

  // unknown tokens
  assert.equal((await c.get('/pay/order/nope')).status, 404);
  assert.equal((await c.get('/pay/return/nope')).status, 404);
  assert.equal((await c.get('/pay/invoice/nope')).status, 404);
  const unknown = await c.get('/pay/status/nope');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json().ok, false);
});

test('startPayment validates the order itself: state, amount, and re-reads it from the database', async () => {
  await assert.rejects(() => startPayment(null), (e) => e.code === 'not_found');
  await assert.rejects(() => startPayment({ id: 987654 }), (e) => e.code === 'not_found');

  const cancelled = makeOrder().order;
  orders.cancel(cancelled.id);
  // a stale copy of the order (still "payable") does not help
  await assert.rejects(() => startPayment(cancelled), (e) => e.code === 'order_closed');
  assert.equal(paymentsRepo.listByOrder(cancelled.id).length, 0);

  const zero = makeOrder().order;
  run('UPDATE orders SET total = 0 WHERE id = ?', zero.id);
  await assert.rejects(() => startPayment(zero), (e) => e.code === 'amount_invalid');
  assert.equal(orders.getOrder(zero.id).status, 'new');

  // a tampered total in the caller's copy is ignored: the attempt carries the stored amount
  const { order } = makeOrder();
  await startPayment({ ...order, total: 1 });
  assert.equal(paymentsRepo.listByOrder(order.id)[0].amount, order.total);

  // a provider that returns nothing useful is an error, not a silent "ok"
  registerProvider({ id: 'broken', title: 'Broken', isConfigured: () => true, createPayment: async () => ({}) });
  await assert.rejects(() => startPayment(makeOrder().order, { providerId: 'broken' }), (e) => e.code === 'payment_unavailable');
  assert.throws(() => registerProvider({ id: 'x' }), /Invalid payment provider/);
});

test('registry: active provider comes from the setting or the env; unconfigured choices fall back to mock outside production', () => {
  const byId = Object.fromEntries(listProviders().map((p) => [p.id, p]));
  assert.deepEqual(Object.keys(byId).filter((id) => id !== 'broken').sort(), ['click', 'mock', 'payme', 'telegram']);
  assert.deepEqual([byId.mock.configured, byId.mock.active], [true, true]);
  assert.equal(byId.payme.configured, true);
  assert.equal(byId.click.configured, true);
  assert.equal(byId.telegram.configured, false, 'no bot token / payment token in this environment');
  assert.equal(activeProviderId(), 'mock');
  assert.equal(resolveProvider().id, 'mock');
  assert.equal(resolveProvider('payme').id, 'payme', 'a configured preferred provider wins');
  assert.equal(resolveProvider('telegram').id, 'mock', 'an unconfigured preferred provider is skipped');
  assert.equal(resolveProvider('nope').id, 'mock');

  settings.set('payment_provider', 'click');
  assert.equal(activeProviderId(), 'click');
  assert.equal(resolveProvider().id, 'click');
  assert.equal(listProviders().find((p) => p.id === 'click').active, true);
  settings.set('payment_provider', 'telegram');
  assert.equal(resolveProvider().id, 'mock', 'development fallback');
  settings.set('payment_provider', '');
  assert.equal(activeProviderId(), config.payments.provider);
  assert.equal(getProvider('mock').isConfigured(), true);
});

test('payment log masks credentials wherever they are', () => {
  const masked = redact({
    authorization: 'Basic abc', sign_string: 'ffff', amount: 100,
    nested: { secret_key: 's', provider_token: 't', password: 'p', list: [{ key: 'k', ok: true }] },
    long: 'x'.repeat(1000),
  });
  assert.equal(masked.authorization, '[redacted]');
  assert.equal(masked.sign_string, '[redacted]');
  assert.equal(masked.amount, 100);
  assert.deepEqual(masked.nested, { secret_key: '[redacted]', provider_token: '[redacted]', password: '[redacted]', list: [{ key: '[redacted]', ok: true }] });
  assert.ok(masked.long.length < 400);

  const seen = [];
  const restore = setLogSink((e) => seen.push(e));
  try {
    paymentLog('unit', { order: 1, token: 'secret-token', sign_string: 'abcdef' });
    assert.equal(seen.length, 1);
    assert.deepEqual([seen[0].scope, seen[0].event, seen[0].order, seen[0].token, seen[0].sign_string], ['payments', 'unit', 1, '[redacted]', '[redacted]']);
    assert.match(seen[0].ts, /^\d{4}-\d\d-\d\dT/);
    // a sink that throws must not break a payment
    setLogSink(() => { throw new Error('disk full'); });
    assert.doesNotThrow(() => paymentLog('unit', { order: 2 }));
  } finally {
    restore();
  }
});

// ─────────────────────────────── production switch

function runProdChild(extraEnv) {
  const tag = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const db = path.join(os.tmpdir(), `samo-payments-prod-${tag}.db`);
  const uploads = path.join(os.tmpdir(), `samo-payments-prod-uploads-${tag}`);
  const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('./payments.child-prod.js', import.meta.url))], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      SKIP_DOTENV: '1',
      DATABASE_PATH: db,
      SESSION_SECRET: 'prod-like-secret-prod-like-secret',
      BASE_URL: 'http://localhost:3999',
      ADMIN_PASSWORD: 'admin12345-prod',
      UPLOAD_DIR: uploads,
      PAYMENT_PROVIDER: 'mock',
      ANALYTICS_ENABLED: '0',
      ...extraEnv,
    },
  });
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${db}${suffix}`, { force: true });
  fs.rmSync(uploads, { recursive: true, force: true });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim().split('\n').pop());
}

test('production: the demo checkout is OFF — no free "payments" — unless ALLOW_MOCK_PAYMENTS=1', () => {
  const off = runProdChild({});
  assert.equal(off.isProd, true);
  assert.equal(off.mock.configured, false);
  assert.equal(off.startError, 'payment_unavailable');
  assert.equal(off.entryStatus, 503, 'the hosted entry reports that online payment is unavailable');
  assert.equal(off.pageStatus, 404, 'the mock page does not exist, even for an attempt stored in the database');
  assert.equal(off.postStatus, 403, 'no page → no CSRF token → the POST is refused');
  assert.equal(off.paid, false);

  const on = runProdChild({ ALLOW_MOCK_PAYMENTS: '1' });
  assert.equal(on.isProd, true);
  assert.equal(on.mock.configured, true);
  assert.equal(on.start.provider, 'mock');
  assert.equal(on.entryStatus, 302);
  assert.match(on.entryLocation, /\/pay\/mock\/mock_[0-9a-f]{24}$/);
  assert.equal(on.pageStatus, 200);
  assert.equal(on.postStatus, 303);
  assert.equal(on.paid, true);
});
