// Mini App API authentication: Telegram initData (HMAC + freshness) and the dev-preview bypass.
import { BOT_TOKEN } from './helpers/env-telegram.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startTestApp } from './helpers/http.js';
import * as tgUsers from '../src/services/tgUsers.js';
import * as customers from '../src/services/customers.js';
import { DEV_TMA_USER } from '../src/lib/initData.js';
import { tmaClient, tgUser, initDataFor } from './tma.helpers.js';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

let t;
before(async () => {
  t = await startTestApp();
});
after(async () => {
  await t.close();
});

test('valid initData is accepted; the Telegram user and a linked customer are registered', async () => {
  const user = tgUser({ first_name: 'Азиз', last_name: 'Каримов', username: 'aziz_k' });
  const api = tmaClient(t.baseUrl, user, { initData: initDataFor(user, { start_param: 'promo_autumn' }) });
  const res = await api.get('/bootstrap');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.dev, false);
  assert.deepEqual(res.body.user, { id: user.id, first_name: 'Азиз', last_name: 'Каримов', username: 'aziz_k', name: 'Азиз Каримов' });
  assert.equal(res.body.profile.name, 'Азиз Каримов', 'checkout is prefilled from the Telegram profile');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('set-cookie'), null, 'the API never sets cookies');

  const stored = tgUsers.getTgUser(user.id);
  assert.equal(stored.source, 'tma');
  assert.equal(stored.start_param, 'promo_autumn');
  const customer = customers.getCustomerByTgUserId(user.id);
  assert.equal(customer.name, 'Азиз Каримов');
  assert.equal(customer.source, 'tma');
});

test('the X-Telegram-Init-Data header is accepted as a fallback', async () => {
  const user = tgUser();
  const res = await fetch(`${t.baseUrl}/api/tma/bootstrap`, { headers: { 'x-telegram-init-data': initDataFor(user) } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).user.id, user.id);
});

test('requests without initData are rejected with a consistent JSON error', async () => {
  const api = tmaClient(t.baseUrl, null);
  const endpoints = [
    ['get', '/bootstrap'], ['post', '/events'], ['get', '/categories'], ['get', '/products'], ['get', '/products/1'],
    ['get', '/cart'], ['post', '/cart/items'], ['put', '/cart/items/1'], ['del', '/cart/items/1'], ['del', '/cart'],
    ['post', '/checkout'], ['get', '/plans'], ['post', '/subscribe'], ['get', '/subscription'], ['post', '/subscription/cancel'],
    ['get', '/orders'], ['get', '/orders/1'], ['post', '/orders/1/pay'], ['post', '/orders/1/cancel'], ['post', '/orders/1/repeat'],
    ['get', '/feedback'], ['post', '/feedback'],
  ];
  for (const [method, path] of endpoints) {
    const res = await api[method](path);
    assert.equal(res.status, 401, `${method.toUpperCase()} ${path}`);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, 'unauthorized');
    assert.equal(typeof res.body.message, 'string');
    assert.equal(res.body.details.reason, 'empty');
  }
  const ping = await api.get('/ping');
  assert.equal(ping.status, 200);
  assert.equal(ping.body.user, null);
  assert.equal(ping.body.dev, false);
});

test('a tampered payload or a signature made with another bot token is rejected', async () => {
  const user = tgUser();
  const good = initDataFor(user);

  const params = new URLSearchParams(good);
  params.set('user', JSON.stringify({ ...user, id: user.id + 1 }));
  const tampered = await tmaClient(t.baseUrl, user, { initData: params.toString() }).get('/bootstrap');
  assert.equal(tampered.status, 401);
  assert.equal(tampered.body.details.reason, 'bad_hash');

  const foreign = await tmaClient(t.baseUrl, user, { initData: initDataFor(user, {}, '999999:ANOTHER-BOT-TOKEN') }).get('/bootstrap');
  assert.equal(foreign.status, 401);
  assert.equal(foreign.body.details.reason, 'bad_hash');

  const noHash = new URLSearchParams(good);
  noHash.delete('hash');
  const unsigned = await tmaClient(t.baseUrl, user, { initData: noHash.toString() }).get('/bootstrap');
  assert.equal(unsigned.status, 401);
  assert.equal(unsigned.body.details.reason, 'no_hash');

  assert.equal(tgUsers.getTgUser(user.id + 1), null, 'nothing is stored for a forged user');
});

test('expired initData (auth_date older than TMA_INITDATA_MAX_AGE) is rejected', async () => {
  const user = tgUser();
  const now = Math.floor(Date.now() / 1000);

  const old = await tmaClient(t.baseUrl, user, { initData: initDataFor(user, { auth_date: now - 86400 - 60 }) }).get('/bootstrap');
  assert.equal(old.status, 401);
  assert.equal(old.body.details.reason, 'expired');
  assert.match(old.body.message, /устарела/);

  const future = await tmaClient(t.baseUrl, user, { initData: initDataFor(user, { auth_date: now + 3600 }) }).get('/bootstrap');
  assert.equal(future.status, 401);
  assert.equal(future.body.details.reason, 'expired');

  const fresh = await tmaClient(t.baseUrl, user, { initData: initDataFor(user, { auth_date: now - 3600 }) }).get('/bootstrap');
  assert.equal(fresh.status, 200, 'an hour-old session is still fine');
});

test('correctly signed initData without a user is rejected', async () => {
  const res = await tmaClient(t.baseUrl, null, { initData: initDataFor(undefined, { query_id: 'AAE' }) }).get('/bootstrap');
  assert.equal(res.status, 401);
  assert.equal(res.body.details.reason, 'no_user');
});

test('cookies are never trusted: an admin-looking cookie does not authenticate the API', async () => {
  const res = await fetch(`${t.baseUrl}/api/tma/orders`, { headers: { cookie: 'sc_admin=whatever; sc_cart=whatever' } });
  assert.equal(res.status, 401);
});

test('unknown routes answer with a JSON 404, with or without a session', async () => {
  for (const api of [tmaClient(t.baseUrl, tgUser()), tmaClient(t.baseUrl, null)]) {
    const res = await api.get('/does-not-exist');
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { ok: false, error: 'not_found', message: 'Метод не найден' });
    assert.equal((await api.post('/orders', {})).status, 404, 'a known path with the wrong method is not a route');
  }
});

// ─────────────────────────────── dev-preview bypass (separate processes: config is read once)

async function bootChild(env) {
  const { stdout } = await run(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(here, 'tma.child-app.js')], {
    env: {
      PATH: process.env.PATH,
      SKIP_DOTENV: '1',
      DATABASE_PATH: ':memory:',
      SESSION_SECRET: 'child-secret-child-secret-child-secret',
      UPLOAD_DIR: path.join(os.tmpdir(), `samo-tma-child-${process.pid}`),
      ADMIN_PASSWORD: 'child-admin-password',
      BASE_URL: 'http://localhost:3999',
      ...env,
    },
    timeout: 30000,
  });
  return JSON.parse(stdout.trim().split('\n').pop());
}

test('dev preview: TMA_DEV_AUTH=1 authenticates the demo user outside production', async () => {
  const out = await bootChild({ NODE_ENV: 'development', TMA_DEV_AUTH: '1' });
  assert.equal(out.bootstrapStatus, 200);
  assert.equal(out.bootstrapBody.dev, true);
  assert.equal(out.bootstrapBody.user.id, DEV_TMA_USER.id);
  assert.equal(out.ping.dev, true);
});

test('dev preview is off by default (no TMA_DEV_AUTH)', async () => {
  const out = await bootChild({ NODE_ENV: 'development' });
  assert.equal(out.bootstrapStatus, 401);
  assert.equal(out.cartStatus, 401);
  assert.equal(out.ping.dev, false);
});

test('dev bypass is ignored in production even when TMA_DEV_AUTH=1', async () => {
  const out = await bootChild({ NODE_ENV: 'production', TMA_DEV_AUTH: '1' });
  assert.equal(out.bootstrapStatus, 401);
  assert.equal(out.bootstrapBody.error, 'unauthorized');
  assert.equal(out.cartStatus, 401, 'mutating endpoints stay closed too');
  assert.equal(out.ping.dev, false);
  assert.equal(out.ping.user, null);
});

test('with the bypass off a correctly signed session still works', async () => {
  const user = tgUser();
  assert.equal((await tmaClient(t.baseUrl, user).get('/cart')).status, 200);
  assert.ok(BOT_TOKEN);
});
