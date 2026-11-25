// Mini App support: messages become a feedback thread (channel "tma"), are forwarded to the admin
// chat, and admin answers come back through the bot and into the Mini App conversation.
import { FAKE_TG_PORT, ADMIN_CHAT_ID } from './helpers/env-telegram.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/http.js';
import { startFakeTelegram } from './helpers/fakeTelegram.js';
import { all } from '../src/db/index.js';
import * as feedback from '../src/services/feedback.js';
import { tmaClient, tgUser } from './tma.helpers.js';

let t;
let fake;
before(async () => {
  fake = await startFakeTelegram(FAKE_TG_PORT);
  t = await startTestApp();
});
after(async () => {
  await t.close();
  await fake.close();
});

test('feedback requires a Mini App user and a real message', async () => {
  assert.equal((await tmaClient(t.baseUrl, null).post('/feedback', { text: 'Привет' })).status, 401);
  const api = tmaClient(t.baseUrl, tgUser());
  for (const body of [{}, { text: '' }, { text: '   ' }, { text: 'a' }, { text: { evil: true } }]) {
    const res = await api.post('/feedback', body);
    assert.equal(res.status, 422, JSON.stringify(body));
    assert.equal(res.body.error, 'validation');
    assert.ok(res.body.details.fields.text);
  }
  assert.deepEqual((await api.get('/feedback')).body, { ok: true, thread: null, messages: [] });
});

test('a message opens a "tma" thread, is forwarded to admins, and the answer comes back', async () => {
  const user = tgUser({ first_name: 'Дильноза', last_name: '', username: 'dilnoza_t' });
  const api = tmaClient(t.baseUrl, user);
  fake.reset();

  const first = await api.post('/feedback', { text: 'Здравствуйте! Какой помол нужен для гейзерной кофеварки?' });
  assert.equal(first.status, 201);
  assert.equal(first.body.isNew, true);
  assert.equal(first.body.message.direction, 'in');
  assert.equal(first.body.thread.status, 'open');
  assert.equal(first.body.messages.length, 1);

  const thread = feedback.getThread(first.body.thread.id);
  assert.equal(thread.channel, 'tma');
  assert.equal(thread.tg_user_id, user.id);
  assert.equal(thread.tg_chat_id, user.id, 'answers go to the private chat with the bot');
  assert.equal(thread.name, 'Дильноза');
  assert.equal(thread.contact, '@dilnoza_t');
  assert.equal(thread.can_deliver, true);

  // forwarded to the admin chat with the reply hint
  const forwarded = fake.callsTo('sendMessage').filter((m) => String(m.chat_id) === ADMIN_CHAT_ID);
  assert.equal(forwarded.length, 1);
  assert.match(forwarded[0].text, /Мини-приложение/);
  assert.match(forwarded[0].text, /гейзерной кофеварки/);
  assert.equal(all('SELECT * FROM events WHERE name = ? AND tg_user_id = ?', 'feedback', user.id)[0].channel, 'tma');

  // the second message continues the same thread
  const second = await api.post('/feedback', { text: 'И ещё: есть ли доставка в Чирчик?' });
  assert.equal(second.body.isNew, false);
  assert.equal(second.body.thread.id, thread.id);
  assert.deepEqual(second.body.messages.map((m) => m.direction), ['in', 'in']);

  // an admin replies to the forwarded message in the admin chat → the bot maps it to the thread
  const adminMessageId = feedback.getThread(thread.id).messages[1].admin_chat_message_id;
  assert.ok(adminMessageId, 'the forwarded message id is remembered for reply mapping');
  assert.equal(feedback.findThreadByAdminMessageId(adminMessageId).id, thread.id);
  const reply = await feedback.reply(thread.id, { text: 'Средний, как для воронки. В Чирчик возим по субботам.', via: 'telegram' });
  assert.equal(reply.delivered, true);
  const toUser = fake.callsTo('sendMessage').filter((m) => Number(m.chat_id) === user.id);
  assert.equal(toUser.length, 1);
  assert.match(toUser[0].text, /В Чирчик возим по субботам/);

  const conversation = await api.get('/feedback');
  assert.equal(conversation.status, 200);
  assert.equal(conversation.body.thread.status, 'answered');
  assert.deepEqual(conversation.body.messages.map((m) => m.direction), ['in', 'in', 'out']);
  const out = conversation.body.messages[2];
  assert.deepEqual(Object.keys(out).sort(), ['created_at', 'direction', 'id', 'text', 'thread_id'], 'no admin names or Telegram ids leak to the client');

  // other users never see this conversation
  assert.deepEqual((await tmaClient(t.baseUrl, tgUser()).get('/feedback')).body.messages, []);

  // after the thread is closed a new message starts a new thread, the history stays visible
  feedback.setThreadStatus(thread.id, 'closed');
  const third = await api.post('/feedback', { text: 'Спасибо, заказал!' });
  assert.equal(third.body.isNew, true);
  assert.notEqual(third.body.thread.id, thread.id);
  assert.equal(third.body.messages.length, 4);
});

test('messages are trimmed, length-limited and stored as plain text', async () => {
  const user = tgUser();
  const api = tmaClient(t.baseUrl, user);
  const res = await api.post('/feedback', { text: `  <b>Привет</b> <script>alert(1)</script>${'я'.repeat(5000)}  ` });
  assert.equal(res.status, 201);
  assert.equal(res.body.message.text.length, feedback.MAX_MESSAGE_LENGTH);
  assert.ok(res.body.message.text.startsWith('<b>Привет</b> <script>'), 'stored verbatim — the client and the bot escape on output');
  const forwarded = fake.callsTo('sendMessage').filter((m) => String(m.chat_id) === ADMIN_CHAT_ID).pop();
  assert.ok(forwarded.text.includes('&lt;script&gt;'), 'escaped for Telegram HTML');
});

test('feedback is rate limited per user', async () => {
  const api = tmaClient(t.baseUrl, tgUser());
  const statuses = [];
  for (let i = 0; i < 8; i += 1) statuses.push((await api.post('/feedback', { text: `Сообщение номер ${i + 1}` })).status);
  assert.deepEqual(statuses, [201, 201, 201, 201, 201, 201, 429, 429]);
  assert.equal((await api.get('/feedback')).body.messages.length, 6);
});
