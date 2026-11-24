import './helpers/env.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/http.js';
import { seed } from '../src/db/seed.js';
import * as analytics from '../src/services/analytics.js';
import * as orders from '../src/services/orders.js';
import * as feedback from '../src/services/feedback.js';
import { formatNumber } from '../src/lib/money.js';
import { login } from './admin.helpers.js';

let t;
let c;
before(async () => {
  t = await startTestApp();
  c = t.client;
  await login(c);
});
after(async () => {
  await t.close();
});

test('dashboard renders with an empty database (empty states, no division by zero)', async () => {
  const res = await c.get('/admin');
  assert.equal(res.status, 200);
  assert.match(res.text, /Посещений пока нет/);
  assert.match(res.text, /Заказов за период нет/);
  assert.match(res.text, /Заказов пока нет/);
  assert.match(res.text, /Все обращения разобраны/);
  assert.ok(!/NaN|undefined|Infinity/.test(res.text.replace(/<script[\s\S]*?<\/script>/g, '')), 'no broken numbers');
});

test('dashboard shows the analytics of the selected period', async () => {
  seed({ quiet: true });
  const range = analytics.resolveRange({ range: '30d' });
  const summary = analytics.summary(range);
  assert.ok(summary.revenue > 0 && summary.visitors > 0, 'seed produced analytics');

  const res = await c.get('/admin?range=30d');
  assert.equal(res.status, 200);
  const text = res.text.replace(/&nbsp;| /g, ' ');
  assert.ok(text.includes(formatNumber(summary.revenue).replace(/ /g, ' ')), 'revenue KPI');
  assert.ok(text.includes(formatNumber(summary.visitors).replace(/ /g, ' ')), 'visitors KPI');
  for (const title of ['Посещаемость', 'Продажи', 'Воронка сайта', 'Воронка мини-приложения', 'Каналы продаж', 'Устройства', 'Источники трафика',
    'Популярные страницы', 'Лидеры продаж', 'Telegram: бот и мини-приложение', 'Последние заказы', 'Ждут ответа']) {
    assert.ok(res.text.includes(title), title);
  }
  // chart data travels in a JSON block (CSP: no inline scripts)
  const m = /<script type="application\/json" id="dashboard-data">([\s\S]*?)<\/script>/.exec(res.text);
  assert.ok(m);
  const data = JSON.parse(m[1]);
  assert.equal(data.labels.length, 30);
  assert.equal(data.revenue.reduce((a, b) => a + b, 0), summary.revenue);
  assert.equal(data.visitors.length, 30);
  assert.match(res.text, /src="\/vendor\/chart\.js\/chart\.umd\.min\.js/);
  assert.equal((await c.get('/admin/js/dashboard.js')).status, 200);

  const top = analytics.topProducts(range, 1)[0];
  assert.ok(res.text.includes(top.title));
  const recent = orders.listOrders({ limit: 1 }).items[0];
  assert.ok(res.text.includes(recent.number));
  const open = feedback.listThreads({ status: 'open', limit: 1 }).items[0];
  assert.ok(res.text.includes(open.name));
});

test('dashboard: presets, custom ranges and garbage input', async () => {
  for (const preset of ['today', '7d', '90d']) {
    const res = await c.get(`/admin?range=${preset}`);
    assert.equal(res.status, 200, preset);
    assert.match(res.text, new RegExp(`href="/admin\\?range=${preset}" aria-current="true"`));
  }
  const weekly = await c.get('/admin?range=90d');
  const data = JSON.parse(/id="dashboard-data">([\s\S]*?)<\/script>/.exec(weekly.text)[1]);
  assert.equal(data.weekly, true, 'long ranges are grouped by week');
  assert.equal(data.labels.length, 13);

  const to = analytics.localDate();
  const from = analytics.localDate(Date.now() - 9 * 86400000);
  const custom = await c.get(`/admin?from=${from}&to=${to}`);
  assert.equal(custom.status, 200);
  assert.ok(custom.text.includes(`name="from" value="${from}"`));
  assert.equal(JSON.parse(/id="dashboard-data">([\s\S]*?)<\/script>/.exec(custom.text)[1]).labels.length, 10);
  assert.ok(!/href="\/admin\?range=\w+" aria-current="true"/.test(custom.text), 'no preset is highlighted for a custom range');

  for (const query of ['from=2026-99-99&to=x', 'range=<script>', 'from[]=1&to[]=2', 'from=2031-01-01&to=2020-01-01']) {
    assert.equal((await c.get(`/admin?${query}`)).status, 200, query);
  }
});

test('every section renders with the seeded demo data', async () => {
  const order = orders.listOrders({ limit: 1 }).items[0];
  const thread = feedback.listThreads({ limit: 1 }).items[0];
  const pages = [
    '/admin/content', '/admin/content/global', '/admin/content/home', '/admin/content/tma', '/admin/products', '/admin/products?page=2',
    '/admin/products/1', '/admin/categories', '/admin/categories/1', '/admin/plans', '/admin/plans/1', '/admin/subscriptions',
    '/admin/subscriptions?page=2', '/admin/posts', '/admin/posts/1', '/admin/faq', '/admin/faq/1', '/admin/orders', '/admin/orders?page=3',
    `/admin/orders/${order.id}`, '/admin/customers', '/admin/customers?page=2', `/admin/customers/${order.customer_id}`, '/admin/feedback',
    `/admin/feedback/${thread.id}`, '/admin/media', '/admin/settings', '/admin/settings?tab=payments', '/admin/settings?tab=bot',
    '/admin/broadcasts', '/admin/account', '/admin/admins', '/admin/admins/1',
  ];
  for (const url of pages) {
    const res = await c.get(url);
    assert.equal(res.status, 200, url);
    assert.match(res.text, /<\/html>\s*$/, `${url} rendered completely`);
    assert.ok(!/\bNaN\b|>undefined<|\[object Object\]/.test(res.text), `${url} has no broken output`);
  }
  const csv = await c.get('/admin/orders/export.csv');
  assert.equal(csv.text.split('\r\n').filter(Boolean).length, orders.countByStatus().all + 1, 'export pages through all orders');
});
