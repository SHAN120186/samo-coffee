import { FAKE_TG_PORT, ADMIN_CHAT_ID } from './bot.env.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeTelegram } from './helpers/fakeTelegram.js';
import { makeCatalog, CUSTOMER, DELIVERY } from './helpers/fixtures.js';
import { BOT_INFO, STAFF, makeUser, message, groupMessage, callsToChat, lastText, buttonData } from './bot.helpers.js';
import { createBot } from '../src/bot/bot.js';
import { supportLimiter } from '../src/bot/handlers/support.js';
import * as feedback from '../src/services/feedback.js';
import * as auth from '../src/services/auth.js';
import * as cart from '../src/services/cart.js';
import * as orders from '../src/services/orders.js';
import * as tgUsers from '../src/services/tgUsers.js';
import * as notify from '../src/services/notify.js';
import { get } from '../src/db/index.js';

let fake;
let bot;

const send = async (update) => {
  await bot.handleUpdate(update);
  await notify.flush();
};
/** The message the bot put into the admin chat for the latest customer message (with its fake message_id). */
function trackAdminMessages() {
  let id = 880000;
  const sent = [];
  const record = (method) => (p) => {
    id += 1;
    if (String(p.chat_id) === String(ADMIN_CHAT_ID)) sent.push({ method, message_id: id, params: p });
    return { message_id: id, date: 1, chat: { id: Number(p.chat_id), type: 'private' }, text: p.text };
  };
  fake.on('sendMessage', record('sendMessage'));
  fake.on('copyMessage', record('copyMessage'));
  return sent;
}

before(async () => {
  fake = await startFakeTelegram(FAKE_TG_PORT);
  bot = createBot({ botInfo: BOT_INFO });
});
after(async () => {
  await fake.close();
});
beforeEach(() => fake.reset());

test('a customer message is stored as a feedback thread, forwarded to the admin chat with a header and confirmed', async () => {
  const user = makeUser(8001, { first_name: 'Тимур', last_name: '', username: 'timur_t' });
  const adminMessages = trackAdminMessages();
  await send(message(user, '/start'));
  await send(message(user, '💬 Поддержка'));
  assert.equal(tgUsers.getTgUser(user.id).state, 'support');
  assert.match(lastText(fake, user.id).text, /Напишите ваш вопрос/);

  fake.calls.length = 0;
  const question = message(user, 'Здравствуйте! Чем <Кения> отличается от Эфиопии & что взять для воронки?');
  await send(question);

  // stored
  const [thread] = feedback.listThreads({ tgUserId: user.id }).items;
  assert.equal(thread.channel, 'bot');
  assert.equal(thread.status, 'open');
  assert.equal(thread.name, 'Тимур');
  assert.equal(thread.contact, '@timur_t');
  assert.equal(thread.tg_chat_id, user.id);
  const stored = feedback.getThread(thread.id).messages;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].direction, 'in');
  assert.equal(stored[0].text, 'Здравствуйте! Чем <Кения> отличается от Эфиопии & что взять для воронки?');
  assert.equal(stored[0].tg_message_id, question.message.message_id);
  assert.ok(get(`SELECT id FROM events WHERE name = 'feedback' AND channel = 'bot' AND tg_user_id = ?`, user.id));

  // forwarded once: header (name, @username, thread id) + escaped text + reply hint
  const forwarded = adminMessages.filter((m) => m.method === 'sendMessage');
  assert.equal(forwarded.length, 1);
  const { text } = forwarded[0].params;
  assert.ok(text.includes(`Обращение #${thread.id}`));
  assert.ok(text.includes('Тимур · @timur_t · id <code>8001</code>'));
  assert.ok(text.includes('Чем &lt;Кения&gt; отличается от Эфиопии &amp; что взять'));
  assert.match(text, /Ответьте на это сообщение/);
  assert.equal(forwarded[0].params.parse_mode, 'HTML');
  assert.ok(buttonData(forwarded[0].params).includes(`fb:close:${thread.id}`));
  assert.equal(stored[0].admin_chat_message_id, forwarded[0].message_id, 'the admin-chat message id is remembered for reply mapping');

  // confirmed to the customer
  const confirmation = lastText(fake, user.id);
  assert.match(confirmation.text, /Передали сообщение команде/);
  assert.equal(confirmation.reply_parameters.message_id, question.message.message_id);

  // the next message joins the same thread (and is not confirmed again within the burst)
  fake.calls.length = 0;
  await send(message(user, 'И ещё: есть ли доставка в Самарканд?'));
  assert.equal(feedback.listThreads({ tgUserId: user.id }).total, 1);
  assert.equal(feedback.getThread(thread.id).messages.length, 2);
  assert.equal(callsToChat(fake, 'sendMessage', user.id).length, 0);
  assert.equal(callsToChat(fake, 'sendMessage', ADMIN_CHAT_ID).length, 1);
});

test('free text outside any flow also reaches support; photos and files are copied with the header as caption', async () => {
  const user = makeUser(8002);
  const adminMessages = trackAdminMessages();
  await send(message(user, 'Привет, это вопрос без кнопки «Поддержка»'));
  const [thread] = feedback.listThreads({ tgUserId: user.id }).items;
  assert.ok(thread, 'a thread is opened without /start and without support mode');
  assert.ok(tgUsers.getTgUser(user.id), 'the Telegram user is registered on the first message');

  const photo = message(user, null, {
    photo: [{ file_id: 'small_id', width: 90, height: 90 }, { file_id: 'AgACAgIAAxkBAAIBIG_big', width: 1280, height: 960 }],
    caption: 'Пачка пришла <помятая>',
  });
  await send(photo);
  const messages = feedback.getThread(thread.id).messages;
  assert.equal(messages.length, 2);
  assert.equal(messages[1].text, '📷 Фото\nПачка пришла <помятая>\n[file_id: AgACAgIAAxkBAAIBIG_big]', 'the largest photo is stored by file_id');

  const copy = adminMessages.find((m) => m.method === 'copyMessage');
  assert.equal(String(copy.params.from_chat_id), String(user.id));
  assert.equal(copy.params.message_id, photo.message.message_id);
  assert.ok(copy.params.caption.includes(`Обращение #${thread.id}`));
  assert.ok(copy.params.caption.includes('Пачка пришла &lt;помятая&gt;'));
  assert.equal(copy.params.parse_mode, 'HTML');
  assert.equal(messages[1].admin_chat_message_id, copy.message_id);

  await send(message(user, null, { document: { file_id: 'BQACAgIAAxkBAAIDoc', file_name: 'чек.pdf', mime_type: 'application/pdf' } }));
  assert.equal(feedback.getThread(thread.id).messages[2].text, '📎 Файл «чек.pdf»\n[file_id: BQACAgIAAxkBAAIDoc]');

  // a sticker cannot carry a caption: header message (mapped) + the copy as a reply to it
  const before = adminMessages.length;
  await send(message(user, null, { sticker: { file_id: 'CAACAgIAAxkBAAIsticker', emoji: '☕', width: 512, height: 512 } }));
  const [header, stickerCopy] = adminMessages.slice(before);
  assert.equal(header.method, 'sendMessage');
  assert.ok(header.params.text.includes('Стикер ☕'));
  assert.equal(stickerCopy.method, 'copyMessage');
  assert.equal(stickerCopy.params.reply_parameters.message_id, header.message_id);

  // the admin may answer either of the two messages
  fake.calls.length = 0;
  await send(groupMessage(STAFF, 'Спасибо за стикер!', { reply_to_message: { message_id: stickerCopy.message_id, date: 1, chat: { id: Number(ADMIN_CHAT_ID), type: 'supergroup' } } }));
  assert.ok(lastText(fake, user.id).text.includes('Спасибо за стикер!'));
});

test('an admin answers by replying in the admin chat: the customer gets the answer and it is stored', async () => {
  const user = makeUser(8003);
  const adminMessages = trackAdminMessages();
  await send(message(user, 'Когда будет свежая Кения?'));
  const [thread] = feedback.listThreads({ tgUserId: user.id }).items;
  const forwardedId = adminMessages.at(-1).message_id;

  fake.calls.length = 0;
  const answer = groupMessage(STAFF, 'Обжариваем в пятницу <утром> — к вечеру привезём & напишем.', {
    reply_to_message: { message_id: forwardedId, date: 1, chat: { id: Number(ADMIN_CHAT_ID), type: 'supergroup' }, from: BOT_INFO, text: 'Обращение' },
  });
  await send(answer);

  // delivered to the customer
  const [delivered] = callsToChat(fake, 'sendMessage', user.id);
  assert.ok(delivered.text.includes('Ответ Samo Coffee'));
  assert.ok(delivered.text.includes('Обжариваем в пятницу &lt;утром&gt; — к вечеру привезём &amp; напишем.'));
  // stored as an outgoing message
  const fresh = feedback.getThread(thread.id);
  const out = fresh.messages.at(-1);
  assert.equal(out.direction, 'out');
  assert.equal(out.via, 'telegram');
  assert.equal(out.delivered, 1);
  assert.equal(out.text, 'Обжариваем в пятницу <утром> — к вечеру привезём & напишем.');
  assert.equal(fresh.status, 'answered');
  assert.equal(fresh.unread, 0);
  // the admin sees a confirmation under the answer
  const confirmation = lastText(fake, ADMIN_CHAT_ID);
  assert.match(confirmation.text, new RegExp(`Ответ доставлен · обращение #${thread.id}`));
  assert.equal(confirmation.reply_parameters.message_id, answer.message.message_id);

  // the customer writes back → same thread, open again
  await send(message(user, 'Отлично, жду!'));
  const reopened = feedback.getThread(thread.id);
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.messages.length, 3);

  // a photo answer: the text part goes through the service, the picture is copied to the customer
  fake.calls.length = 0;
  const photoAnswer = groupMessage(STAFF, null, {
    photo: [{ file_id: 'p1', width: 10, height: 10 }], caption: 'Вот так выглядит пачка',
    reply_to_message: { message_id: adminMessages.at(-1).message_id, date: 1, chat: { id: Number(ADMIN_CHAT_ID), type: 'supergroup' } },
  });
  await send(photoAnswer);
  assert.ok(lastText(fake, user.id).text.includes('📷 Фото: Вот так выглядит пачка'));
  const [copied] = callsToChat(fake, 'copyMessage', user.id);
  assert.equal(copied.message_id, photoAnswer.message.message_id);
  assert.equal(String(copied.from_chat_id), String(ADMIN_CHAT_ID));
});

test('a reply from the admin panel reaches the customer through the bot', async () => {
  const user = makeUser(8004);
  await send(message(user, 'Можно ли изменить адрес доставки?'));
  const [thread] = feedback.listThreads({ tgUserId: user.id }).items;
  const admin = auth.listAdmins()[0] || auth.createAdmin({ email: 'boss@samo.coffee', password: 'password-123', name: 'Владелец', role: 'owner' });

  fake.calls.length = 0;
  const result = await feedback.reply(thread.id, { text: 'Да, напишите новый адрес — поправим.', adminId: admin.id, via: 'panel' });
  assert.equal(result.delivered, true);
  const [delivered] = callsToChat(fake, 'sendMessage', user.id);
  assert.ok(delivered.text.includes('Да, напишите новый адрес — поправим.'));
  const out = feedback.getThread(thread.id).messages.at(-1);
  assert.equal(out.via, 'panel');
  assert.equal(out.admin_id, admin.id);
  assert.equal(out.delivered, 1);

  // the customer blocked the bot → the answer is kept, the user is marked inactive, the admin is told
  const adminMessages = trackAdminMessages();
  await send(message(user, 'Новый адрес: Ташкент, Юнусабад, 4-12'));
  fake.on('sendMessage', (p) => (String(p.chat_id) === String(user.id)
    ? { error_code: 403, description: 'Forbidden: bot was blocked by the user' }
    : { message_id: 1, date: 1, chat: { id: Number(p.chat_id), type: 'supergroup' }, text: p.text }));
  fake.calls.length = 0;
  await send(groupMessage(STAFF, 'Записали!', { reply_to_message: { message_id: adminMessages.at(-1).message_id, date: 1, chat: { id: Number(ADMIN_CHAT_ID), type: 'supergroup' } } }));
  assert.equal(tgUsers.getTgUser(user.id).is_blocked, 1);
  assert.equal(feedback.getThread(thread.id).messages.at(-1).delivered, 0);
  assert.match(lastText(fake, ADMIN_CHAT_ID).text, /заблокировал бота/);
});

test('threads from the site form can be answered from the admin chat too (stored, not deliverable)', async () => {
  const { thread, message: first } = await feedback.createThread({ channel: 'site', name: 'Лола', contact: 'lola@example.com', text: 'Хочу оптовый прайс' });
  await notify.flush();
  const forwardedId = feedback.getThread(thread.id).messages[0].admin_chat_message_id;
  assert.ok(forwardedId, 'the service forwarded the site message to the admin chat');
  assert.equal(first.thread_id, thread.id);

  fake.calls.length = 0;
  await send(groupMessage(STAFF, 'Отправили прайс на почту.', { reply_to_message: { message_id: forwardedId, date: 1, chat: { id: Number(ADMIN_CHAT_ID), type: 'supergroup' } } }));
  assert.equal(feedback.getThread(thread.id).messages.at(-1).text, 'Отправили прайс на почту.');
  const note = lastText(fake, ADMIN_CHAT_ID);
  assert.match(note.text, /клиент писал с сайта/);
  assert.ok(note.text.includes('lola@example.com'));
});

test('admin chat: /stats, /orders, closing a thread; ordinary group talk is ignored', async () => {
  const { products } = makeCatalog(1);
  const ref = { token: cart.newToken() };
  cart.addItem(ref, products[0].id, 2);
  const order = orders.createFromCart(ref, { customer: CUSTOMER, delivery: DELIVERY });
  orders.markPaid(order.id, { provider: 'mock', amount: order.total });
  await notify.flush();

  fake.calls.length = 0;
  await send(groupMessage(STAFF, '/stats'));
  const stats = lastText(fake, ADMIN_CHAT_ID);
  assert.match(stats.text, /📊 <b>Сегодня, \d+ [а-я]+ \d{4}<\/b>/);
  assert.match(stats.text, /Заказы: <b>1<\/b>, оплачено 1/);
  assert.ok(stats.text.includes('Выручка: <b>225 000 сум</b>'));
  assert.match(stats.text, /Посетители: <b>\d+<\/b>/);

  await send(groupMessage(STAFF, '/orders@samo_test_bot'));
  const last = lastText(fake, ADMIN_CHAT_ID);
  assert.match(last.text, /Последние заказы/);
  assert.ok(last.text.includes(order.number));
  assert.ok(last.text.includes('оплачен'));

  // "✅ Закрыть обращение" under a forwarded message
  const { thread } = await feedback.createThread({ channel: 'site', name: 'Тест', contact: 't@example.com', text: 'Закройте меня' });
  await notify.flush();
  fake.calls.length = 0;
  await send({
    update_id: 77, callback_query: {
      id: 'cq-close', from: STAFF, chat_instance: 'ci', data: `fb:close:${thread.id}`,
      message: { message_id: 10, date: 1, chat: { id: Number(ADMIN_CHAT_ID), type: 'supergroup' }, from: BOT_INFO, text: 'Обращение' },
    },
  });
  assert.equal(feedback.getThread(thread.id).status, 'closed');
  assert.match(fake.callsTo('answerCallbackQuery')[0].text, /закрыто/);

  // staff talking to each other, or replying to something that is not a customer message
  fake.calls.length = 0;
  const threadsBefore = feedback.listThreads().total;
  await send(groupMessage(STAFF, 'Коллеги, кто сегодня на обжарке?'));
  await send(groupMessage(STAFF, 'Я!', { reply_to_message: { message_id: 123456789, date: 1, chat: { id: Number(ADMIN_CHAT_ID), type: 'supergroup' }, from: STAFF, text: 'Коллеги' } }));
  assert.equal(fake.calls.length, 0);
  assert.equal(feedback.listThreads().total, threadsBefore, 'staff chatter never becomes a customer thread');
  assert.equal(tgUsers.getTgUser(STAFF.id), null);

  // customers cannot use admin commands
  const user = makeUser(8005);
  await send(message(user, '/stats'));
  assert.match(lastText(fake, user.id).text, /Не знаю такой команды/);
});

test('one customer cannot flood the inbox: 30 messages per 10 minutes, then one polite notice', async () => {
  const user = makeUser(8007);
  for (let i = 1; i <= 30; i += 1) await bot.handleUpdate(message(user, `сообщение ${i}`));
  const [thread] = feedback.listThreads({ tgUserId: user.id }).items;
  assert.equal(feedback.getThread(thread.id).messages.length, 30);

  fake.calls.length = 0;
  await send(message(user, 'сообщение 31'));
  await send(message(user, 'сообщение 32'));
  assert.equal(feedback.getThread(thread.id).messages.length, 30, 'nothing more is stored');
  assert.equal(callsToChat(fake, 'sendMessage', ADMIN_CHAT_ID).length, 0, 'nothing more is forwarded');
  const notices = callsToChat(fake, 'sendMessage', user.id);
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /слишком много подряд/);
  supportLimiter.reset(String(user.id));
});

test('a broken admin chat does not lose the customer message', async () => {
  const user = makeUser(8006);
  fake.on('sendMessage', (p) => (String(p.chat_id) === String(ADMIN_CHAT_ID)
    ? { error_code: 400, description: 'Bad Request: chat not found' }
    : { message_id: 5, date: 1, chat: { id: Number(p.chat_id), type: 'private' }, text: p.text }));
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await send(message(user, 'Вы меня слышите?'));
  } finally {
    console.error = original;
  }
  assert.equal(feedback.listThreads({ tgUserId: user.id }).total, 1);
  assert.match(lastText(fake, user.id).text, /Передали сообщение команде/);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /cannot forward feedback/);
});
