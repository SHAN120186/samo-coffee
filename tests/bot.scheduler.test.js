import { FAKE_TG_PORT } from './bot.env.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeTelegram } from './helpers/fakeTelegram.js';
import { makePlan } from './helpers/fixtures.js';
import { BOT_INFO, makeUser, message, callsToChat, buttonData } from './bot.helpers.js';
import { createBot } from '../src/bot/bot.js';
import { tick, isQuietTime, startScheduler, stopScheduler } from '../src/bot/scheduler.js';
import { run } from '../src/db/index.js';
import * as orders from '../src/services/orders.js';
import * as subscriptions from '../src/services/subscriptions.js';
import * as tgUsers from '../src/services/tgUsers.js';
import * as notify from '../src/services/notify.js';

const DAY = 86_400_000;
let fake;
let bot;
let plan;

/** A Telegram user with a paid subscription whose period ends `msFromNow` from now. */
async function subscriber(id, msFromNow) {
  const user = makeUser(id);
  await bot.handleUpdate(message(user, '/start'));
  const order = orders.createSubscriptionOrder({
    planId: plan.id, customer: { name: 'Подписчик', phone: `+99890${String(id).padStart(7, '0')}` }, channel: 'bot', tgUserId: user.id,
  });
  orders.markPaid(order.id, { provider: 'mock', amount: order.total });
  await notify.flush();
  const sub = subscriptions.getCurrentForTgUser(user.id);
  run('UPDATE subscriptions SET current_period_end = ? WHERE id = ?', new Date(Date.now() + msFromNow).toISOString(), sub.id);
  return { user, sub: subscriptions.getSubscription(sub.id) };
}

before(async () => {
  fake = await startFakeTelegram(FAKE_TG_PORT);
  bot = createBot({ botInfo: BOT_INFO });
  plan = makePlan({ title: 'Дрип-клуб', price: 159000 });
});
after(async () => {
  stopScheduler();
  await fake.close();
});
beforeEach(() => fake.reset());

test('quiet hours follow the business timezone (Tashkent, UTC+5)', () => {
  assert.equal(isQuietTime(Date.parse('2026-11-25T03:30:00Z')), true, '08:30 local');
  assert.equal(isQuietTime(Date.parse('2026-11-25T04:00:00Z')), false, '09:00 local');
  assert.equal(isQuietTime(Date.parse('2026-11-25T15:59:00Z')), false, '20:59 local');
  assert.equal(isQuietTime(Date.parse('2026-11-25T16:00:00Z')), true, '21:00 local');
});

test('subscribers are reminded 3 days before the period ends — once per period, also after a restart', async () => {
  const soon = await subscriber(6001, 2.5 * DAY);
  const later = await subscriber(6002, 10 * DAY);
  fake.reset();

  // night: nothing is sent, the reminder waits for the morning
  const night = await tick({ now: Date.parse('2026-11-25T20:00:00Z') });
  assert.equal(night.skipped, 'quiet');
  assert.equal(fake.calls.length, 0);

  const first = await tick({ force: true });
  assert.equal(first.reminded, 1);
  const [reminder] = callsToChat(fake, 'sendMessage', soon.user.id);
  assert.match(reminder.text, /Подписка «Дрип-клуб» скоро закончится/);
  assert.match(reminder.text, /осталось 3 дня/);
  assert.ok(reminder.text.includes('159 000 сум'));
  assert.deepEqual(buttonData(reminder), ['renew!', 'subscription!']);
  assert.equal(callsToChat(fake, 'sendMessage', later.user.id).length, 0, 'ten days left — too early');

  // the next passes (and a restarted process: the marker lives in the database) stay silent
  fake.reset();
  assert.equal((await tick({ force: true })).reminded, 0);
  assert.equal(fake.calls.length, 0);
  assert.equal(tgUsers.getTgUser(soon.user.id).state_data._memo.subReminded[soon.sub.id], soon.sub.current_period_end);

  // the "Продлить" button of the reminder works: a new order for the same plan
  await bot.handleUpdate({
    update_id: 501, callback_query: {
      id: 'cq-renew', from: soon.user, chat_instance: 'ci', data: 'renew!',
      message: { message_id: 9, date: 1, chat: { id: soon.user.id, type: 'private' }, from: BOT_INFO, text: reminder.text },
    },
  });
  await notify.flush();
  const [renewal] = orders.listForTgUser(soon.user.id);
  assert.equal(renewal.plan_id, plan.id);
  assert.equal(renewal.payment_status, 'unpaid');

  // paid → the period moves 30 days ahead → no reminder now, a new one when that period is about to end
  orders.markPaid(renewal.id, { provider: 'mock', amount: renewal.total });
  await notify.flush();
  fake.reset();
  assert.equal((await tick({ force: true })).reminded, 0);
  run('UPDATE subscriptions SET current_period_end = ? WHERE id = ?', new Date(Date.now() + 1 * DAY).toISOString(), soon.sub.id);
  assert.equal((await tick({ force: true })).reminded, 1);
  assert.match(callsToChat(fake, 'sendMessage', soon.user.id)[0].text, /остался 1 день/);
});

test('an ended subscription is marked expired and the customer is told once', async () => {
  const { user, sub } = await subscriber(6003, -3_600_000);
  fake.reset();
  const result = await tick({ force: true });
  assert.equal(result.expired, 1);
  assert.equal(result.expiredNotified, 1);
  assert.equal(subscriptions.getSubscription(sub.id).status, 'expired');
  const [notice] = callsToChat(fake, 'sendMessage', user.id);
  assert.match(notice.text, /Подписка «Дрип-клуб» закончилась/);
  assert.deepEqual(buttonData(notice), [`sub:${plan.id}!`, 'plans!']);

  fake.reset();
  const again = await tick({ force: true });
  assert.equal(again.expired, 0);
  assert.equal(again.expiredNotified, 0);
  assert.equal(fake.calls.length, 0);
});

test('two subscriptions of one customer that expired within days of each other are announced once each', async () => {
  // a short plan: expire → subscribe again → expire again inside the 3-day notice window
  const { user, sub } = await subscriber(6010, -2 * 3_600_000);
  await tick({ force: true });
  assert.equal(subscriptions.getSubscription(sub.id).status, 'expired');
  const again = orders.createSubscriptionOrder({ planId: plan.id, customer: { name: 'Подписчик', phone: '+998900006010' }, channel: 'bot', tgUserId: user.id });
  orders.markPaid(again.id, { provider: 'mock', amount: again.total });
  await notify.flush();
  const second = subscriptions.getCurrentForTgUser(user.id);
  assert.notEqual(second.id, sub.id);
  run('UPDATE subscriptions SET current_period_end = ? WHERE id = ?', new Date(Date.now() - 3_600_000).toISOString(), second.id);

  fake.reset();
  const first = await tick({ force: true });
  assert.equal(first.expiredNotified, 1, 'the second expiry is announced');
  const memo = tgUsers.getTgUser(user.id).state_data._memo.subExpired;
  assert.deepEqual(Object.keys(memo).sort(), [String(sub.id), String(second.id)].sort(), 'both marks are kept');

  // every later pass is silent — no "подписка закончилась" twice an hour for three days
  for (let i = 0; i < 3; i += 1) {
    fake.reset();
    const next = await tick({ force: true });
    assert.equal(next.expiredNotified, 0, `pass ${i + 2}`);
    assert.equal(callsToChat(fake, 'sendMessage', user.id).length, 0);
  }

  // marks of periods that ended long ago are dropped, the fresh ones stay
  const row = tgUsers.getTgUser(user.id);
  tgUsers.setTgState(user.id, row.state, { ...row.state_data, _memo: { ...row.state_data._memo, subExpired: { ...memo, 999999: new Date(Date.now() - 30 * DAY).toISOString() } } });
  run('UPDATE subscriptions SET current_period_end = ? WHERE id = ?', new Date(Date.now() - 1_800_000).toISOString(), second.id);
  await tick({ force: true });
  const pruned = tgUsers.getTgUser(user.id).state_data._memo.subExpired;
  assert.equal(pruned['999999'], undefined);
  assert.ok(pruned[String(sub.id)] && pruned[String(second.id)]);
});

test('users who blocked the bot are skipped and marked; flood limits do not lose the reminder', async () => {
  const blocked = await subscriber(6004, 1.5 * DAY);
  const limited = await subscriber(6005, 1.5 * DAY);
  fake.reset();
  let limitedAttempts = 0;
  fake.on('sendMessage', (p) => {
    if (String(p.chat_id) === String(blocked.user.id)) return { error_code: 403, description: 'Forbidden: bot was blocked by the user' };
    if (String(p.chat_id) === String(limited.user.id)) {
      limitedAttempts += 1;
      return { error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } };
    }
    return { message_id: 1, date: 1, chat: { id: Number(p.chat_id), type: 'private' }, text: p.text };
  });
  const result = await tick({ force: true });
  assert.equal(result.reminded, 0);
  assert.equal(tgUsers.getTgUser(blocked.user.id).is_blocked, 1);
  assert.equal(limitedAttempts, 1);

  // next pass: the blocked user is left alone, the flood-limited one gets the reminder
  fake.reset();
  const next = await tick({ force: true });
  assert.equal(next.reminded, 1);
  assert.equal(callsToChat(fake, 'sendMessage', blocked.user.id).length, 0);
  assert.equal(callsToChat(fake, 'sendMessage', limited.user.id).length, 1);
});

test('the timer can be started and stopped repeatedly without leaking', () => {
  startScheduler({ intervalMs: 3_600_000, initialDelayMs: 3_600_000 });
  startScheduler();
  stopScheduler();
  stopScheduler();
});
