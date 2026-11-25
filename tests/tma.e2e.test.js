// Browser E2E of the Mini App front end with a stubbed Telegram bridge (tests/tma.telegram-stub.js):
// launch → product → MainButton → cart → checkout → WebApp.openInvoice → paid → order.
// Needs Playwright + Chromium; when they are not installed the test is skipped (they are a dev tool,
// not a dependency of the product).
import { E2E_PORT } from './tma.env-e2e.js';
import { FAKE_TG_PORT, BOT_TOKEN } from './tma.env-invoice.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createApp } from '../src/app.js';
import { startFakeTelegram } from './helpers/fakeTelegram.js';
import { makeCatalog } from './helpers/fixtures.js';
import { signInitData } from '../src/lib/initData.js';
import * as orders from '../src/services/orders.js';
import * as notify from '../src/services/notify.js';
import * as telegramPayments from '../src/services/telegramPayments.js';

const BASE = `http://127.0.0.1:${E2E_PORT}`;
const stub = fs.readFileSync(new URL('./tma.telegram-stub.js', import.meta.url), 'utf8');
const LIGHT = { bg_color: '#ffffff', secondary_bg_color: '#efeff4', text_color: '#000000', hint_color: '#8e8e93', link_color: '#007aff', button_color: '#007aff', button_text_color: '#ffffff', section_bg_color: '#ffffff' };
const DARK = { bg_color: '#17212b', secondary_bg_color: '#232e3c', text_color: '#f5f5f5', hint_color: '#708499', link_color: '#6ab3f3', button_color: '#5288c1', button_text_color: '#ffffff', section_bg_color: '#17212b' };

let chromium = null;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch { /* Playwright is not installed → skip */ }

let server;
let fake;
let browser = null;
let products;

before(async () => {
  if (!chromium) return;
  try {
    browser = await chromium.launch();
  } catch {
    browser = null; // no browser binary on this machine → skip
    return;
  }
  fake = await startFakeTelegram(FAKE_TG_PORT);
  const app = await createApp({ bot: false });
  server = await new Promise((resolve) => {
    const s = app.listen(E2E_PORT, '127.0.0.1', () => resolve(s));
  });
  ({ products } = makeCatalog(3, { stock: 9 }));
});

after(async () => {
  if (browser) await browser.close();
  await notify.flush();
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  if (fake) await fake.close();
});

/** Open the Mini App like Telegram does: bridge script + launch params in the URL hash. */
async function launch({ user, initData, version = '8.0', startParam = '' }) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const cfg = { initData, user, startParam, version, scheme: 'light', themeParams: LIGHT };
  await page.route('https://telegram.org/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: `window.__TG_CFG__ = ${JSON.stringify(cfg)};\n${stub}` }));
  await page.goto(`${BASE}/tma/#tgWebAppData=${encodeURIComponent(initData)}&tgWebAppVersion=${version}`, { waitUntil: 'networkidle' });
  const bridge = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__tg.state)));
  const clickMain = () => page.evaluate(() => window.__tg.clickMain());
  return { page, errors, bridge, clickMain, context };
}

const skipReason = () => (browser ? false : 'Playwright/Chromium is not available');

test('Mini App in Telegram: catalog → product → cart → checkout → invoice → paid order', async (t) => {
  if (skipReason()) return t.skip(skipReason());
  const user = { id: 990000000 + (process.pid % 100000), first_name: 'Камила', last_name: 'Юсупова', username: 'kamila_e2e' };
  const { page, errors, bridge, clickMain, context } = await launch({ user, initData: signInitData({ user }, BOT_TOKEN) });

  // launch: bridge initialised, Telegram theme mapped, launch hash replaced by the home route
  assert.equal(await page.evaluate(() => window.__tg.calls('ready').length), 1);
  assert.equal(await page.evaluate(() => window.__tg.calls('expand').length), 1);
  assert.equal(await page.evaluate(() => location.hash), '#/');
  assert.deepEqual(await page.evaluate(() => [document.documentElement.dataset.tg, document.documentElement.dataset.scheme]), ['1', 'light']);
  assert.equal(await page.locator('.brand__sub').textContent(), 'Привет, Камила!');
  assert.equal(await page.locator('.demo-pill').count(), 0);
  assert.equal(await page.locator('.grid2 .pcard').count(), 3);
  assert.equal(await page.locator('#mainbar').isHidden(), true, 'the in-page main button is a browser-only fallback');

  // product: native MainButton with the brand colour, BackButton, quantity stepper
  await page.click(`.pcard__title[href="#/product/${products[0].id}"]`);
  await page.waitForSelector('.screen--product');
  let state = await bridge();
  assert.equal(state.back, true);
  assert.equal(state.main.visible, true);
  assert.equal(state.main.color, '#b84a24');
  assert.match(state.main.text, /^В корзину · 100\s000\sсум$/);
  await page.click('[data-stepper="qty"] [data-step="1"]');
  assert.match((await bridge()).main.text, /200\s000/);
  await clickMain();
  await page.waitForFunction(() => window.__tg.state.main.text === 'Перейти в корзину');
  assert.equal(await page.locator('#cart-badge').textContent(), '2');
  assert.ok((await bridge()).haptics.includes('notify:success'));

  // cart → checkout
  await clickMain();
  await page.waitForSelector('#lines');
  assert.match((await bridge()).main.text, /^Оформить заказ · /);
  assert.equal((await bridge()).back, false, 'tab roots have no BackButton');
  await clickMain();
  await page.waitForSelector('#checkout');
  assert.equal((await bridge()).closing, true, 'closing confirmation while the form is open');
  assert.equal(await page.inputValue('[name="name"]'), 'Камила Юсупова');
  await page.click('[data-share-phone]');
  await page.waitForFunction(() => document.querySelector('[name="phone"]').value === '+998935557788');
  await clickMain(); // the address is missing → the server-side message is shown at the field
  await page.waitForSelector('[data-field="address"].field--invalid');
  assert.equal(await page.locator('[data-field="address"] .field__error').textContent(), 'Укажите адрес доставки');
  await page.fill('[name="address"]', 'Ташкент, ул. Нукус, 8');

  // payment: invoice is opened with the link from the API; "cancelled" keeps the order payable
  await clickMain();
  await page.waitForFunction(() => window.__tg.state.invoice !== null);
  state = await bridge();
  assert.equal(state.invoice.url, 'https://t.me/$fake_invoice_link');
  assert.equal(state.closing, false);
  const orderId = Number(/#\/pay\/(\d+)/.exec(await page.evaluate(() => location.hash))[1]);
  const order = orders.getOrder(orderId);
  assert.equal(order.channel, 'tma');
  assert.equal(order.tg_user_id, user.id);
  assert.equal(order.customer_phone, '+998935557788');
  await page.evaluate(() => window.__tg.resolveInvoice('cancelled'));
  await page.waitForFunction(() => document.querySelector('.state__title')?.textContent === 'Заказ ждёт оплаты');

  // second attempt: Telegram reports "paid", the bot confirms it on the server, polling picks it up
  await clickMain();
  await page.waitForFunction(() => window.__tg.state.invoice !== null);
  await page.evaluate(() => window.__tg.resolveInvoice('paid'));
  await page.waitForFunction(() => document.querySelector('.state__title')?.textContent === 'Подтверждаем оплату');
  const result = telegramPayments.handleSuccessfulPayment({ invoice_payload: `order:${orderId}`, currency: 'UZS', total_amount: order.total * 100, telegram_payment_charge_id: 'e2e-charge' });
  assert.equal(result.ok, true);
  await page.waitForSelector('.state__art--success', { timeout: 15000 });
  assert.equal((await bridge()).main.text, 'Открыть заказ');

  // order screen, then BackButton leads to the list — never back into the finished checkout
  await clickMain();
  await page.waitForSelector('.ostatus');
  assert.equal(await page.locator('.ostatus__title').textContent(), 'Заказ оплачен');
  await page.evaluate(() => window.__tg.clickBack());
  await page.waitForSelector('.ocard');
  assert.equal(await page.evaluate(() => location.hash), '#/orders');
  assert.equal(await page.locator('#cart-badge').isHidden(), true, 'the cart is empty after the order');

  // theme change at runtime
  await page.evaluate((dark) => window.__tg.setTheme(dark, 'dark'), DARK);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.scheme), 'dark');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--tg-theme-bg-color').trim()), '#17212b');

  assert.deepEqual(errors, [], 'no uncaught errors in the page');
  await context.close();
});

test('Mini App with a forged session shows the "open in Telegram" gate', async (t) => {
  if (skipReason()) return t.skip(skipReason());
  const user = { id: 990500001, first_name: 'Мошенник' };
  const { page, errors, context } = await launch({ user, initData: signInitData({ user }, '111:FORGED-TOKEN') });
  await page.waitForSelector('.state__title');
  assert.equal(await page.locator('.state__title').textContent(), 'Откройте в Telegram');
  assert.equal(await page.locator('#tabbar').isHidden(), true);
  assert.equal(await page.locator('.pcard').count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('Mini App on an old Telegram client (Bot API 6.0): hosted payment page + in-page back bar', async (t) => {
  if (skipReason()) return t.skip(skipReason());
  const user = { id: 990700000 + (process.pid % 100000), first_name: 'Тимур' };
  const { page, errors, bridge, clickMain, context } = await launch({ user, initData: signInitData({ user }, BOT_TOKEN), version: '6.0' });
  await page.click(`.pcard__title[href="#/product/${products[1].id}"]`);
  await page.waitForSelector('.screen--product');
  assert.equal(await page.locator('#topbar').isVisible(), true, 'no native BackButton before 6.1');
  await clickMain();
  await page.waitForFunction(() => window.__tg.state.main.text === 'Перейти в корзину');
  await page.evaluate(() => { location.hash = '#/checkout'; });
  await page.waitForSelector('#checkout');
  assert.equal(await page.locator('[data-share-phone]').count(), 0, 'requestContact needs 6.9');
  await page.fill('[name="phone"]', '+998 90 111 22 33');
  await page.click('[data-method="pickup"]');
  assert.match((await bridge()).main.text, /^Оплатить · 120\s000\sсум$/, 'pickup has no delivery fee');
  await clickMain();
  await page.waitForFunction(() => window.__tg.state.links.length === 1);
  const hosted = (await bridge()).links[0];
  assert.ok(hosted.startsWith(`${BASE}/pay/mock/mock_`), 'WebApp.openLink receives the hosted payment page');
  assert.equal(await page.locator('.state__title').textContent(), 'Ждём оплату');

  // the customer pays in the external browser; the Mini App notices it by polling
  const external = await context.newPage();
  await external.goto(hosted, { waitUntil: 'networkidle' });
  await external.click('[data-testid="mock-pay-success"]');
  await external.waitForURL(/\/order\/[0-9a-f]{32}$/);
  await page.waitForSelector('.state__art--success', { timeout: 15000 });
  assert.deepEqual(errors, []);
  await context.close();
});
