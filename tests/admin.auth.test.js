import './helpers/env.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/http.js';
import { get } from '../src/db/index.js';
import * as auth from '../src/services/auth.js';
import * as catalog from '../src/services/catalog.js';
import * as media from '../src/services/media.js';
import { ADMIN, login, upload, PNG } from './admin.helpers.js';

let t;
before(async () => {
  t = await startTestApp();
});
after(async () => {
  await t.close();
});

const GET_ROUTES = [
  '/admin', '/admin/content', '/admin/content/home', '/admin/products', '/admin/products/new', '/admin/products/1',
  '/admin/categories', '/admin/categories/new', '/admin/plans', '/admin/plans/new', '/admin/subscriptions',
  '/admin/posts', '/admin/posts/new', '/admin/faq', '/admin/faq/new', '/admin/orders', '/admin/orders/1', '/admin/orders/export.csv',
  '/admin/customers', '/admin/customers/1', '/admin/customers/export.csv', '/admin/feedback', '/admin/feedback/1',
  '/admin/media', '/admin/media/list.json', '/admin/settings', '/admin/settings?tab=payments', '/admin/broadcasts',
  '/admin/broadcasts/status.json', '/admin/account', '/admin/admins', '/admin/admins/new', '/admin/no-such-page',
];

const POST_ROUTES = [
  ['/admin/logout', {}],
  ['/admin/content/home', { 'blocks[hero_title]': 'HACKED' }],
  ['/admin/products', { title: 'Нелегальный товар', price: '1' }],
  ['/admin/products/1', { title: 'x', price: '1' }],
  ['/admin/products/1/delete', {}],
  ['/admin/categories', { title: 'x' }],
  ['/admin/plans', { title: 'x', price: '1' }],
  ['/admin/posts', { title: 'x' }],
  ['/admin/faq', { question: 'x' }],
  ['/admin/faq/reorder', { 'ids[]': '1' }],
  ['/admin/orders/1/status', { status: 'paid' }],
  ['/admin/orders/1/mark-paid', {}],
  ['/admin/orders/1/refund', {}],
  ['/admin/customers/1', { name: 'x' }],
  ['/admin/feedback/1/reply', { text: 'x' }],
  ['/admin/feedback/1/delete', {}],
  ['/admin/media/1/delete', {}],
  ['/admin/settings/general', { 's[site_name]': 'HACKED' }],
  ['/admin/broadcasts', { text: 'spam', action: 'send' }],
  ['/admin/account/password', { current_password: 'a', new_password: 'bbbbbbbbbb', new_password_confirm: 'bbbbbbbbbb' }],
  ['/admin/admins', { email: 'evil@example.com', password: 'evil-evil-evil', role: 'owner' }],
  ['/admin/admins/1/delete', {}],
];

test('every admin page redirects anonymous visitors to the login form', async () => {
  const c = t.newClient();
  for (const route of GET_ROUTES) {
    const res = await c.get(route);
    assert.equal(res.status, 302, `${route} must redirect`);
    assert.match(res.location, /^\/admin\/login\?next=/, route);
    assert.ok(!/adm-sidebar|Дашборд|Номер;/.test(res.text), `${route} leaks nothing`);
  }
  const json = await c.get('/admin/media/list.json', { headers: { accept: 'application/json' } });
  assert.equal(json.status, 401);
  assert.equal(json.json().error, 'unauthorized');
});

test('every admin action is rejected without a session (even with a valid CSRF token)', async () => {
  const c = t.newClient();
  await c.get('/admin/login'); // obtains a CSRF cookie + token
  assert.ok(c.csrfToken);
  const product = catalog.createProduct({ title: 'Свидетель', price: 1000 });
  const before = {
    products: get('SELECT COUNT(*) AS n FROM products').n,
    admins: get('SELECT COUNT(*) AS n FROM admins').n,
    media: get('SELECT COUNT(*) AS n FROM media').n,
  };
  for (const [route, fields] of POST_ROUTES) {
    const res = await c.postForm(route, fields);
    assert.equal(res.status, 302, `${route} must redirect`);
    assert.equal(res.location, '/admin/login', route);
  }
  const up = await upload(c, [{ name: 'a.png', type: 'image/png', data: PNG }]);
  assert.equal(up.status, 401, 'uploads need a session');
  assert.equal(media.listMedia().total, before.media, 'nothing was stored');
  assert.equal(get('SELECT COUNT(*) AS n FROM products').n, before.products);
  assert.equal(get('SELECT COUNT(*) AS n FROM admins').n, before.admins);
  assert.ok(catalog.getProduct(product.id), 'product still exists');
});

test('login: wrong password, success, session cookie flags, next redirect', async () => {
  const c = t.newClient();
  const page = await c.get('/admin/login');
  assert.equal(page.status, 200);
  assert.match(page.text, /name="password"/);
  assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');

  const empty = await c.postForm('/admin/login', { email: '', password: '' });
  assert.equal(empty.status, 422);

  const wrong = await c.postForm('/admin/login', { email: ADMIN.email, password: 'wrong-password' });
  assert.equal(wrong.status, 401);
  assert.match(wrong.text, /Неверный e-mail или пароль/);
  assert.ok(!c.jar.has('sc_admin'));
  assert.equal((await c.get('/admin')).status, 302);

  const unknown = await c.postForm('/admin/login', { email: 'nobody@example.com', password: ADMIN.password });
  assert.equal(unknown.status, 401);
  assert.match(unknown.text, /Неверный e-mail или пароль/, 'same message for unknown accounts');

  const ok = await c.request('POST', '/admin/login', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: c.csrfToken, ...ADMIN, next: '/admin/orders?status=paid' }).toString(),
  });
  assert.equal(ok.status, 302);
  assert.equal(ok.location, '/admin/orders?status=paid');
  const cookie = ok.headers.getSetCookie().find((line) => line.startsWith('sc_admin='));
  assert.ok(cookie, 'session cookie is set');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /^sc_admin=s%3A/, 'cookie is signed');

  const dash = await c.get('/admin');
  assert.equal(dash.status, 200);
  assert.match(dash.text, /Дашборд/);
  assert.equal(dash.headers.get('cache-control'), 'no-store');
  assert.match(dash.headers.get('content-security-policy'), /script-src 'self' 'nonce-/);
  assert.ok(!/<script(?![^>]*\b(src|type="application\/json"))/.test(dash.text), 'no inline scripts');

  // logged-in admins skip the login form
  const again = await c.get('/admin/login');
  assert.equal(again.status, 302);
  assert.equal(again.location, '/admin');
});

test('login: the next parameter cannot redirect outside the panel', async () => {
  for (const next of ['https://evil.example/admin', '//evil.example', '/admin//evil.example', '/catalog', 'javascript:alert(1)']) {
    const c = t.newClient();
    const res = await login(c, ADMIN, { next });
    assert.equal(res.status, 302);
    assert.equal(res.location, '/admin', next);
  }
});

test('CSRF: admin forms are rejected without a valid token', async () => {
  const c = t.newClient();
  await login(c);
  const product = catalog.createProduct({ title: 'CSRF-мишень', price: 5000 });
  const form = { 'content-type': 'application/x-www-form-urlencoded' };

  const noToken = await c.request('POST', `/admin/products/${product.id}/delete`, { headers: form, body: '' });
  assert.equal(noToken.status, 403);
  const badToken = await c.request('POST', `/admin/products/${product.id}/delete`, { headers: form, body: '_csrf=abc.def' });
  assert.equal(badToken.status, 403);

  // a token issued to another visitor does not work with this admin's cookies
  const attacker = t.newClient();
  await attacker.get('/admin/login');
  const foreign = await c.request('POST', `/admin/products/${product.id}/delete`, { headers: form, body: `_csrf=${encodeURIComponent(attacker.csrfToken)}` });
  assert.equal(foreign.status, 403);
  const noTokenUpload = await upload(c, [{ name: 'a.png', type: 'image/png', data: PNG }], { csrf: '' });
  assert.equal(noTokenUpload.status, 403, 'multipart uploads are CSRF-protected too');
  const logout = await c.request('POST', '/admin/logout', { headers: form, body: '' });
  assert.equal(logout.status, 403);
  assert.ok(catalog.getProduct(product.id), 'nothing was deleted');

  await c.get('/admin/products');
  const good = await c.postForm(`/admin/products/${product.id}/delete`, {});
  assert.equal(good.status, 302);
  assert.equal(catalog.getProduct(product.id), null);
});

test('logout closes the session on the server', async () => {
  const c = t.newClient();
  await login(c);
  const token = decodeURIComponent(c.jar.get('sc_admin'));
  assert.equal((await c.get('/admin')).status, 200);
  const out = await c.postForm('/admin/logout', {});
  assert.equal(out.status, 302);
  assert.equal(out.location, '/admin/login');
  assert.ok(!c.jar.has('sc_admin'), 'cookie cleared');
  assert.equal((await c.get('/admin')).status, 302);
  // replaying the old cookie does not work: the session row is gone
  const replay = await t.newClient().get('/admin', { headers: { cookie: `sc_admin=${encodeURIComponent(token)}` } });
  assert.equal(replay.status, 302);
});

test('login is rate limited per account', async () => {
  const c = t.newClient();
  await c.get('/admin/login');
  auth.createAdmin({ email: 'victim@samo.coffee', password: 'correct-horse-battery', role: 'manager' });
  for (let i = 0; i < 8; i += 1) {
    const res = await c.postForm('/admin/login', { email: 'victim@samo.coffee', password: `guess-${i}` });
    assert.equal(res.status, 401, `attempt ${i + 1}`);
  }
  const blocked = await c.postForm('/admin/login', { email: 'victim@samo.coffee', password: 'correct-horse-battery' });
  assert.equal(blocked.status, 429, 'even the right password is refused while the limit is active');
  assert.match(blocked.text, /Слишком много неудачных попыток/);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.ok(!c.jar.has('sc_admin'));
  // other accounts are not affected
  assert.equal((await login(t.newClient())).status, 302);
});

test('password guessing is limited per account from ANY address; a known browser is not locked out', async () => {
  auth.createAdmin({ email: 'target@samo.coffee', password: 'correct-horse-battery', role: 'manager' });
  // every guess comes from another address, so the IP-keyed limits never trigger
  for (let i = 0; i < 20; i += 1) {
    assert.deepEqual(auth.login('target@samo.coffee', `guess-${i}`, { ip: `203.0.113.${i}` }), { ok: false, reason: 'invalid' }, `attempt ${i + 1}`);
  }
  const blocked = auth.login('Target@Samo.Coffee ', 'correct-horse-battery', { ip: '198.51.100.7' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'rate_limited');
  assert.ok(blocked.retryAfterSec > 0);
  // ...also over HTTP, whatever X-Forwarded-For says (it is not trusted here)
  const c = t.newClient();
  await c.get('/admin/login');
  const viaHttp = await c.postForm('/admin/login', { email: 'target@samo.coffee', password: 'correct-horse-battery' }, { headers: { 'x-forwarded-for': '192.0.2.55' } });
  assert.equal(viaHttp.status, 429);
  // a cookie of another account does not help
  assert.equal(auth.login('target@samo.coffee', 'correct-horse-battery', { ip: '198.51.100.8', knownAccount: 'someone@samo.coffee' }).reason, 'rate_limited');
  // the browser that logged into this account before still gets in (and still needs the password)
  assert.equal(auth.login('target@samo.coffee', 'nope', { ip: '198.51.100.9', knownAccount: 'target@samo.coffee' }).reason, 'invalid');
  assert.equal(auth.login('target@samo.coffee', 'correct-horse-battery', { ip: '198.51.100.9', knownAccount: 'target@samo.coffee' }).ok, true);
  // unknown e-mails are counted the same way (no account enumeration through the limiter)
  for (let i = 0; i < 20; i += 1) auth.login('ghost@samo.coffee', 'x', { ip: `203.0.113.${100 + i}` });
  assert.equal(auth.login('ghost@samo.coffee', 'x', { ip: '198.51.100.10' }).reason, 'rate_limited');

  // a successful login marks the browser as known for that account (signed cookie, panel only)
  const owner = t.newClient();
  const ok = await login(owner);
  assert.equal(ok.status, 302);
  const deviceCookie = (ok.headers.getSetCookie?.() || []).find((line) => line.startsWith(`${auth.DEVICE_COOKIE}=`));
  assert.ok(deviceCookie, 'device cookie is set');
  assert.match(deviceCookie, /HttpOnly/i);
  assert.match(deviceCookie, /Path=\/admin/);
});

test('X-Forwarded-For does not let a client escape the login limits when no proxy is trusted', async () => {
  const c = t.newClient();
  await c.get('/admin/login');
  const statuses = [];
  for (let i = 0; i < 10; i += 1) {
    const res = await c.postForm('/admin/login', { email: 'spoof@samo.coffee', password: `guess-${i}` }, { headers: { 'x-forwarded-for': `10.9.8.${i}` } });
    statuses.push(res.status);
  }
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 401, 401, 401, 429, 429]);
});

test('roles: a manager cannot open settings, broadcasts or admin management', async () => {
  auth.createAdmin({ email: 'manager@samo.coffee', password: 'manager-password', name: 'Менеджер', role: 'manager' });
  const c = t.newClient();
  assert.equal((await login(c, { email: 'manager@samo.coffee', password: 'manager-password' })).status, 302);
  for (const route of ['/admin', '/admin/orders', '/admin/products', '/admin/content', '/admin/feedback', '/admin/account']) {
    assert.equal((await c.get(route)).status, 200, route);
  }
  for (const route of ['/admin/settings', '/admin/broadcasts', '/admin/admins', '/admin/admins/new']) {
    const res = await c.get(route);
    assert.equal(res.status, 403, route);
    assert.match(res.text, /Недостаточно прав/);
  }
  const dash = await c.get('/admin');
  assert.ok(!dash.text.includes('href="/admin/settings"'), 'forbidden sections are hidden from the sidebar');
  const admins = get('SELECT COUNT(*) AS n FROM admins').n;
  const create = await c.postForm('/admin/admins', { email: 'x@example.com', password: 'xxxxxxxxxxxx', role: 'owner' });
  assert.equal(create.status, 403);
  const settingsPost = await c.postForm('/admin/settings/general', { 's[site_name]': 'Взлом' });
  assert.equal(settingsPost.status, 403);
  assert.equal(get('SELECT COUNT(*) AS n FROM admins').n, admins);

  // deactivating the account kills its sessions immediately
  auth.updateAdmin(get('SELECT id FROM admins WHERE email = ?', 'manager@samo.coffee').id, { active: 0 });
  assert.equal((await c.get('/admin/orders')).status, 302);
});

test('unknown admin URLs render the panel 404 page for logged-in admins', async () => {
  const c = t.newClient();
  await login(c);
  const res = await c.get('/admin/no-such-page');
  assert.equal(res.status, 404);
  assert.match(res.text, /Страница не найдена/);
  assert.match(res.text, /adm-sidebar/, 'rendered inside the panel layout');
  assert.equal((await c.get('/admin/products/999999')).status, 404);
  assert.equal((await c.get('/admin/orders/abc')).status, 404);
});
