import './helpers/env.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/http.js';
import { get } from '../src/db/index.js';
import * as cart from '../src/services/cart.js';
import * as orders from '../src/services/orders.js';
import * as catalog from '../src/services/catalog.js';
import { startPayment, safeReturnUrl, parseInvoicePayload, invoicePayload, listProviders } from '../src/payments/index.js';
import { makeCatalog, CUSTOMER, DELIVERY } from './helpers/fixtures.js';

let t;
before(async () => {
  t = await startTestApp();
});
after(async () => {
  await t.close();
});

test('app boots: stubs, health, static assets and security headers', async () => {
  const home = await t.client.get('/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  const csp = home.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'self' 'nonce-/);
  assert.equal(home.headers.get('x-powered-by'), null);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');

  assert.deepEqual((await t.client.get('/healthz')).json().ok, true);
  assert.equal((await t.client.get('/admin')).status, 200);
  assert.equal((await t.client.get('/api/tma/ping')).json().ok, true);
  for (const asset of ['/css/tokens.css', '/img/logo.svg', '/img/products/kenya-nyeri.svg', '/vendor/chart.js/chart.umd.min.js', '/vendor/quill/quill.js',
    '/fonts/playfair-display/playfair-display-cyrillic-600-normal.woff2', '/fonts/manrope/manrope-cyrillic-400-normal.woff2']) {
    assert.equal((await t.client.get(asset)).status, 200, asset);
  }

  const tma = await t.client.get('/tma/');
  assert.equal(tma.status, 200);
  const tmaCsp = tma.headers.get('content-security-policy');
  assert.match(tmaCsp, /https:\/\/telegram\.org/);
  assert.match(tmaCsp, /frame-ancestors 'self' https:\/\/web\.telegram\.org/);
  assert.equal(tma.headers.get('x-frame-options'), null);

  const api = await t.newClient().get('/api/tma/ping');
  assert.deepEqual(api.headers.getSetCookie(), [], 'API responses never set cookies');

  const missing = await t.client.get('/no-such-page');
  assert.equal(missing.status, 404);
  assert.equal((await t.client.get('/api/tma/nope')).json().error, 'not_found');
});

test('page views are recorded for site pages only', async () => {
  const c = t.newClient();
  const before = get('SELECT COUNT(*) AS n FROM page_views').n;
  await c.get('/?utm_source=instagram&utm_medium=cpc&utm_campaign=test');
  await c.get('/');
  await c.get('/admin');
  await c.get('/healthz');
  await c.get('/css/tokens.css');
  await c.get('/', { headers: { 'user-agent': 'Googlebot/2.1' } });
  await new Promise((r) => setTimeout(r, 30));
  const rows = get('SELECT COUNT(*) AS n, COUNT(DISTINCT session_id) AS s FROM page_views WHERE id > (SELECT COALESCE(MAX(id), 0) FROM page_views) - ?', 2);
  assert.equal(get('SELECT COUNT(*) AS n FROM page_views').n - before, 2);
  assert.equal(rows.s, 1, 'same session cookie');
  const last = get('SELECT * FROM page_views ORDER BY id DESC LIMIT 1');
  assert.equal(last.source, 'instagram', 'first-touch source is kept for the session');
  assert.equal(last.medium, 'cpc');
  assert.equal(last.utm_campaign, 'test');
});

test('CSRF: unsafe requests need a token; API prefix is exempt', async () => {
  const c = t.newClient();
  const { products } = makeCatalog(1);
  const ref = { token: cart.newToken() };
  cart.addItem(ref, products[0].id, 1);
  const order = orders.createFromCart(ref, { customer: CUSTOMER, delivery: DELIVERY });
  const pay = await c.get(order.pay_url);
  assert.equal(pay.status, 302);
  const page = await c.get(pay.location);
  assert.equal(page.status, 200);
  const path = new URL(pay.location).pathname;

  const noToken = await c.request('POST', path, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'action=success' });
  assert.equal(noToken.status, 403);
  const badToken = await c.request('POST', path, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'action=success&_csrf=abc.def' });
  assert.equal(badToken.status, 403);
  assert.equal(orders.getOrder(order.id).payment_status, 'pending', 'nothing was paid');
  const other = t.newClient();
  await other.get('/');
  const foreign = await other.request('POST', path, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `action=success&_csrf=${encodeURIComponent(c.csrfToken)}` });
  assert.equal(foreign.status, 403, "another visitor's token is rejected");

  const api = await c.request('POST', '/api/tma/nope', { headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(api.status, 404, 'API is not CSRF-protected (it uses initData auth)');
});

test('mock payment: order → hosted checkout → paid → status page (end to end over HTTP)', async () => {
  const c = t.newClient();
  const { products } = makeCatalog(2, { stock: 4 });
  const ref = { token: cart.newToken() };
  cart.addItem(ref, products[0].id, 2);
  cart.addItem(ref, products[1].id, 1);
  const order = orders.createFromCart(ref, { customer: CUSTOMER, delivery: DELIVERY, sessionId: 'e2e-session' });

  const start = await c.get(`/pay/order/${order.public_token}`);
  assert.equal(start.status, 302);
  assert.match(start.location, /\/pay\/mock\/mock_[0-9a-f]{24}$/);
  assert.equal(orders.getOrder(order.id).status, 'pending_payment');

  const checkout = await c.get(start.location);
  assert.equal(checkout.status, 200);
  assert.ok(checkout.text.includes(order.number));
  assert.ok(checkout.text.includes('320 000 сум'), 'total is shown formatted');
  assert.ok(c.csrfToken);

  const paid = await c.postForm(new URL(start.location).pathname, { action: 'success' });
  assert.equal(paid.status, 303);
  assert.equal(new URL(paid.location).pathname, `/order/${order.public_token}`);

  const fresh = orders.getOrder(order.id);
  assert.equal(fresh.status, 'paid');
  assert.equal(fresh.payment_status, 'paid');
  assert.equal(fresh.payment_provider, 'mock');
  assert.equal(catalog.getProduct(products[0].id).stock, 2);
  assert.equal(catalog.getProduct(products[1].id).stock, 3);
  assert.equal(get(`SELECT COUNT(*) AS n FROM events WHERE name = 'purchase' AND order_id = ?`, order.id).n, 1);

  const status = await c.get(paid.location);
  assert.equal(status.status, 200);
  assert.ok(status.text.includes('Оплачен'));

  // replaying the form or reopening the checkout changes nothing
  const replay = await c.postForm(new URL(start.location).pathname, { action: 'success' });
  assert.equal(replay.status, 303);
  assert.equal((await c.get(start.location)).status, 302);
  assert.equal((await c.get(`/pay/order/${order.public_token}`)).status, 302);
  assert.equal(catalog.getProduct(products[0].id).stock, 2);
  await assert.rejects(() => startPayment(orders.getOrder(order.id)), (e) => e.code === 'already_paid');
});

test('mock payment: failure keeps the order payable and a retry succeeds', async () => {
  const c = t.newClient();
  const { products } = makeCatalog(1);
  const ref = { token: cart.newToken() };
  cart.addItem(ref, products[0].id, 1);
  const order = orders.createFromCart(ref, { customer: CUSTOMER, delivery: { method: 'pickup' } });
  const result = await startPayment(order, { returnUrl: '/tma/#/orders/1' });
  assert.equal(result.provider, 'mock');
  const path = new URL(result.redirectUrl).pathname;
  await c.get(path);
  const failed = await c.postForm(path, { action: 'fail' });
  assert.equal(failed.status, 303);
  assert.ok(failed.location.endsWith('/tma/#/orders/1'), 'custom same-site return URL is honoured');
  const after = orders.getOrder(order.id);
  assert.equal(after.payment_status, 'failed');
  assert.equal(after.can_pay, true);
  assert.equal((await c.get(path)).status, 302, 'a failed attempt cannot be reused');

  const retry = await startPayment(after);
  assert.notEqual(retry.redirectUrl, result.redirectUrl);
  const retryPath = new URL(retry.redirectUrl).pathname;
  await c.get(retryPath);
  await c.postForm(retryPath, { action: 'success' });
  assert.equal(orders.getOrder(order.id).payment_status, 'paid');
  assert.equal((await c.get('/pay/mock/mock_000000000000000000000000')).status, 404);
});

test('payments registry helpers', () => {
  const order = { public_token: 'abc' };
  assert.equal(safeReturnUrl('/tma/#/x', order), 'http://localhost:3000/tma/#/x');
  assert.equal(safeReturnUrl('http://localhost:3000/order/zzz', order), 'http://localhost:3000/order/zzz');
  assert.equal(safeReturnUrl('https://evil.example/', order), 'http://localhost:3000/order/abc');
  assert.equal(safeReturnUrl('//evil.example/', order), 'http://localhost:3000/order/abc');
  assert.equal(safeReturnUrl('/\\evil.example', order), 'http://localhost:3000/order/abc');
  assert.equal(safeReturnUrl(undefined, order), 'http://localhost:3000/order/abc');
  assert.equal(invoicePayload(42), 'order:42');
  assert.equal(parseInvoicePayload('order:42'), 42);
  assert.equal(parseInvoicePayload('order:42; DROP'), null);
  assert.ok(listProviders().some((p) => p.id === 'mock' && p.configured && p.active));
});
