import './site-helpers-bot-env.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/http.js';
import * as cart from '../src/services/cart.js';
import * as orders from '../src/services/orders.js';
import * as content from '../src/services/content.js';
import { makeCatalog, CUSTOMER, DELIVERY } from './helpers/fixtures.js';

let t;
before(async () => {
  t = await startTestApp();
});
after(async () => {
  await t.close();
});

test('"Open in Telegram" links appear when BOT_USERNAME is configured', async () => {
  const home = await t.client.get('/');
  assert.match(home.text, /href="https:\/\/t\.me\/samo_demo_bot\?start=site"[^>]*data-testid="open-telegram"/);
  assert.ok(home.text.includes(content.get('global', 'tg_title', 'Samo в Telegram')));
  assert.match((await t.client.get('/contacts')).text, /https:\/\/t\.me\/samo_demo_bot\?start=site/);

  const { products } = makeCatalog(1);
  const ref = { token: cart.newToken() };
  cart.addItem(ref, products[0].id, 1);
  const order = orders.createFromCart(ref, { customer: CUSTOMER, delivery: DELIVERY });
  orders.markPaid(order.id, { provider: 'mock', amount: order.total });
  const page = await t.client.get(order.url);
  assert.ok(page.text.includes(`https://t.me/samo_demo_bot?start=order_${order.number}`), 'deep link to the order in the bot');
});
