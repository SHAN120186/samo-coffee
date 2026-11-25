import { FAKE_TG_PORT, ADMIN_CHAT_ID } from './helpers/env-telegram.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeTelegram } from './helpers/fakeTelegram.js';
import { get } from '../src/db/index.js';
import * as auth from '../src/services/auth.js';
import * as content from '../src/services/content.js';
import * as settings from '../src/services/settings.js';
import * as catalog from '../src/services/catalog.js';
import * as customers from '../src/services/customers.js';
import * as tgUsers from '../src/services/tgUsers.js';
import * as feedback from '../src/services/feedback.js';
import * as analytics from '../src/services/analytics.js';
import * as orders from '../src/services/orders.js';
import * as cart from '../src/services/cart.js';
import * as notify from '../src/services/notify.js';
import * as posts from '../src/services/posts.js';
import * as tg from '../src/lib/telegramApi.js';
import { makeCatalog, CUSTOMER, DELIVERY } from './helpers/fixtures.js';

let fake;
before(async () => {
  fake = await startFakeTelegram(FAKE_TG_PORT);
});
after(async () => {
  await notify.flush();
  await fake.close();
});
beforeEach(() => fake.reset());

test('telegramApi: call() goes through TELEGRAM_API_ROOT and maps errors', async () => {
  assert.equal(tg.isConfigured(), true);
  const me = await tg.call('getMe');
  assert.equal(me.username, 'samo_test_bot');
  fake.on('sendMessage', () => ({ error_code: 403, description: 'Forbidden: bot was blocked by the user' }));
  await assert.rejects(() => tg.sendMessage(1, 'x'), (e) => e.name === 'TelegramError' && e.code === 403 && e.isBlocked);
  assert.equal(await tg.trySendMessage(1, 'x'), null, 'safe variant never throws');
});

test('auth: password hashing, login, sessions, rate limit', () => {
  const hash = auth.hashPassword('correct horse');
  assert.match(hash, /^scrypt\$16384\$8\$1\$/);
  assert.ok(auth.verifyPassword('correct horse', hash));
  assert.equal(auth.verifyPassword('wrong', hash), false);
  assert.equal(auth.verifyPassword('x', 'garbage'), false);
  assert.notEqual(auth.hashPassword('correct horse'), hash, 'salted');

  auth.ensureDefaultAdmin();
  assert.equal(auth.ensureDefaultAdmin(), null, 'only created once');
  const bad = auth.login('admin@samo.coffee', 'nope', { ip: '10.0.0.1' });
  assert.deepEqual(bad, { ok: false, reason: 'invalid' });
  const ok = auth.login('ADMIN@samo.coffee', 'admin12345', { ip: '10.0.0.1', userAgent: 'test' });
  assert.equal(ok.ok, true);
  assert.equal(ok.admin.role, 'owner');
  assert.equal(ok.admin.password_hash, undefined, 'hash never leaves the service');
  assert.equal(auth.getSessionAdmin(ok.token).email, 'admin@samo.coffee');
  assert.equal(auth.getSessionAdmin('forged-token'), null);
  assert.equal(get('SELECT COUNT(*) AS n FROM admin_sessions WHERE id = ?', ok.token).n, 0, 'raw token is not stored');
  auth.logout(ok.token);
  assert.equal(auth.getSessionAdmin(ok.token), null);

  for (let i = 0; i < 8; i++) auth.login('admin@samo.coffee', 'bad', { ip: '10.0.0.9' });
  const limited = auth.login('admin@samo.coffee', 'admin12345', { ip: '10.0.0.9' });
  assert.equal(limited.ok, false);
  assert.equal(limited.reason, 'rate_limited');

  const second = auth.createAdmin({ email: 'manager@samo.coffee', password: 'longenough1', name: 'Менеджер', role: 'manager' });
  assert.throws(() => auth.createAdmin({ email: 'manager@samo.coffee', password: 'longenough1' }), (e) => e.code === 'validation');
  assert.throws(() => auth.createAdmin({ email: 'x@y.zz', password: 'short' }), (e) => e.code === 'validation');
  assert.throws(() => auth.changePassword(second.id, 'wrong-current', 'newpassword1'), (e) => e.code === 'validation');
  assert.equal(auth.changePassword(second.id, 'longenough1', 'newpassword1'), true);
  assert.equal(auth.login('manager@samo.coffee', 'newpassword1', { ip: '10.0.0.2' }).ok, true);
  assert.throws(() => auth.updateAdmin(ok.admin.id, { role: 'manager' }), (e) => e.code === 'validation', 'last owner is protected');
  assert.equal(auth.safeNext('/admin/orders?status=new'), '/admin/orders?status=new');
  assert.equal(auth.safeNext('//evil.example'), '/admin');
  assert.equal(auth.safeNext('https://evil.example/admin'), '/admin');
});

test('content + settings: defaults, updates, sanitizing, cache', () => {
  content.ensureDefaults();
  const home = content.getPage('home');
  assert.ok(home.hero_title.length > 10);
  assert.equal(content.get('home', 'nope', 'fallback'), 'fallback');
  content.setBlock('home', 'hero_title', '  Новый заголовок  ');
  assert.equal(content.getPage('home').hero_title, 'Новый заголовок');
  content.setBlock('home', 'story_text', '<p>ok</p><script>alert(1)</script>');
  assert.equal(content.getPage('home').story_text, '<p>ok</p>');
  assert.throws(() => content.setBlock('home', 'hero_image', 'javascript:alert(1)'), (e) => e.code === 'validation');
  content.setBlock('home', 'hero_image', '/uploads/abc.webp');
  assert.throws(() => content.setBlock('home', 'missing_key', 'x'), (e) => e.code === 'not_found');
  content.ensureDefaults();
  assert.equal(content.getPage('home').hero_title, 'Новый заголовок', 'ensureDefaults never overwrites edits');
  const custom = content.upsertBlock({ page: 'home', key: 'promo_text', type: 'text', value: 'Акция', label: 'Промо' });
  assert.equal(content.getPage('home').promo_text, 'Акция');
  assert.ok(content.listBlocks('home').some((b) => b.id === custom.id));
  assert.ok(content.listPages().find((p) => p.page === 'home').blocks > 10);
  assert.equal(content.deleteBlock(custom.id), true);

  assert.equal(settings.get('site_name'), 'Samo Coffee');
  assert.equal(settings.getInt('delivery_fee'), 25000);
  settings.setMany({ site_name: 'Новое имя', delivery_fee: '30000' });
  assert.equal(settings.getAll().site_name, 'Новое имя');
  assert.equal(settings.getInt('delivery_fee'), 30000);
  settings.setMany({ site_name: 'Samo Coffee', delivery_fee: '25000' });
  assert.ok(settings.describe('bot').every((s) => s.key.startsWith('bot_')));
});

test('catalog: CRUD, slugs, search, sorting', () => {
  const { category, products } = makeCatalog(3);
  const p = catalog.createProduct({ title: 'Эфиопия Гуджи', price: '155 000'.replace(/\s/g, ''), stock: 5, category_id: category.id, images: '/img/a.svg\n/img/b.svg', details_html: '<p>ok</p><script>x</script>', attributes: '{"Высота":"2000 м"}', featured: 'on' });
  assert.equal(p.slug, 'efiopiya-gudzhi');
  assert.deepEqual(p.images, ['/img/a.svg', '/img/b.svg']);
  assert.equal(p.image, '/img/a.svg');
  assert.equal(p.details_html, '<p>ok</p>');
  assert.equal(p.attributes['Высота'], '2000 м');
  assert.equal(p.featured, 1);
  assert.equal(catalog.createProduct({ title: 'Эфиопия Гуджи', price: 1 }).slug, 'efiopiya-gudzhi-2');
  assert.throws(() => catalog.createProduct({ title: '', price: 1 }), (e) => e.code === 'validation');
  assert.throws(() => catalog.createProduct({ title: 'x', price: -5 }), (e) => e.code === 'validation');

  const updated = catalog.updateProduct(p.id, { price: 99000, old_price: 120000, active: 0 });
  assert.equal(updated.title, 'Эфиопия Гуджи', 'partial update keeps other fields');
  assert.equal(updated.discount_percent, 18);
  assert.equal(catalog.getProductBySlug('efiopiya-gudzhi'), null, 'inactive is hidden by default');
  assert.equal(catalog.getProductBySlug('efiopiya-gudzhi', { activeOnly: false }).id, p.id);

  const found = catalog.listProducts({ search: 'ТЕСТОВЫЙ кофе', categoryId: category.id });
  assert.equal(found.total, 3);
  const asc = catalog.listProducts({ categoryId: category.id, sort: 'price_asc' }).items.map((x) => x.price);
  assert.deepEqual(asc, [...asc].sort((a, b) => a - b));
  assert.equal(catalog.listProducts({ categoryId: category.id, limit: 2, offset: 2 }).items.length, 1);
  assert.equal(catalog.listCategories().find((c) => c.id === category.id).product_count, 3);
  assert.equal(catalog.adjustStock(products[0].id, -3), 7);
  assert.equal(catalog.adjustStock(products[0].id, -100), 0);
  assert.equal(catalog.deleteProduct(p.id), true);

  const post = posts.createPost({ title: 'Первая запись', body_html: '<p>Текст</p>', published: 1 });
  assert.equal(post.slug, 'pervaya-zapis');
  assert.ok(post.published_at);
  assert.equal(posts.getPostBySlug('pervaya-zapis').id, post.id);
});

test('customers: phone normalization and upsert matching', () => {
  assert.equal(customers.normalizePhone('+998 (90) 123-45-67'), '+998901234567');
  assert.equal(customers.normalizePhone('901234567'), '+998901234567');
  assert.equal(customers.normalizePhone('998901234567'), '+998901234567');
  assert.equal(customers.normalizePhone('12'), null);
  assert.equal(customers.formatPhone('+998901234567'), '+998 90 123 45 67');
  const a = customers.upsertCustomer({ name: 'Азиз', phone: '90 111 22 33', source: 'site' });
  // a phone typed by a Telegram user is not verified: it never attaches the account to an existing record
  const b = customers.upsertCustomer({ name: 'Азиз Каримов', phone: '+998901112233', email: 'aziz@example.com', tgUserId: 777, tgUsername: 'aziz' });
  assert.notEqual(a.id, b.id);
  assert.equal(b.name, 'Азиз Каримов');
  assert.equal(b.tg_user_id, 777);
  assert.equal(customers.getCustomer(a.id).tg_user_id, null);
  assert.equal(customers.upsertCustomer({ tgUserId: 777 }).id, b.id);
  // anonymous input never matches a Telegram-linked record
  assert.notEqual(customers.upsertCustomer({ email: 'AZIZ@example.com' }).id, b.id);
  assert.equal(customers.upsertCustomer({ name: 'Не Азиз', phone: '+998901112233', source: 'site' }).id, a.id);
  assert.equal(customers.getCustomer(a.id).name, 'Азиз', 'stored contacts are not overwritten by a form');
  // the verified phone (own Telegram contact) joins the records
  const joined = customers.linkTelegramAccount({ tgUserId: 777, phone: '+998 90 111 22 33', tgUsername: 'aziz' });
  assert.equal(joined.id, b.id);
  assert.equal(customers.getCustomer(a.id), undefined);
  assert.equal(customers.listCustomers({ search: 'каримов' }).items[0].id, b.id);
  assert.equal(customers.listCustomers({ search: '1112233' }).items[0].id, b.id);
});

test('tg users: registration and state', () => {
  const first = tgUsers.upsertTgUser({ id: 5001, first_name: 'Лола', username: 'lola' }, { startParam: 'insta' });
  assert.equal(first.isNew, true);
  assert.equal(first.user.start_param, 'insta');
  const again = tgUsers.upsertTgUser({ id: 5001, first_name: 'Лола', last_name: 'К.' }, { startParam: 'other' });
  assert.equal(again.isNew, false);
  assert.equal(again.user.start_param, 'insta', 'first deep link is kept');
  assert.equal(again.user.username, 'lola');
  assert.equal(tgUsers.setTgState(5001, 'support', { a: 1 }).state, 'support');
  assert.deepEqual(tgUsers.getTgUser(5001).state_data, { a: 1 });
  tgUsers.markTgBlocked(5001);
  assert.equal(tgUsers.listTgUsers({ activeOnly: true }).some((u) => u.id === 5001), false);
  assert.equal(tgUsers.upsertTgUser({ id: 5001, first_name: 'Лола' }).user.is_blocked, 0, 'writing to the bot again unblocks');
  assert.equal(tgUsers.tgDisplayName({ id: 1, first_name: 'A', last_name: 'B' }), 'A B');
});

test('feedback: site thread is forwarded to the admin chat; admin reply is stored', async () => {
  const { thread, message } = await feedback.createThread({ channel: 'site', name: 'Дильноза', contact: 'd@mail.uz', subject: 'Опт', text: 'Нужны цены <b>от 10 кг</b>' });
  assert.equal(thread.status, 'open');
  assert.equal(thread.unread, 1);
  const sent = fake.callsTo('sendMessage');
  assert.equal(sent.length, 1);
  assert.equal(String(sent[0].chat_id), ADMIN_CHAT_ID);
  assert.ok(sent[0].text.includes(`#${thread.id}`));
  assert.ok(sent[0].text.includes('&lt;b&gt;от 10 кг&lt;/b&gt;'), 'user text is escaped');
  assert.ok(message.admin_chat_message_id > 0);
  assert.equal(feedback.findThreadByAdminMessageId(message.admin_chat_message_id).id, thread.id);

  const result = await feedback.reply(thread.id, { text: 'Отправили прайс на почту', adminId: null, via: 'panel' });
  assert.equal(result.deliverable, false, 'site threads have no Telegram chat');
  assert.equal(result.delivered, false);
  const full = feedback.getThread(thread.id);
  assert.equal(full.status, 'answered');
  assert.equal(full.unread, 0);
  assert.deepEqual(full.messages.map((m) => m.direction), ['in', 'out']);
  await assert.rejects(() => feedback.createThread({ channel: 'site', text: '   ' }), (e) => e.code === 'validation');
});

test('feedback: bot conversation — messages append to one thread, replies are delivered through the bot', async () => {
  const tgUser = { id: 880011, first_name: 'Рустам', username: 'rustam' };
  const a = await feedback.receiveFromTelegram({ tgUser, text: 'Здравствуйте! Когда будет Руанда?', tgMessageId: 11 });
  assert.equal(a.isNew, true);
  assert.equal(a.thread.channel, 'bot');
  assert.equal(a.thread.tg_chat_id, 880011);
  assert.equal(a.thread.contact, '@rustam');
  const b = await feedback.receiveFromTelegram({ tgUser, text: 'И сколько будет стоить?', tgMessageId: 12 });
  assert.equal(b.isNew, false);
  assert.equal(b.thread.id, a.thread.id);
  assert.equal(b.thread.unread, 2);
  assert.equal(fake.callsTo('sendMessage').filter((m) => String(m.chat_id) === ADMIN_CHAT_ID).length, 2);

  // the admin replies to the SECOND forwarded message in the admin chat
  const thread = feedback.findThreadByAdminMessageId(b.message.admin_chat_message_id);
  assert.equal(thread.id, a.thread.id);
  fake.reset();
  const result = await feedback.reply(thread.id, { text: 'В среду, 159 000 сум <3', via: 'telegram' });
  assert.equal(result.delivered, true);
  const toUser = fake.callsTo('sendMessage');
  assert.equal(toUser.length, 1);
  assert.equal(toUser[0].chat_id, 880011);
  assert.ok(toUser[0].text.includes('159 000 сум &lt;3'));
  assert.equal(result.message.delivered, 1);
  assert.equal(result.message.via, 'telegram');
  assert.equal(feedback.getThread(thread.id).status, 'answered');

  // blocked user → stored but not delivered, user is flagged
  tgUsers.upsertTgUser(tgUser);
  fake.on('sendMessage', () => ({ error_code: 403, description: 'Forbidden: bot was blocked by the user' }));
  const failed = await feedback.reply(thread.id, { text: 'Ещё одно', via: 'panel' });
  assert.equal(failed.delivered, false);
  assert.ok(failed.error);
  assert.equal(tgUsers.getTgUser(880011).is_blocked, 1);

  // closed thread → next message opens a new one
  feedback.setThreadStatus(thread.id, 'closed');
  fake.reset();
  const c = await feedback.receiveFromTelegram({ tgUser, text: 'Новый вопрос' });
  assert.equal(c.isNew, true);
  assert.notEqual(c.thread.id, thread.id);
  assert.ok(feedback.counts().unread >= 1);
  assert.ok(feedback.listThreads({ channel: 'bot', search: 'новый вопрос' }).total >= 1);
  assert.equal(feedback.listForTgUser(880011).length, 2);
});

test('notifications: order lifecycle messages reach admins and the customer', async () => {
  const { products } = makeCatalog(1);
  const ref = { tgUserId: 660066 };
  cart.addItem(ref, products[0].id, 1);
  const order = orders.createFromCart(ref, { customer: CUSTOMER, delivery: DELIVERY, channel: 'tma', tgUserId: 660066 });
  await notify.flush();
  let msgs = fake.callsTo('sendMessage');
  assert.equal(msgs.length, 1);
  assert.equal(String(msgs[0].chat_id), ADMIN_CHAT_ID);
  assert.ok(msgs[0].text.includes(order.number));

  fake.reset();
  orders.markPaid(order.id, { provider: 'mock', txId: 'n-1' });
  orders.markPaid(order.id, { provider: 'mock', txId: 'n-1' });
  await notify.flush();
  msgs = fake.callsTo('sendMessage');
  assert.equal(msgs.length, 2, 'admin + customer, once');
  assert.deepEqual(msgs.map((m) => String(m.chat_id)).sort(), [ADMIN_CHAT_ID, '660066'].sort());

  fake.reset();
  orders.setStatus(order.id, 'shipped');
  await notify.flush();
  msgs = fake.callsTo('sendMessage');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].chat_id, 660066);
  assert.ok(msgs[0].text.includes('курьеру'));
});

test('analytics: classification, ranges and aggregates', () => {
  assert.equal(analytics.detectDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148'), 'mobile');
  assert.equal(analytics.detectDevice('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)'), 'tablet');
  assert.equal(analytics.detectDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120'), 'desktop');
  assert.equal(analytics.isBotUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1)'), true);
  assert.equal(analytics.isBotUserAgent('curl/8.0'), true);
  assert.equal(analytics.isBotUserAgent('Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36'), false);
  assert.deepEqual(analytics.classifyTraffic({ utmSource: 'Instagram', utmMedium: 'cpc', utmCampaign: 'autumn' }), { source: 'instagram', medium: 'cpc', campaign: 'autumn' });
  assert.deepEqual(analytics.classifyTraffic({ referrer: 'https://www.google.com/search?q=x', ownHost: 'samo.coffee' }), { source: 'google', medium: 'organic', campaign: '' });
  assert.deepEqual(analytics.classifyTraffic({ referrer: 'https://t.me/samo_coffee', ownHost: 'samo.coffee' }), { source: 'telegram', medium: 'social', campaign: '' });
  assert.equal(analytics.classifyTraffic({ referrer: 'https://samo.coffee/catalog', ownHost: 'samo.coffee' }), null);
  assert.equal(analytics.normalizePath('/order/abcdef0123'), '/order/*');
  assert.equal(analytics.normalizePath('/catalog/'), '/catalog');

  const range = analytics.resolveRange({ from: '2026-01-10', to: '2026-01-12' });
  assert.deepEqual(range.days, ['2026-01-10', '2026-01-11', '2026-01-12']);
  assert.equal(range.start, '2026-01-09T19:00:00.000Z', 'Tashkent midnight in UTC');
  assert.equal(range.end, '2026-01-12T19:00:00.000Z');
  assert.deepEqual([range.prev.from, range.prev.to], ['2026-01-07', '2026-01-09']);
  assert.equal(analytics.resolveRange({}).days.length, 30);
  assert.equal(analytics.resolveRange({ range: '7d' }).days.length, 7);

  const at = (day, h) => `2026-01-${String(day).padStart(2, "0")}T${String(h).padStart(2, '0')}:00:00.000Z`;
  analytics.recordPageView({ sessionId: 's1', path: '/', source: 'google', medium: 'organic', device: 'mobile', at: at(10, 6) });
  analytics.recordPageView({ sessionId: 's1', path: '/catalog', source: 'google', medium: 'organic', device: 'mobile', at: at(10, 6) });
  analytics.recordPageView({ sessionId: 's2', path: '/', device: 'desktop', at: at(11, 8) });
  analytics.recordPageView({ sessionId: 's3', path: '/', device: 'desktop', at: at(9, 23) }); // 04:00 on Jan 10 in Tashkent
  analytics.recordPageView({ sessionId: 's9', path: '/', device: 'desktop', at: at(12, 20) }); // already Jan 13 locally → out of range
  analytics.trackEvent('view_product', { sessionId: 's1', productId: 1, at: at(10, 6) });
  analytics.trackEvent('add_to_cart', { sessionId: 's1', productId: 1, at: at(10, 6) });
  const s = analytics.summary(range);
  assert.equal(s.visitors, 3);
  assert.equal(s.pageViews, 4);
  const series = analytics.timeseries(range);
  assert.deepEqual(series.map((d) => d.visitors), [2, 1, 0]);
  const f = analytics.funnel(range);
  assert.deepEqual(f.map((x) => x.count), [3, 1, 1, 0, 0]);
  assert.equal(analytics.topPages(range)[0].path, '/');
  assert.equal(analytics.devices(range)[0].device, 'desktop');
  assert.equal(analytics.sources(range).find((x) => x.source === 'google').visitors, 1);
  const all = analytics.dashboard(range);
  assert.ok(all.summary && all.timeseries && all.funnel && all.telegram && all.channels);
});

test('telegram payments: invoice, pre-checkout validation, successful payment', async () => {
  const tgPay = await import('../src/services/telegramPayments.js');
  const { products } = makeCatalog(1);
  const ref = { tgUserId: 770077 };
  cart.addItem(ref, products[0].id, 2);
  const order = orders.createFromCart(ref, { customer: CUSTOMER, delivery: DELIVERY, channel: 'tma', tgUserId: 770077 });
  const invoice = tgPay.buildInvoice(order);
  assert.equal(invoice.payload, `order:${order.id}`);
  assert.equal(invoice.currency, 'UZS');
  assert.equal(invoice.prices.reduce((s, p) => s + p.amount, 0), order.total * 100, 'prices sum up to the total in tiyin');
  assert.equal(tgPay.parseInvoicePayload(invoice.payload), order.id);
  assert.equal(tgPay.parseInvoicePayload('order:1;x'), null);
  assert.equal(await tgPay.createInvoiceLink(order), 'https://t.me/$fake_invoice_link');
  assert.equal(fake.callsTo('createInvoiceLink')[0].payload, `order:${order.id}`);

  const query = { invoice_payload: invoice.payload, currency: 'UZS', total_amount: order.total * 100 };
  assert.equal(tgPay.validatePreCheckout(query).ok, true);
  assert.equal(tgPay.validatePreCheckout({ ...query, total_amount: 100 }).ok, false);
  assert.equal(tgPay.validatePreCheckout({ ...query, invoice_payload: 'order:999999' }).ok, false);
  assert.equal(tgPay.validatePreCheckout({ ...query, invoice_payload: 'junk' }).ok, false);

  const sp = { ...query, telegram_payment_charge_id: 'tg-ch-1', provider_payment_charge_id: 'prov-1' };
  assert.deepEqual(tgPay.handleSuccessfulPayment({ ...sp, total_amount: 100 }), { ok: false, reason: 'amount_mismatch' });
  const first = tgPay.handleSuccessfulPayment(sp);
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.equal(first.order.payment_provider, 'telegram');
  assert.equal(tgPay.handleSuccessfulPayment(sp).changed, false, 'idempotent');
  assert.equal(tgPay.validatePreCheckout(query).ok, false, 'paid orders are rejected at pre-checkout');
  await notify.flush();
});

test('media: uploads are validated by magic bytes', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const media = await import('../src/services/media.js');
  const { config } = await import('../src/config.js');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const good = path.join(config.uploads.dir, 'aaaaaaaaaaaaaaaaaaaaaaaa.png');
  fs.writeFileSync(good, png);
  const row = media.registerUpload({ path: good, filename: path.basename(good), mimetype: 'image/png', size: png.length, originalname: 'пакет.png' }, { alt: 'Пачка' });
  assert.equal(row.url, '/uploads/aaaaaaaaaaaaaaaaaaaaaaaa.png');
  assert.equal(row.mime, 'image/png');
  assert.equal(media.listMedia().total, 1);

  const evil = path.join(config.uploads.dir, 'bbbbbbbbbbbbbbbbbbbbbbbb.png');
  fs.writeFileSync(evil, '<html><script>alert(1)</script></html>');
  assert.throws(() => media.registerUpload({ path: evil, filename: path.basename(evil), mimetype: 'image/png', size: 10, originalname: 'x.png' }), (e) => e.code === 'bad_file_type');
  assert.equal(fs.existsSync(evil), false, 'rejected file is removed');

  assert.equal(media.deleteMedia(row.id), true);
  assert.equal(fs.existsSync(good), false);
  assert.equal(media.ALLOWED_TYPES['image/svg+xml'], undefined, 'SVG uploads are not allowed');
  fs.rmSync(config.uploads.dir, { recursive: true, force: true });
});
