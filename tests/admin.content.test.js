import './helpers/env.js';
import { SECRETS } from './admin.env-secrets.js';
import fs from 'node:fs';
import path from 'node:path';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/http.js';
import { config } from '../src/config.js';
import * as content from '../src/services/content.js';
import * as settings from '../src/services/settings.js';
import * as media from '../src/services/media.js';
import { login, upload, PNG } from './admin.helpers.js';

let t;
let c;
before(async () => {
  t = await startTestApp();
  c = t.client;
  await login(c);
});
after(async () => {
  await t.close();
  fs.rmSync(config.uploads.dir, { recursive: true, force: true });
});

test('content: pages list and the editor show every block of a page', async () => {
  const index = await c.get('/admin/content');
  assert.equal(index.status, 200);
  for (const title of ['Главная', 'Контакты', 'Доставка и оплата', 'Мини-приложение Telegram']) assert.ok(index.text.includes(title), title);
  assert.match(index.text, /href="\/admin\/content\/home"/);

  const page = await c.get('/admin/content/home');
  assert.equal(page.status, 200);
  for (const block of content.listBlocks('home')) {
    assert.ok(page.text.includes(`name="blocks[${block.key}]"`), `field for ${block.key}`);
  }
  assert.match(page.text, /data-editor/, 'rich text blocks get the editor');
  assert.match(page.text, /data-image-field/, 'image blocks get the image field');
  assert.equal((await c.get('/admin/content/no_such_page')).status, 404);
});

test('content: saved blocks are returned by the content service (text, rich text, image, link)', async () => {
  await c.get('/admin/content/home');
  const res = await c.postForm('/admin/content/home', {
    'blocks[hero_title]': 'Новый заголовок <b>главной</b>',
    'blocks[hero_text]': 'Строка 1\r\nСтрока 2',
    'blocks[hero_image]': '/uploads/new-hero.webp',
    'blocks[hero_cta_link]': '/catalog?category=filter',
    'blocks[story_text]': '<p>История <em>Samo</em></p><script>alert(1)</script><p style="color:red" onmouseover="x()">Абзац</p>',
    'blocks[no_such_block]': 'ignored',
  });
  assert.equal(res.status, 302);
  assert.equal(res.location, '/admin/content/home');

  const home = content.getPage('home');
  assert.equal(home.hero_title, 'Новый заголовок <b>главной</b>', 'plain text is stored as typed (escaped on output)');
  assert.equal(home.hero_text, 'Строка 1\nСтрока 2');
  assert.equal(home.hero_image, '/uploads/new-hero.webp');
  assert.equal(home.hero_cta_link, '/catalog?category=filter');
  assert.equal(home.story_text, '<p>История <em>Samo</em></p><p>Абзац</p>', 'rich text is sanitized');
  assert.equal(home.no_such_block, undefined);
  assert.equal(content.get('home', 'hero_title'), 'Новый заголовок <b>главной</b>');

  const again = await c.get('/admin/content/home');
  assert.match(again.text, /Изменения сохранены/);
  assert.ok(again.text.includes('value="Новый заголовок &lt;b&gt;главной&lt;/b&gt;"'), 'values are escaped in the form');
  assert.ok(!again.text.includes('<b>главной</b>'));

  // untouched blocks keep their values
  assert.equal(home.featured_title, content.DEFAULT_BLOCKS.find((b) => b.page === 'home' && b.key === 'featured_title').value);
});

test('content: an invalid image / link is reported and nothing is saved', async () => {
  await c.get('/admin/content/home');
  const before = content.getPage('home');
  const res = await c.postForm('/admin/content/home', {
    'blocks[hero_title]': 'Не должно сохраниться',
    'blocks[hero_image]': 'javascript:alert(1)',
  });
  assert.equal(res.status, 422);
  assert.match(res.text, /Ссылка должна начинаться/);
  assert.match(res.text, /Не должно сохраниться/, 'the form keeps what the admin typed');
  assert.deepEqual(content.getPage('home'), before);
  assert.equal((await c.postForm('/admin/content/no_such_page', { 'blocks[x]': 'y' })).status, 404);
});

test('settings: validation, saving, values reach the settings service', async () => {
  const page = await c.get('/admin/settings?tab=contacts');
  assert.equal(page.status, 200);
  assert.match(page.text, /name="s\[phone\]"/);

  const bad = await c.postForm('/admin/settings/contacts', { 's[phone]': '+998 71 000 00 00', 's[email]': 'not-an-email', 's[map_url]': 'javascript:alert(1)' });
  assert.equal(bad.status, 422);
  assert.match(bad.text, /Проверьте e-mail/);
  assert.match(bad.text, /Ссылка должна начинаться с https/);
  assert.notEqual(settings.get('phone'), '+998 71 000 00 00', 'nothing is saved when one field is invalid');

  const ok = await c.postForm('/admin/settings/contacts', { 's[phone]': '+998 71 000 00 00', 's[email]': 'shop@samo.coffee', 's[unknown_key]': 'x', 's[site_name]': 'Other group' });
  assert.equal(ok.status, 302);
  assert.equal(ok.location, '/admin/settings?tab=contacts');
  assert.equal(settings.get('phone'), '+998 71 000 00 00');
  assert.equal(settings.get('email'), 'shop@samo.coffee');
  assert.equal(settings.get('unknown_key', ''), '', 'unknown keys are ignored');
  assert.notEqual(settings.get('site_name'), 'Other group', 'keys of other groups are ignored');

  await c.get('/admin/settings?tab=general');
  assert.equal((await c.postForm('/admin/settings/general', { 's[site_name]': '' })).status, 422, 'the site name is required');
  await c.postForm('/admin/settings/general', { 's[site_name]': 'Samo Roasters' });
  assert.equal(settings.get('site_name'), 'Samo Roasters');
  assert.match((await c.get('/admin')).text, /Samo Roasters/, 'the new name is used right away');

  await c.get('/admin/settings?tab=delivery');
  assert.equal((await c.postForm('/admin/settings/delivery', { 's[delivery_fee]': 'бесплатно' })).status, 422);
  await c.postForm('/admin/settings/delivery', { 's[delivery_fee]': '30 000', 's[free_delivery_from]': '0' });
  assert.equal(settings.getInt('delivery_fee'), 30000);

  await c.get('/admin/settings?tab=bot');
  await c.postForm('/admin/settings/bot', { 's[bot_welcome_text]': 'Привет, {name}!\r\nВторая строка' });
  assert.equal(settings.get('bot_welcome_text'), 'Привет, {name}!\nВторая строка');
  assert.equal((await c.postForm('/admin/settings/nope', {})).status, 404);
});

test('settings: payment provider status shows which keys are set but never their values', async () => {
  assert.equal(config.payments.payme.key, SECRETS.PAYME_KEY, 'secrets are really configured in this test');
  const page = await c.get('/admin/settings?tab=payments');
  assert.equal(page.status, 200);
  for (const name of ['PAYME_MERCHANT_ID', 'PAYME_KEY', 'CLICK_SERVICE_ID', 'CLICK_SECRET_KEY', 'TELEGRAM_PAYMENT_TOKEN', 'BOT_TOKEN']) {
    assert.ok(page.text.includes(name), `${name} is listed`);
  }
  assert.match(page.text, /PAYME_KEY · задан/);
  assert.match(page.text, /BOT_TOKEN · не задан/);
  for (const url of ['/admin/settings?tab=payments', '/admin/settings?tab=bot', '/admin/settings', '/admin', '/admin/broadcasts', '/admin/account']) {
    const res = await c.get(url);
    for (const secret of [...Object.values(SECRETS), config.sessionSecret, config.admin.password]) {
      assert.ok(!res.text.includes(secret), `${url} must not contain a secret`);
    }
  }

  assert.equal((await c.postForm('/admin/settings/payments', { 's[payment_provider]': 'bitcoin' })).status, 422);
  const saved = await c.postForm('/admin/settings/payments', { 's[payment_provider]': 'mock' });
  assert.equal(saved.status, 302);
  assert.equal(settings.get('payment_provider'), 'mock');
  assert.match((await c.get('/admin/settings?tab=payments')).text, /Работает сейчас/);
});

test('media: upload (magic bytes are verified), list, alt text, delete', async () => {
  const empty = await c.get('/admin/media');
  assert.equal(empty.status, 200);
  assert.match(empty.text, /В медиатеке пока пусто/);

  const ok = await upload(c, [{ name: 'лого.png', type: 'image/png', data: PNG }]);
  assert.equal(ok.status, 200);
  const item = ok.json().items[0];
  assert.match(item.url, /^\/uploads\/[0-9a-f]{24}\.png$/, 'random file name');
  assert.equal(item.name, 'лого.png');
  const file = path.join(config.uploads.dir, path.basename(item.url));
  assert.ok(fs.existsSync(file));
  assert.equal((await c.get(item.url)).status, 200, 'the file is served');

  // a script renamed to .png is rejected and removed from disk
  const before = fs.readdirSync(config.uploads.dir).length;
  const fake = await upload(c, [{ name: 'evil.png', type: 'image/png', data: Buffer.from('<?php echo 1; ?><script>alert(1)</script>') }]);
  assert.equal(fake.status, 422);
  assert.match(fake.json().message, /не похож на изображение/i);
  const svg = await upload(c, [{ name: 'x.svg', type: 'image/svg+xml', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') }]);
  assert.equal(svg.status, 415);
  const exe = await upload(c, [{ name: 'x.html', type: 'text/html', data: Buffer.from('<script>alert(1)</script>') }]);
  assert.equal(exe.status, 415);
  const none = await upload(c, []);
  assert.equal(none.status, 422);
  assert.equal(fs.readdirSync(config.uploads.dir).length, before, 'rejected files do not stay on disk');
  assert.equal(media.listMedia().total, 1);

  const big = await upload(c, [{ name: 'big.png', type: 'image/png', data: Buffer.concat([PNG, Buffer.alloc(config.uploads.maxBytes + 10)]) }]);
  assert.equal(big.status, 413);
  assert.match(big.json().message, /слишком большой/i);

  const feed = (await c.get('/admin/media/list.json')).json();
  assert.equal(feed.total, 1);
  assert.equal(feed.items[0].url, item.url);

  const page = await c.get('/admin/media');
  assert.ok(page.text.includes(item.url));
  await c.postForm(`/admin/media/${item.id}`, { alt: 'Логотип Samo' });
  assert.equal(media.getMedia(item.id).alt, 'Логотип Samo');

  // plain multipart form (no JS): token in the query string, redirect back
  const form = new FormData();
  form.append('files', new Blob([PNG], { type: 'image/png' }), 'second.png');
  const plain = await c.request('POST', `/admin/media/upload?_csrf=${encodeURIComponent(c.csrfToken)}`, { body: form });
  assert.equal(plain.status, 302);
  assert.equal(media.listMedia().total, 2);

  const del = await c.postForm(`/admin/media/${item.id}/delete`, {});
  assert.equal(del.status, 302);
  assert.equal(media.getMedia(item.id), undefined);
  assert.ok(!fs.existsSync(file), 'the file is removed from disk');
  assert.equal((await c.postForm('/admin/media/999999/delete', {})).status, 404);
});
