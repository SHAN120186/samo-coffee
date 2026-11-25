// The real server process (src/server.js) with the bot in long-polling mode against the fake Bot API:
// startup, a full update round-trip through getUpdates, graceful shutdown — and the three ways the
// bot can be unavailable (no token, Telegram unreachable, token rejected) that must never take the
// web server down. Every run uses its own temporary database file.
import { FAKE_TG_PORT, BOT_TOKEN, ADMIN_CHAT_ID } from './bot.env.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeTelegram } from './helpers/fakeTelegram.js';
import { makeUser, callsToChat } from './bot.helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samo-bot-startup-'));
let fake;
const children = new Set();

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

async function waitFor(check, what, timeoutMs = 15_000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
}

/** Start `node src/server.js` with a clean environment. */
async function startServer(name, env) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'development',
      SKIP_DOTENV: '1',
      PORT: String(port),
      BASE_URL: `http://localhost:${port}`,
      DATABASE_PATH: path.join(tmp, `${name}.db`),
      UPLOAD_DIR: path.join(tmp, `${name}-uploads`),
      SESSION_SECRET: 'startup-test-secret-0123456789',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  const server = { child, port, output: '', exitCode: undefined, url: `http://127.0.0.1:${port}` };
  child.stdout.on('data', (chunk) => { server.output += chunk; });
  child.stderr.on('data', (chunk) => { server.output += chunk; });
  child.on('exit', (code) => {
    server.exitCode = code;
    children.delete(child);
  });
  server.logged = (pattern, timeoutMs) => waitFor(() => {
    if (server.exitCode !== undefined && !pattern.test(server.output)) throw new Error(`server exited (${server.exitCode}):\n${server.output}`);
    return pattern.test(server.output);
  }, `log ${pattern} in:\n${server.output}`, timeoutMs);
  server.health = async () => {
    const res = await fetch(`${server.url}/healthz`);
    return res.status === 200 && (await res.json()).ok === true;
  };
  server.stop = async () => {
    const started = Date.now();
    child.kill('SIGTERM');
    await waitFor(() => server.exitCode !== undefined, 'server exit', 12_000);
    return { code: server.exitCode, ms: Date.now() - started };
  };
  await server.logged(/\[samo\] development · http:\/\/localhost/);
  return server;
}

before(async () => {
  fake = await startFakeTelegram(FAKE_TG_PORT);
});
after(async () => {
  for (const child of children) child.kill('SIGKILL');
  await fake.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => fake.reset());

test('polling mode: the server starts, the bot polls the fake API, handles updates and stops gracefully', async () => {
  const server = await startServer('polling', { BOT_TOKEN, ADMIN_CHAT_ID, TELEGRAM_API_ROOT: fake.url });
  await server.logged(/\[bot\] @samo_test_bot is running \(long polling\)/);
  assert.match(server.output, /bot: polling/);
  assert.ok(await server.health());

  // connected and configured
  for (const method of ['getMe', 'setMyCommands', 'setChatMenuButton', 'deleteWebhook']) {
    assert.ok(fake.callsTo(method).length >= 1, `${method} was called`);
  }
  assert.ok(fake.calls.every((c) => c.token === BOT_TOKEN));
  assert.deepEqual(fake.callsTo('setChatMenuButton')[0].menu_button, { type: 'commands' }, 'no Mini App button without HTTPS');

  // an update delivered through getUpdates is handled: /start → welcome with the menu
  const user = makeUser(4001, { first_name: 'Полина' });
  const chat = { id: user.id, type: 'private', first_name: user.first_name };
  fake.pushUpdate({ message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat, from: user, text: '/start site', entities: [{ type: 'bot_command', offset: 0, length: 6 }] } });
  const welcome = await waitFor(() => callsToChat(fake, 'sendMessage', user.id)[0], 'the welcome message');
  assert.match(welcome.text, /Здравствуйте, Полина!/);
  assert.ok(welcome.reply_markup.keyboard);

  // feedback travels to the admin chat
  fake.pushUpdate({ message: { message_id: 2, date: Math.floor(Date.now() / 1000), chat, from: user, text: 'Вы работаете в воскресенье?' } });
  const forwarded = await waitFor(() => callsToChat(fake, 'sendMessage', ADMIN_CHAT_ID).find((p) => p.text.includes('Вы работаете в воскресенье?')), 'the forwarded feedback');
  assert.match(forwarded.text, /Обращение #1/);
  await waitFor(() => callsToChat(fake, 'sendMessage', user.id).find((p) => /Передали сообщение команде/.test(p.text)), 'the confirmation');

  // the admin panel (same process) shows that the bot is alive: the site still answers
  assert.equal((await fetch(`${server.url}/`)).status, 200);

  const { code, ms } = await server.stop();
  assert.equal(code, 0, `clean exit, output:\n${server.output}`);
  assert.ok(ms < 8000, `shutdown took ${ms} ms`);
  assert.match(server.output, /SIGTERM received/);
  assert.doesNotMatch(server.output, /unhandledRejection|polling crashed|handler failed/);
});

test('no BOT_TOKEN: the app runs with the bot disabled and says so in one line', async () => {
  const server = await startServer('disabled', {});
  await server.logged(/\[bot\] disabled: BOT_TOKEN is not set/);
  assert.equal(server.output.match(/\[bot\]/g).length, 1, 'exactly one bot line');
  assert.ok(await server.health());
  assert.equal((await fetch(`${server.url}/`)).status, 200);
  assert.equal((await fetch(`${server.url}/bot/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
  assert.equal(fake.calls.length, 0);
  assert.equal((await server.stop()).code, 0);
});

test('Telegram unreachable at boot: the web server works, the bot keeps retrying and connects when the API appears', async () => {
  const port = await freePort(); // nothing listens here yet
  const server = await startServer('unreachable', { BOT_TOKEN, ADMIN_CHAT_ID, TELEGRAM_API_ROOT: `http://127.0.0.1:${port}` });
  await server.logged(/\[bot\] cannot reach Telegram .* retrying in the background/);
  assert.ok(await server.health());
  assert.equal((await fetch(`${server.url}/`)).status, 200);

  const late = await startFakeTelegram(port);
  try {
    await server.logged(/\[bot\] @samo_test_bot is running \(long polling\)/, 20_000);
    assert.ok(late.callsTo('getMe').length >= 1);
  } finally {
    const { code } = await server.stop();
    await late.close();
    assert.equal(code, 0);
  }
});

test('a rejected token and a webhook mode without HTTPS never crash the server', async () => {
  fake.on('getMe', () => ({ error_code: 401, description: 'Unauthorized' }));
  const rejected = await startServer('rejected', { BOT_TOKEN: '1:WRONG', TELEGRAM_API_ROOT: fake.url });
  await rejected.logged(/\[bot\] Telegram rejected BOT_TOKEN/);
  assert.ok(await rejected.health());
  assert.equal((await rejected.stop()).code, 0);
  fake.off('getMe');

  fake.reset();
  const webhook = await startServer('webhook', { BOT_TOKEN, TELEGRAM_API_ROOT: fake.url, BOT_MODE: 'webhook' });
  await webhook.logged(/\[bot\] webhook mode: BASE_URL is not https/);
  assert.equal(fake.callsTo('setWebhook').length, 0);
  assert.equal(fake.callsTo('deleteWebhook').length, 0, 'webhook mode does not poll');
  // the route exists and is protected even though WEBHOOK_SECRET is empty (a secret is derived)
  const res = await fetch(`${webhook.url}/bot/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ update_id: 1 }) });
  assert.equal(res.status, 401);
  assert.equal((await webhook.stop()).code, 0);
});
