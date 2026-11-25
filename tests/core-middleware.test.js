// Exercises the shared middleware the way module routers will use it:
// admin auth guard, flash messages, CSRF with multipart uploads, rate limiting.
import { FAKE_TG_PORT } from './helpers/env-telegram.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from '../src/config.js';
import { run } from '../src/db/index.js';
import { csrfProtection } from '../src/lib/csrf.js';
import { flashMiddleware } from '../src/lib/flash.js';
import { rateLimit } from '../src/lib/ratelimit.js';
import * as auth from '../src/services/auth.js';
import * as media from '../src/services/media.js';
import * as broadcasts from '../src/services/broadcasts.js';
import * as tgUsers from '../src/services/tgUsers.js';
import { createClient } from './helpers/http.js';
import { startFakeTelegram } from './helpers/fakeTelegram.js';

let server;
let baseUrl;
let fake;

before(async () => {
  fake = await startFakeTelegram(FAKE_TG_PORT);
  auth.ensureDefaultAdmin();
  const app = express();
  app.use(cookieParser(config.sessionSecret));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(flashMiddleware());
  app.use(csrfProtection({ ignore: [/^\/api\//] }));
  const admin = express.Router();
  admin.use(auth.loadAdmin);
  admin.get('/login', (req, res) => res.send(`<form>${res.locals.csrfField}</form>${JSON.stringify(res.locals.flash)}`));
  admin.post('/login', rateLimit({ windowMs: 60000, max: 50 }), (req, res) => {
    const r = auth.login(req.body.email, req.body.password, { ip: req.ip, userAgent: req.get('user-agent') });
    if (!r.ok) {
      req.flash('error', 'Неверный e-mail или пароль');
      return res.redirect('/admin/login');
    }
    auth.setSessionCookie(res, r.token);
    return res.redirect(auth.safeNext(req.body.next));
  });
  admin.use(auth.requireAdmin);
  admin.get('/', (req, res) => res.send(`<form>${res.locals.csrfField}</form>hello ${req.admin.email} ${JSON.stringify(res.locals.flash)}`));
  admin.get('/owner-only', auth.requireRole('manager'), (req, res) => res.send('nope'));
  admin.post('/media', media.upload.array('files', 5), (req, res, next) => {
    try {
      const rows = req.files.map((f) => media.registerUpload(f, { adminId: req.admin.id }));
      req.flash('success', `Загружено: ${rows.length}`);
      res.json({ ok: true, items: rows });
    } catch (err) {
      media.discardUploads(req.files);
      next(err);
    }
  });
  admin.post('/logout', (req, res) => {
    auth.logout(req.adminToken);
    auth.clearSessionCookie(res);
    res.redirect('/admin/login');
  });
  app.use('/admin', admin);
  app.get('/limited', rateLimit({ windowMs: 60000, max: 2 }), (req, res) => res.send('ok'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.code, message: media.uploadErrorMessage(err) }));
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await fake.close();
  fs.rmSync(config.uploads.dir, { recursive: true, force: true });
});

test('admin guard, login with flash, role check, logout', async () => {
  const c = createClient(baseUrl);
  const guarded = await c.get('/admin/?tab=1');
  assert.equal(guarded.status, 302);
  assert.equal(guarded.location, '/admin/login?next=%2Fadmin%2F%3Ftab%3D1');
  const xhr = await c.get('/admin/', { headers: { accept: 'application/json' } });
  assert.equal(xhr.status, 401);

  await c.get('/admin/login');
  const bad = await c.postForm('/admin/login', { email: 'admin@samo.coffee', password: 'wrong' });
  assert.equal(bad.status, 302);
  const loginPage = await c.get('/admin/login');
  assert.ok(loginPage.text.includes('Неверный e-mail или пароль'), 'flash shown once');
  assert.ok(!(await c.get('/admin/login')).text.includes('Неверный'), 'flash consumed');

  const ok = await c.postForm('/admin/login', { email: 'admin@samo.coffee', password: 'admin12345', next: '/admin/' });
  assert.equal(ok.status, 302);
  assert.equal(ok.location, '/admin/');
  assert.ok(c.jar.get('sc_admin').startsWith('s%3A'), 'session cookie is signed');
  const home = await c.get('/admin/');
  assert.equal(home.status, 200);
  assert.ok(home.text.includes('hello admin@samo.coffee'));
  assert.equal(home.headers.get('cache-control'), 'no-store');
  assert.equal((await c.get('/admin/owner-only')).status, 403);

  // forged cookie is ignored
  const forged = createClient(baseUrl);
  forged.jar.set('sc_admin', 'made-up-token');
  assert.equal((await forged.get('/admin/')).status, 302);

  const out = await c.postForm('/admin/logout');
  assert.equal(out.status, 302);
  assert.equal((await c.get('/admin/')).status, 302);
});

test('multipart upload: CSRF via query string, type validation', async () => {
  const c = createClient(baseUrl);
  await c.get('/admin/login');
  await c.postForm('/admin/login', { email: 'admin@samo.coffee', password: 'admin12345' });
  await c.get('/admin/');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const form = () => {
    const fd = new FormData();
    fd.append('files', new Blob([png], { type: 'image/png' }), 'bag.png');
    return fd;
  };
  const noToken = await c.request('POST', '/admin/media', { body: form() });
  assert.equal(noToken.status, 403);

  const ok = await c.request('POST', `/admin/media?_csrf=${encodeURIComponent(c.csrfToken)}`, { body: form() });
  assert.equal(ok.status, 200);
  const item = ok.json().items[0];
  assert.match(item.url, /^\/uploads\/[0-9a-f]{24}\.png$/);
  assert.ok(fs.existsSync(`${config.uploads.dir}/${item.filename}`));

  const header = await c.request('POST', '/admin/media', { body: form(), headers: { 'x-csrf-token': c.csrfToken } });
  assert.equal(header.status, 200);

  const svg = new FormData();
  svg.append('files', new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], { type: 'image/svg+xml' }), 'x.svg');
  const rejected = await c.request('POST', `/admin/media?_csrf=${encodeURIComponent(c.csrfToken)}`, { body: svg });
  assert.equal(rejected.status, 415);
  assert.equal(rejected.json().error, 'bad_file_type');

  const fakePng = new FormData();
  fakePng.append('files', new Blob(['<?php echo 1; ?>'], { type: 'image/png' }), 'shell.png');
  const sniffed = await c.request('POST', `/admin/media?_csrf=${encodeURIComponent(c.csrfToken)}`, { body: fakePng });
  assert.equal(sniffed.status, 415);
  assert.equal(fs.readdirSync(config.uploads.dir).length, 2, 'only the two valid uploads remain on disk');
});

test('rateLimit middleware returns 429 with Retry-After', async () => {
  const c = createClient(baseUrl);
  assert.equal((await c.get('/limited')).status, 200);
  assert.equal((await c.get('/limited')).status, 200);
  const limited = await c.get('/limited');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('broadcast: sent to active users, blocked users are flagged', async () => {
  tgUsers.upsertTgUser({ id: 31, first_name: 'A' });
  tgUsers.upsertTgUser({ id: 32, first_name: 'B' });
  tgUsers.upsertTgUser({ id: 33, first_name: 'C' });
  tgUsers.markTgBlocked(33);
  fake.on('sendMessage', (p) => (Number(p.chat_id) === 32 ? { error_code: 403, description: 'Forbidden: bot was blocked by the user' } : { message_id: 1 }));
  const draft = broadcasts.createBroadcast({ text: '<b>Новый урожай</b>' }, null);
  assert.equal(draft.status, 'draft');
  const done = await broadcasts.sendBroadcast(draft.id, { delayMs: 0 });
  assert.equal(done.status, 'done');
  assert.equal(done.total, 2);
  assert.equal(done.sent, 1);
  assert.equal(done.failed, 1);
  assert.equal(tgUsers.getTgUser(32).is_blocked, 1);
  await assert.rejects(() => broadcasts.sendBroadcast(draft.id), (e) => e.code === 'bad_state');
});

// ─────────────────────────────── broadcasts: flood limits, fatal errors, interruption

/** Fresh audience: every earlier test user is blocked, `ids` are the only recipients. */
function audience(ids) {
  run('UPDATE tg_users SET is_blocked = 1');
  for (const id of ids) tgUsers.upsertTgUser({ id, first_name: `U${id}` });
}
const recipients = (text) => fake.callsTo('sendMessage').filter((p) => p.text === text).map((p) => Number(p.chat_id));

test('broadcast: a flood-limited recipient is retried after the pause, not dropped', async () => {
  audience([60001, 60002, 60003, 60004, 60005]);
  let calls = 0;
  fake.on('sendMessage', () => {
    calls += 1;
    return calls === 2 ? { error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } } : { message_id: calls };
  });
  const waits = [];
  const draft = broadcasts.createBroadcast({ text: 'Флуд-тест' }, null);
  const done = await broadcasts.sendBroadcast(draft.id, { delayMs: 0, sleepFn: async (ms) => { waits.push(ms); } });
  assert.deepEqual([done.status, done.total, done.sent, done.failed], ['done', 5, 5, 0]);
  assert.deepEqual(recipients('Флуд-тест'), [60001, 60002, 60002, 60003, 60004, 60005], 'the second recipient got a second attempt');
  assert.deepEqual(waits, [7100], 'waited as long as Telegram asked');

  // the pause is bounded, and a limit that does not go away stops the send where it can be continued
  fake.on('sendMessage', () => ({ error_code: 429, description: 'Too Many Requests: retry after 900', parameters: { retry_after: 900 } }));
  waits.length = 0;
  const stuck = broadcasts.createBroadcast({ text: 'Флуд-тест 2' }, null);
  const stopped = await broadcasts.sendBroadcast(stuck.id, { delayMs: 0, sleepFn: async (ms) => { waits.push(ms); } });
  assert.deepEqual([stopped.status, stopped.sent, stopped.failed, stopped.cursor], ['failed', 0, 0, 0]);
  assert.match(stopped.error, /429/);
  assert.ok(waits.every((ms) => ms <= broadcasts.MAX_FLOOD_WAIT_SEC * 1000 + 100));
  fake.off('sendMessage');
  const resumed = await broadcasts.sendBroadcast(stuck.id, { delayMs: 0 });
  assert.deepEqual([resumed.status, resumed.sent, resumed.error], ['done', 5, '']);
});

test('broadcast: an error every recipient would get stops the send at once and keeps the reason', async () => {
  audience([61001, 61002, 61003]);
  fake.on('sendMessage', (p) => (p.text.includes('<b>Скидка')
    ? { error_code: 400, description: 'Bad Request: can\'t parse entities: Can\'t find end tag corresponding to start tag "b"' }
    : { message_id: 1 }));
  const broken = broadcasts.createBroadcast({ text: '<b>Скидка 20%' }, null);
  const result = await broadcasts.sendBroadcast(broken.id, { delayMs: 0 });
  assert.deepEqual([result.status, result.sent, result.failed], ['failed', 0, 0]);
  assert.match(result.error, /can't parse entities/);
  assert.equal(recipients('<b>Скидка 20%').length, 1, 'the audience is not walked with a message Telegram refuses');
  assert.equal(broadcasts.canSend(result), true, 'a stopped broadcast is not burnt');
  assert.equal(tgUsers.getTgUser(61001).is_blocked, 0);
  fake.off('sendMessage');

  // a problem of ONE recipient does not stop the others
  fake.on('sendMessage', (p) => (Number(p.chat_id) === 61002 ? { error_code: 400, description: 'Bad Request: chat not found' } : { message_id: 1 }));
  const ok = await broadcasts.sendBroadcast(broadcasts.createBroadcast({ text: 'Привет всем' }, null).id, { delayMs: 0 });
  assert.deepEqual([ok.status, ok.sent, ok.failed], ['done', 2, 1]);
  fake.off('sendMessage');

  // unbalanced markup is caught before anything is sent
  assert.match(broadcasts.htmlProblem('<b>Скидка 20%'), /<b> не закрыт/);
  assert.match(broadcasts.htmlProblem('<b><i>Скидка</b></i>'), /закрыт не на своём месте/);
  assert.match(broadcasts.htmlProblem('Скидка</b>'), /закрыт не на своём месте/);
  assert.equal(broadcasts.htmlProblem('<b>Скидка</b> на <a href="https://samo.coffee/catalog">каталог</a> и <i><u>дрипы</u></i>'), '');
  assert.equal(broadcasts.htmlProblem('Просто текст'), '');
});

test('broadcast: a send interrupted by shutdown stays resumable and continues from the last recipient', async () => {
  const ids = Array.from({ length: 12 }, (_, i) => 62001 + i);
  audience(ids);
  fake.off('sendMessage');
  const b = broadcasts.createBroadcast({ text: 'Перезапуск посреди рассылки' }, null);

  // the process is asked to stop after the fourth recipient
  let delivered = 0;
  fake.on('sendMessage', (p) => {
    if (p.text === 'Перезапуск посреди рассылки') delivered += 1;
    if (delivered === 4) setImmediate(() => { broadcasts.stopSending({ timeoutMs: 2000 }); });
    return { message_id: delivered };
  });
  const interrupted = await broadcasts.sendBroadcast(b.id, { delayMs: 5 });
  assert.equal(interrupted.status, 'sending', 'the row is left as it was: the next boot continues it');
  assert.ok(interrupted.sent >= 4 && interrupted.sent < 12, `sent ${interrupted.sent}`);
  assert.equal(interrupted.cursor, ids[interrupted.sent - 1]);
  assert.equal(broadcasts.isSending(b.id), false);
  assert.equal(broadcasts.canSend(interrupted), true);

  // "next boot"
  broadcasts.resetSending();
  fake.off('sendMessage');
  assert.deepEqual(broadcasts.resumeInterrupted({ delayMs: 0 }), [b.id]);
  assert.deepEqual(broadcasts.resumeInterrupted({ delayMs: 0 }), [], 'not started twice');
  for (let i = 0; i < 200 && broadcasts.getBroadcast(b.id).status !== 'done'; i += 1) await new Promise((r) => setTimeout(r, 10));
  const done = broadcasts.getBroadcast(b.id);
  assert.deepEqual([done.status, done.total, done.sent, done.failed], ['done', 12, 12, 0]);
  assert.deepEqual(recipients('Перезапуск посреди рассылки').sort((x, y) => x - y), ids, 'everybody got the message exactly once');
  await assert.rejects(() => broadcasts.sendBroadcast(b.id), (e) => e.code === 'bad_state');
});
