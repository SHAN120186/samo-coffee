// Cross-module behaviour checked after integration:
//   * a failed CSRF check on a site form ends on the branded site page (the error is raised before the site router);
//   * redirects are not page views;
//   * `npm run seed` leaves Admin → Контент complete (foundation + site blocks) without a restart;
//   * seedIfEmpty() (SEED_ON_EMPTY=1) fills an empty database once and never touches existing data;
//   * what the admin creates is what the site, the Mini App API and the bot's invoice see.
import './integration.env.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/http.js';
import { get, run } from '../src/db/index.js';
import * as content from '../src/services/content.js';
import * as catalog from '../src/services/catalog.js';
import * as cart from '../src/services/cart.js';
import * as orders from '../src/services/orders.js';
import { seed, seedIfEmpty, isEmptyDatabase } from '../src/db/seed.js';
import { SITE_BLOCKS } from '../src/site/blocks.js';
import { buildInvoiceParams } from '../src/payments/index.js';
import { CUSTOMER, DELIVERY } from './helpers/fixtures.js';

const count = (table) => get(`SELECT COUNT(*) AS n FROM ${table}`).n;
let t;

before(async () => {
  // the very first thing on a fresh database: SEED_ON_EMPTY
  assert.equal(isEmptyDatabase(), true, 'a new database is empty');
  const summary = seedIfEmpty();
  assert.ok(summary && summary.products >= 12 && summary.orders > 100, 'demo data loaded into the empty database');
  t = await startTestApp();
});
after(async () => {
  await t.close();
});

test('SEED_ON_EMPTY: a database with data is never touched again', () => {
  assert.equal(isEmptyDatabase(), false);
  catalog.updateProduct(1, { title: 'Переименовано владельцем' });
  content.setBlock('home', 'hero_title', 'Заголовок владельца');
  const before = { products: count('products'), orders: count('orders'), customers: count('customers'), views: count('page_views'), blocks: count('content_blocks') };

  assert.equal(seedIfEmpty(), null, 'second boot: nothing to do');
  assert.deepEqual({ products: count('products'), orders: count('orders'), customers: count('customers'), views: count('page_views'), blocks: count('content_blocks') }, before);
  assert.equal(catalog.getProduct(1).title, 'Переименовано владельцем');
  assert.equal(content.getPage('home').hero_title, 'Заголовок владельца');

  // even a shop that has only orders (catalog deleted) is not "empty"
  run('UPDATE products SET active = 0');
  assert.equal(isEmptyDatabase(), false);
  run('UPDATE products SET active = 1');
});

test('seedIfEmpty keeps settings and content that already exist in an otherwise empty database', () => {
  // simulate: the owner booted once without demo data, edited a block, then enabled SEED_ON_EMPTY
  for (const table of ['events', 'page_views', 'broadcasts', 'feedback_messages', 'feedback_threads', 'payments', 'order_events',
    'order_items', 'subscriptions', 'orders', 'cart_items', 'carts', 'customers', 'tg_users', 'faq', 'posts', 'plans', 'products', 'categories']) {
    run(`DELETE FROM ${table}`);
  }
  content.setBlock('home', 'hero_title', 'Свой заголовок до демо-данных');
  assert.equal(isEmptyDatabase(), true);
  const summary = seedIfEmpty();
  assert.ok(summary.products >= 12);
  assert.equal(content.getPage('home').hero_title, 'Свой заголовок до демо-данных', 'existing content survives');
  assert.ok(count('orders') > 100 && count('page_views') > 1000);
});

test('npm run seed: the content editor is complete right away (foundation + site blocks)', () => {
  seed({ quiet: true });
  const keys = new Set(content.listPages().flatMap((p) => content.listBlocks(p.page).map((b) => `${b.page}.${b.key}`)));
  for (const b of [...content.DEFAULT_BLOCKS, ...SITE_BLOCKS]) assert.ok(keys.has(`${b.page}.${b.key}`), `${b.page}.${b.key} is in the database after seeding`);
  assert.equal(keys.size, content.DEFAULT_BLOCKS.length + SITE_BLOCKS.length);
});

test('a failed CSRF check on a site form shows the branded page, not the bare fallback', async () => {
  const c = t.newClient();
  await c.get('/contacts');
  const threadsBefore = count('feedback_threads');
  const res = await c.request('POST', '/contacts', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: 'forged', name: 'Мария', contact: 'm@example.com', message: 'Здравствуйте, это проверка формы' }).toString(),
  });
  assert.equal(res.status, 403);
  assert.match(res.text, /Сессия формы устарела/);
  assert.match(res.text, /class="site-header|<header/i, 'rendered inside the site layout');
  assert.match(res.text, /href="\/catalog"/, 'navigation is present');
  assert.match(res.text, /\/site\/css\/site\.css/);
  assert.equal(count('feedback_threads'), threadsBefore, 'nothing was stored');

  // JSON clients and other modules keep their own formats
  const json = await c.request('POST', '/cart/add', { headers: { 'content-type': 'application/json', accept: 'application/json' }, body: '{}' });
  assert.equal(json.status, 403);
  assert.equal(json.json().error, 'EBADCSRFTOKEN');
});

test('redirects are not counted as page views', async () => {
  const c = t.newClient();
  const before = count('page_views');
  assert.equal((await c.get('/checkout')).status, 302, 'empty cart → back to the cart');
  assert.equal((await c.get('/catalog/')).status, 301, 'trailing slash → canonical URL');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(count('page_views'), before, 'no views for redirects');
  assert.equal((await c.get('/catalog')).status, 200);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(count('page_views'), before + 1, 'the page that was shown is counted once');
});

test('one catalog for every channel: an admin-side product reaches the site, the Mini App API and the invoice', async () => {
  const category = catalog.listCategories()[0];
  const product = catalog.createProduct({
    title: 'Гватемала Антигуа', price: 155000, stock: 5, category_id: category.id, images: ['/uploads/guatemala.png'], subtitle: 'какао, апельсин', active: 1,
  });
  const c = t.newClient();
  const site = await c.get(`/catalog?q=${encodeURIComponent('Гватемала')}`);
  assert.match(site.text, /Гватемала Антигуа/);
  assert.match(site.text, /\/uploads\/guatemala\.png/);

  const api = (await c.get(`/api/tma/products?search=${encodeURIComponent('Гватемала')}`)).json();
  const item = api.items.find((p) => p.id === product.id);
  assert.ok(item, 'listed by the Mini App API');
  assert.equal(item.price, 155000);
  assert.equal(item.image, '/uploads/guatemala.png');

  // the same order total, in tiyin, is what Telegram is asked to charge (bot sendInvoice and Mini App invoice link)
  const ref = { token: cart.newToken() };
  cart.addItem(ref, product.id, 2);
  const order = orders.createFromCart(ref, { customer: CUSTOMER, delivery: DELIVERY, channel: 'bot' });
  const invoice = buildInvoiceParams(order);
  assert.equal(invoice.payload, `order:${order.id}`);
  assert.equal(invoice.currency, 'UZS');
  assert.equal(invoice.prices.reduce((s, p) => s + p.amount, 0), order.total * 100);

  // hidden products disappear everywhere
  catalog.updateProduct(product.id, { active: 0 });
  assert.doesNotMatch((await c.get(`/catalog?q=${encodeURIComponent('Гватемала')}`)).text, /Гватемала Антигуа/);
  assert.equal((await c.get(`/api/tma/products?search=${encodeURIComponent('Гватемала')}`)).json().items.length, 0);
});

test('an unexpected failure shows the branded 500 page and never leaks internals', async (ctx) => {
  const { db } = await import('../src/db/index.js');
  const logged = [];
  ctx.mock.method(console, 'error', (...args) => { logged.push(args.map(String).join(' ')); });
  db.exec('ALTER TABLE plans RENAME TO plans_broken');
  try {
    const c = t.newClient();
    const page = await c.get('/subscriptions');
    assert.equal(page.status, 500);
    assert.match(page.text, /\/site\/css\/site\.css/, 'site layout');
    assert.match(page.text, /href="\/catalog"/);
    assert.doesNotMatch(page.text, /sqlite|no such table|plans_broken|at file:/i, 'no internals in the page');

    for (const path of ['/subscriptions', '/api/tma/plans']) {
      const res = await c.get(path, { headers: { accept: 'application/json' } });
      assert.equal(res.status, 500, path);
      const body = res.json();
      assert.equal(body.ok, false);
      assert.equal(body.error, 'internal', `${path}: generic code instead of the database error name`);
      assert.doesNotMatch(res.text, /sqlite|no such table/i);
    }
    assert.ok(logged.some((line) => /no such table/i.test(line)), 'the real error is in the server log');
  } finally {
    db.exec('ALTER TABLE plans_broken RENAME TO plans');
  }
  assert.equal((await t.newClient().get('/subscriptions')).status, 200, 'back to normal');
});
