import { FAKE_TG_PORT, WEBHOOK_SECRET } from './bot.env-webhook.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeTelegram } from './helpers/fakeTelegram.js';
import { startTestApp } from './helpers/http.js';
import { makeCatalog } from './helpers/fixtures.js';
import { makeUser, message, callsToChat, lastText, buttons } from './bot.helpers.js';
import { whenBotReady, stopBot, webhookSecret, getBot } from '../src/bot/index.js';
import { ALLOWED_UPDATES } from '../src/bot/bot.js';
import * as tgUsers from '../src/services/tgUsers.js';

let fake;
let t;

const post = (update, headers = {}) => fetch(`${t.baseUrl}/bot/webhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: typeof update === 'string' ? update : JSON.stringify(update),
});
const withSecret = { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET };

before(async () => {
  fake = await startFakeTelegram(FAKE_TG_PORT);
  makeCatalog(2);
  t = await startTestApp({ bot: true });
});
after(async () => {
  await stopBot();
  await t.close();
  await fake.close();
});

test('webhook mode: the bot connects, registers the webhook with a secret and does not poll', async () => {
  assert.equal(await whenBotReady(), true);
  assert.ok(getBot().isInited());
  assert.equal(webhookSecret(), WEBHOOK_SECRET);

  const [hook] = fake.callsTo('setWebhook');
  assert.equal(hook.url, 'https://shop.samo-test.example/bot/webhook');
  assert.equal(hook.secret_token, WEBHOOK_SECRET);
  assert.deepEqual(hook.allowed_updates, ALLOWED_UPDATES);
  assert.equal(fake.callsTo('deleteWebhook').length, 0);
  assert.equal(getBot().isRunning(), false, 'no long polling in webhook mode');

  // profile: commands for customers and for the admin chat, the menu button opens the Mini App (HTTPS)
  const commands = fake.callsTo('setMyCommands');
  assert.deepEqual(commands[0].scope, { type: 'all_private_chats' });
  assert.ok(commands[0].commands.some((c) => c.command === 'catalog'));
  assert.equal(commands[1].scope.type, 'chat');
  assert.deepEqual(commands[1].commands.map((c) => c.command), ['stats', 'orders', 'help']);
  const [menu] = fake.callsTo('setChatMenuButton');
  assert.deepEqual(menu.menu_button, { type: 'web_app', text: 'Открыть магазин', web_app: { url: 'https://shop.samo-test.example/tma/' } });
});

test('POST /bot/webhook requires the secret token', async () => {
  const user = makeUser(5001);
  fake.reset();

  let res = await post(message(user, '/start'));
  assert.equal(res.status, 401);
  res = await post(message(user, '/start'), { 'x-telegram-bot-api-secret-token': 'wrong-secret' });
  assert.equal(res.status, 401);
  res = await post(message(user, '/start'), { 'x-telegram-bot-api-secret-token': `${WEBHOOK_SECRET}x` });
  assert.equal(res.status, 401);
  assert.equal(fake.calls.length, 0, 'unauthenticated updates are not processed');
  assert.equal(tgUsers.getTgUser(user.id), null);

  // GET and CSRF: the route is POST-only and needs no CSRF token (Telegram cannot send one)
  assert.equal((await fetch(`${t.baseUrl}/bot/webhook`)).status, 404);

  const update = message(user, '/start');
  res = await post(update, withSecret);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.ok(tgUsers.getTgUser(user.id), 'the update was handled before the response');
  assert.match(callsToChat(fake, 'sendMessage', user.id)[0].text, /Здравствуйте/);
  assert.equal(res.headers.get('set-cookie'), null, 'no cookies on the webhook');

  // Telegram repeats a delivery → processed once
  const sentBefore = fake.calls.length;
  res = await post(update, withSecret);
  assert.equal(res.status, 200);
  assert.equal(fake.calls.length, sentBefore);

  // garbage with a valid secret
  assert.equal((await post({ hello: 'world' }, withSecret)).status, 400);
  assert.equal((await post('not json', withSecret)).status, 400);
});

test('with an HTTPS address the shop button opens the Mini App', async () => {
  const user = makeUser(5002);
  fake.reset();
  const res = await post(message(user, '/catalog'), withSecret);
  assert.equal(res.status, 200);
  const catalogMessage = lastText(fake, user.id);
  const shop = buttons(catalogMessage).find((b) => b.web_app);
  assert.deepEqual(shop, { text: '🛍 Открыть магазин', web_app: { url: 'https://shop.samo-test.example/tma/' } });
});

test('a handler error is logged and answered with 200 (no endless redelivery); after stopBot the route answers 503', async () => {
  const user = makeUser(5003);
  fake.reset();
  fake.on('sendMessage', () => ({ error_code: 400, description: 'Bad Request: something is wrong' }));
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  let res;
  try {
    res = await post(message(user, '/help'), withSecret);
  } finally {
    console.error = original;
  }
  assert.equal(res.status, 200);
  assert.ok(errors.some((e) => /Bot API error 400 in sendMessage/.test(e)));
  fake.off('sendMessage');

  await stopBot();
  await stopBot(); // safe to call twice
  res = await post(message(user, '/help'), withSecret);
  assert.equal(res.status, 503);
});
