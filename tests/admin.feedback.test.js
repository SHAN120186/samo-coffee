import { FAKE_TG_PORT, ADMIN_CHAT_ID } from './helpers/env-telegram.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeTelegram } from './helpers/fakeTelegram.js';
import { startTestApp } from './helpers/http.js';
import * as feedback from '../src/services/feedback.js';
import * as tgUsers from '../src/services/tgUsers.js';
import * as broadcasts from '../src/services/broadcasts.js';
import * as notify from '../src/services/notify.js';
import { get } from '../src/db/index.js';
import * as cart from '../src/services/cart.js';
import * as orders from '../src/services/orders.js';
import { makeCatalog, CUSTOMER, DELIVERY } from './helpers/fixtures.js';
import { login, waitFor } from './admin.helpers.js';

let t;
let c;
let fake;
let adminId;
before(async () => {
  fake = await startFakeTelegram(FAKE_TG_PORT);
  t = await startTestApp();
  c = t.client;
  await login(c);
  adminId = get('SELECT id FROM admins ORDER BY id LIMIT 1').id;
});
after(async () => {
  await notify.flush();
  await t.close();
  await fake.close();
});

const TG_USER = { id: 555001, first_name: 'Сардор', last_name: 'Рахимов', username: 'sardor_r' };

test('inbox: empty state, then threads with unread state and channel badges', async () => {
  const empty = await c.get('/admin/feedback');
  assert.equal(empty.status, 200);
  assert.match(empty.text, /Обращений пока нет/);

  tgUsers.upsertTgUser(TG_USER, { chatId: TG_USER.id });
  const bot = await feedback.receiveFromTelegram({ tgUser: TG_USER, text: 'Подскажите помол для аэропресса', tgMessageId: 10 });
  await feedback.createThread({ channel: 'site', text: 'Нужны оптовые цены <script>alert(1)</script>', name: 'Дильноза', contact: 'dilnoza@example.com', subject: 'Опт' });
  assert.equal(fake.callsTo('sendMessage').filter((m) => String(m.chat_id) === ADMIN_CHAT_ID).length, 2, 'both were forwarded to the admin chat');

  const list = await c.get('/admin/feedback');
  assert.match(list.text, /Сардор Рахимов/);
  assert.match(list.text, /Дильноза/);
  assert.match(list.text, /Telegram-бот/);
  assert.match(list.text, /is-unread/);
  assert.ok(!list.text.includes('<script>alert(1)</script>'), 'message text is escaped');
  assert.match(list.text, /class="adm-nav__count"[^>]*>2</, 'sidebar shows two unread threads');

  const onlyBot = await c.get('/admin/feedback?channel=bot');
  assert.ok(!onlyBot.text.includes('Дильноза'));
  const search = await c.get(`/admin/feedback?search=${encodeURIComponent('оптовые')}`);
  assert.ok(!search.text.includes('Сардор Рахимов'));
  assert.match(search.text, /Дильноза/);

  const thread = await c.get(`/admin/feedback/${bot.thread.id}`);
  assert.equal(thread.status, 200);
  assert.match(thread.text, /Подскажите помол для аэропресса/);
  assert.equal(feedback.getThread(bot.thread.id).unread, 0, 'opening a thread marks it as read');
  assert.match(thread.text, /class="adm-nav__count"[^>]*>1</);
});

test('reply to a Telegram user is delivered through the bot', async () => {
  const thread = feedback.listThreads({ channel: 'bot' }).items[0];
  await c.get(`/admin/feedback/${thread.id}`);
  const callsBefore = fake.callsTo('sendMessage').length;

  const empty = await c.postForm(`/admin/feedback/${thread.id}/reply`, { text: '   ' });
  assert.equal(empty.status, 422);
  assert.match(empty.text, /Напишите текст ответа/);
  assert.equal(fake.callsTo('sendMessage').length, callsBefore);

  const res = await c.postForm(`/admin/feedback/${thread.id}/reply?status=open`, { text: 'Берите помол чуть мельче фильтра <b>и</b> 90 °C' });
  assert.equal(res.status, 302);
  assert.equal(res.location, `/admin/feedback/${thread.id}?status=open`, 'filters are kept after the reply');

  const sent = fake.callsTo('sendMessage').slice(callsBefore);
  assert.equal(sent.length, 1);
  assert.equal(Number(sent[0].chat_id), TG_USER.id, 'sent to the user, not to the admin chat');
  assert.match(sent[0].text, /Берите помол чуть мельче фильтра &lt;b&gt;и&lt;\/b&gt; 90 °C/, 'the answer is HTML-escaped for Telegram');
  assert.equal(sent[0].parse_mode, 'HTML');

  const fresh = feedback.getThread(thread.id);
  const last = fresh.messages.at(-1);
  assert.equal(last.direction, 'out');
  assert.equal(last.via, 'panel');
  assert.equal(last.admin_id, adminId);
  assert.equal(last.delivered, 1);
  assert.equal(fresh.status, 'answered');

  const page = await c.get(res.location);
  assert.match(page.text, /Ответ отправлен клиенту в Telegram/);
  assert.match(page.text, /доставлено в Telegram/);
  assert.match(page.text, /msg--out/);
});

test('reply to a site thread is stored but not sent anywhere', async () => {
  const thread = feedback.listThreads({ channel: 'site' }).items[0];
  await c.get(`/admin/feedback/${thread.id}`);
  const callsBefore = fake.callsTo('sendMessage').length;
  const res = await c.postForm(`/admin/feedback/${thread.id}/reply`, { text: 'Отправили прайс на почту' });
  assert.equal(res.status, 302);
  assert.equal(fake.callsTo('sendMessage').length, callsBefore, 'no Telegram call');
  const last = feedback.getThread(thread.id).messages.at(-1);
  assert.equal(last.text, 'Отправили прайс на почту');
  assert.equal(last.delivered, 0);
  assert.match((await c.get(res.location)).text, /обращение с сайта/i);
});

test('reply that Telegram rejects is kept and reported as not delivered', async () => {
  const blockedUser = { id: 555002, first_name: 'Мария' };
  tgUsers.upsertTgUser(blockedUser, { chatId: blockedUser.id });
  const { thread } = await feedback.receiveFromTelegram({ tgUser: blockedUser, text: 'Где мой заказ?' });
  fake.on('sendMessage', (p) => (Number(p.chat_id) === blockedUser.id
    ? { error_code: 403, description: 'Forbidden: bot was blocked by the user' }
    : { message_id: 1, chat: { id: Number(p.chat_id) }, text: p.text }));
  await c.get(`/admin/feedback/${thread.id}`);
  const res = await c.postForm(`/admin/feedback/${thread.id}/reply`, { text: 'Курьер уже едет' });
  fake.off('sendMessage');
  assert.equal(res.status, 302);
  const last = feedback.getThread(thread.id).messages.at(-1);
  assert.equal(last.direction, 'out');
  assert.equal(last.delivered, 0);
  assert.equal(tgUsers.getTgUser(blockedUser.id).is_blocked, 1);
  const page = await c.get(res.location);
  assert.match(page.text, /заблокировал бота/);
  assert.match(page.text, /не доставлено/);
});

test('threads can be closed, reopened and deleted', async () => {
  const thread = feedback.listThreads({ channel: 'site' }).items[0];
  await c.get(`/admin/feedback/${thread.id}`);
  await c.postForm(`/admin/feedback/${thread.id}/status`, { status: 'closed' });
  assert.equal(feedback.getThread(thread.id).status, 'closed');
  assert.ok(!(await c.get('/admin/feedback?status=open')).text.includes('Дильноза'));
  assert.match((await c.get('/admin/feedback?status=closed')).text, /Дильноза/);
  await c.postForm(`/admin/feedback/${thread.id}/status`, { status: 'open' });
  assert.equal(feedback.getThread(thread.id).status, 'open');
  const bad = await c.postForm(`/admin/feedback/${thread.id}/status`, { status: 'archived' });
  assert.equal(bad.status, 302, 'unknown status → flash + redirect');
  assert.equal(feedback.getThread(thread.id).status, 'open');

  const del = await c.postForm(`/admin/feedback/${thread.id}/delete`, {});
  assert.equal(del.status, 302);
  assert.equal(feedback.getThread(thread.id), null);
  assert.equal((await c.get(`/admin/feedback/${thread.id}`)).status, 404);
});

test('broadcast: validation, draft, sending to every active bot user with stored history', async () => {
  for (let i = 0; i < 3; i += 1) tgUsers.upsertTgUser({ id: 600000 + i, first_name: `Подписчик ${i}` }, { chatId: 600000 + i });
  tgUsers.markTgBlocked(600002, true);
  const recipients = tgUsers.countTgUsers().active;

  const page = await c.get('/admin/broadcasts');
  assert.equal(page.status, 200);
  assert.match(page.text, /Рассылок ещё не было/);
  assert.ok(page.text.includes(`Получателей: <b>${recipients}</b>`));

  const bad = await c.postForm('/admin/broadcasts', { text: '', action: 'send' });
  assert.equal(bad.status, 422);
  const badTag = await c.postForm('/admin/broadcasts', { text: 'Новый лот <div>уже</div> в продаже', action: 'send' });
  assert.equal(badTag.status, 422);
  assert.match(badTag.text, /неподдерживаемые теги/);
  const badButton = await c.postForm('/admin/broadcasts', { text: 'Привет', button_text: 'Открыть', button_url: 'http://insecure.example', action: 'send' });
  assert.equal(badButton.status, 422);
  assert.equal(broadcasts.listBroadcasts().length, 0);

  const draft = await c.postForm('/admin/broadcasts', { text: 'Черновик на завтра', action: 'draft' });
  assert.equal(draft.status, 302);
  assert.equal(broadcasts.listBroadcasts()[0].status, 'draft');

  const callsBefore = fake.callsTo('sendMessage').length;
  const send = await c.postForm('/admin/broadcasts', {
    text: 'Привезли <b>новый лот</b> из Кении', button_text: 'Открыть магазин', button_url: 'https://samo.coffee/catalog', action: 'send',
  });
  assert.equal(send.status, 302);
  const id = broadcasts.listBroadcasts()[0].id;
  const done = await waitFor(() => {
    const b = broadcasts.getBroadcast(id);
    return b.status === 'done' ? b : null;
  });
  assert.equal(done.total, recipients);
  assert.equal(done.sent, recipients);
  assert.equal(done.failed, 0);

  const sent = fake.callsTo('sendMessage').slice(callsBefore);
  assert.equal(sent.length, recipients);
  const chats = sent.map((m) => Number(m.chat_id));
  assert.ok(chats.includes(600000) && chats.includes(600001));
  assert.ok(!chats.includes(600002), 'users who blocked the bot are skipped');
  assert.ok(!chats.map(String).includes(ADMIN_CHAT_ID));
  assert.equal(sent[0].text, 'Привезли <b>новый лот</b> из Кении');
  assert.deepEqual(sent[0].reply_markup.inline_keyboard[0][0], { text: 'Открыть магазин', url: 'https://samo.coffee/catalog' });

  const history = await c.get('/admin/broadcasts');
  assert.match(history.text, /Отправлено/);
  assert.ok(history.text.includes(`${recipients} из ${recipients}`));
  const status = (await c.get('/admin/broadcasts/status.json')).json();
  assert.equal(status.items.find((b) => b.id === id).status, 'done');

  // a stored draft can be sent later, but only once
  const draftId = broadcasts.listBroadcasts().find((b) => b.status === 'draft').id;
  assert.equal((await c.postForm(`/admin/broadcasts/${draftId}/send`, {})).status, 302);
  await waitFor(() => broadcasts.getBroadcast(draftId).status === 'done');
  const total = fake.callsTo('sendMessage').length;
  await c.postForm(`/admin/broadcasts/${draftId}/send`, {});
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(fake.callsTo('sendMessage').length, total, 'a finished broadcast is not sent twice');
  assert.equal((await c.postForm('/admin/broadcasts/999999/send', {})).status, 404);
});

test('order actions in the panel notify the customer through the bot', async () => {
  const buyer = { id: 555777, first_name: 'Покупатель' };
  tgUsers.upsertTgUser(buyer, { chatId: buyer.id, source: 'tma' });
  const { products } = makeCatalog(1, { stock: 5 });
  const ref = { tgUserId: buyer.id };
  cart.addItem(ref, products[0].id, 1);
  const order = orders.createFromCart(ref, { customer: CUSTOMER, delivery: DELIVERY, channel: 'tma', tgUserId: buyer.id });
  await notify.flush();
  const toBuyer = () => fake.callsTo('sendMessage').filter((m) => Number(m.chat_id) === buyer.id);
  const before = toBuyer().length;

  const page = await c.get(`/admin/orders/${order.id}`);
  assert.match(page.text, /Клиент получит уведомление в Telegram/);
  await c.postForm(`/admin/orders/${order.id}/mark-paid`, {});
  await notify.flush();
  assert.equal(toBuyer().length, before + 1, 'payment confirmation sent to the customer');
  assert.ok(toBuyer().at(-1).text.includes(order.number));

  await c.postForm(`/admin/orders/${order.id}/status`, { status: 'shipped' });
  await notify.flush();
  assert.equal(toBuyer().length, before + 2, 'status change sent to the customer');
  assert.equal(orders.getOrder(order.id).status, 'shipped');

  await c.postForm(`/admin/orders/${order.id}/refund`, {});
  await notify.flush();
  assert.equal(toBuyer().length, before + 3, 'refund notice sent to the customer');
});
