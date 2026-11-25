// BOT module entry point.
//
// Contract with app.js / server.js:
//   startBot(app)  called once while the app is being built, BEFORE the site catch-all is mounted.
//                  Returns immediately: connecting to Telegram, long polling and the retries all run
//                  in the background, so a dead network or a wrong token never blocks or crashes the
//                  web server. Without BOT_TOKEN it only logs one line.
//                  BOT_MODE=webhook mounts POST /bot/webhook (secret-protected) on `app`.
//   stopBot()      graceful shutdown; safe to call at any time, any number of times.
//
// Modes
//   polling (default)  getUpdates long polling — works anywhere, no public address needed
//   webhook            Telegram calls BASE_URL/bot/webhook; requires HTTPS. The route checks the
//                      X-Telegram-Bot-Api-Secret-Token header (WEBHOOK_SECRET, or a secret derived
//                      from the bot token when the variable is empty).
import crypto from 'node:crypto';
import { config } from '../config.js';
import * as tg from '../lib/telegramApi.js';
import { createBot, ALLOWED_UPDATES, USER_COMMANDS, ADMIN_COMMANDS } from './bot.js';
import { canOpenWebApp, shopLabel } from './keyboards.js';
import { startScheduler, stopScheduler } from './scheduler.js';

const log = (...args) => { if (!config.isTest) console.log(...args); };
const warn = (...args) => { if (!config.isTest) console.warn(...args); };

/** @type {{ bot: import('grammy').Bot, stopped: boolean, abort: AbortController, ready: Promise<boolean>, queue: Promise<void>, seen: Set<number> } | null} */
let runtime = null;

/** Abortable pause. Resolves false when aborted. */
function pause(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The secret Telegram sends with every webhook call. WEBHOOK_SECRET is used as is when it fits
 * Telegram's alphabet (A-Z a-z 0-9 _ -); otherwise a stable secret is derived, so the route is
 * never left unprotected.
 */
export function webhookSecret() {
  const configured = config.bot.webhookSecret;
  if (/^[\w-]{8,256}$/.test(configured)) return configured;
  return crypto.createHash('sha256').update(`samo-webhook:${configured}:${config.bot.token}:${config.sessionSecret}`).digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** getMe with retries: Telegram may be unreachable at boot (deploy order, network hiccup). */
async function connect(rt) {
  let delay = 2000;
  let reported = false;
  while (!rt.stopped) {
    try {
      return await tg.call('getMe', {}, { timeoutMs: 10_000 });
    } catch (err) {
      if (rt.stopped) return null;
      if (err.code === 401 || err.code === 404) {
        console.error('[bot] Telegram rejected BOT_TOKEN (check the token from @BotFather). The bot is off; the site keeps working.');
        return null;
      }
      if (!reported) {
        warn(`[bot] cannot reach Telegram (${err.description || err.message}) — retrying in the background`);
        reported = true;
      }
      if (!(await pause(delay, rt.abort.signal))) return null;
      delay = Math.min(delay * 2, 60_000);
    }
  }
  return null;
}

/** Command list, the menu button — cosmetic, so failures are only logged. */
async function configureProfile(bot) {
  const attempt = async (what, fn) => {
    try {
      await fn();
    } catch (err) {
      warn(`[bot] ${what}: ${err.description || err.message}`);
    }
  };
  await attempt('setMyCommands', () => bot.api.setMyCommands(USER_COMMANDS, { scope: { type: 'all_private_chats' } }));
  const adminChatId = Number(config.bot.adminChatId);
  if (Number.isSafeInteger(adminChatId) && adminChatId !== 0) {
    // a private admin chat keeps the customer commands too (the owner tests the shop from it)
    const commands = adminChatId > 0
      ? [...ADMIN_COMMANDS.filter((c) => c.command !== 'help'), ...USER_COMMANDS.filter((c) => c.command !== 'orders')]
      : ADMIN_COMMANDS;
    await attempt('setMyCommands (admin chat)', () => bot.api.setMyCommands(commands, { scope: { type: 'chat', chat_id: adminChatId } }));
  }
  await attempt('setChatMenuButton', () => bot.api.setChatMenuButton({
    menu_button: canOpenWebApp()
      ? { type: 'web_app', text: shopLabel().slice(0, 32), web_app: { url: config.tma.url } }
      : { type: 'commands' },
  }));
}

/** Long polling that survives errors: grammY retries network failures itself, we restart on the rest. */
async function runPolling(rt) {
  let delay = 3000;
  while (!rt.stopped) {
    try {
      await rt.bot.start({
        allowed_updates: ALLOWED_UPDATES,
        onStart: (me) => {
          delay = 3000;
          log(`[bot] @${me.username} is running (long polling)`);
        },
      });
      return; // bot.stop() was called
    } catch (err) {
      if (rt.stopped) return;
      console.error(`[bot] polling stopped: ${err.description || err.message}`);
      if (err.error_code === 401) return; // token revoked — retrying cannot help
      if (!(await pause(delay, rt.abort.signal))) return;
      delay = Math.min(delay * 2, 60_000);
    }
  }
}

async function registerWebhook(rt) {
  const url = `${config.baseUrl}${config.bot.webhookPath}`;
  if (!config.isHttps) {
    warn(`[bot] webhook mode: BASE_URL is not https, so the webhook is not registered automatically. Point Telegram to <public https address>${config.bot.webhookPath} yourself or use BOT_MODE=polling.`);
    return;
  }
  const attempt = async () => {
    await rt.bot.api.setWebhook(url, { secret_token: webhookSecret(), allowed_updates: ALLOWED_UPDATES, max_connections: 10 });
    log(`[bot] @${rt.bot.botInfo.username} is running (webhook ${url})`);
  };
  try {
    await attempt();
  } catch (err) {
    console.error(`[bot] setWebhook failed: ${err.description || err.message}`);
    if (err.error_code === 401) return; // token revoked — retrying cannot help
    // keep trying in the background so a temporary Telegram outage does not leave the bot deaf until a restart
    (async () => {
      let delay = 5_000;
      while (!rt.stopped) {
        if (!(await pause(delay, rt.abort.signal))) return;
        try {
          await attempt();
          return;
        } catch (e) {
          if (rt.stopped || e.error_code === 401) return;
          console.error(`[bot] setWebhook retry failed: ${e.description || e.message}`);
          delay = Math.min(delay * 2, 300_000);
        }
      }
    })().catch((e) => console.error('[bot] webhook retry crashed:', e));
  }
}

/** Background start-up. Resolves true when the bot is connected. Never rejects. */
async function launch(rt) {
  try {
    const me = await connect(rt);
    if (!me || rt.stopped) return false;
    rt.bot.botInfo = me;
    await configureProfile(rt.bot);
    if (rt.stopped) return false;
    if (config.bot.mode === 'webhook') await registerWebhook(rt);
    else runPolling(rt).catch((err) => console.error('[bot] polling crashed:', err));
    return true;
  } catch (err) {
    console.error('[bot] startup failed:', err);
    return false;
  }
}

/** Run one update through the bot; handler errors go to bot.catch. Updates are processed one at a time. */
function enqueue(rt, update) {
  const task = rt.queue.then(async () => {
    try {
      await rt.bot.handleUpdate(update);
    } catch (err) {
      try {
        await rt.bot.errorHandler(err);
      } catch (inner) {
        console.error('[bot] error handler failed:', inner);
      }
    }
  });
  rt.queue = task;
  return task;
}

/** POST /bot/webhook — Telegram delivers updates here in webhook mode. */
function mountWebhook(app, rt) {
  const secret = webhookSecret();
  app.post(config.bot.webhookPath, async (req, res) => {
    if (!safeEqual(req.get('x-telegram-bot-api-secret-token') || '', secret)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const update = req.body;
    if (!update || typeof update !== 'object' || !Number.isSafeInteger(update.update_id)) {
      return res.status(400).json({ ok: false, error: 'bad_update' });
    }
    if (rt.stopped || !rt.bot.isInited()) {
      // not connected yet — Telegram repeats the delivery later
      return res.status(503).json({ ok: false, error: 'bot_not_ready' });
    }
    if (rt.seen.has(update.update_id)) return res.json({ ok: true }); // a retry of an update we already took
    rt.seen.add(update.update_id);
    if (rt.seen.size > 2000) rt.seen.delete(rt.seen.values().next().value);
    await enqueue(rt, update);
    return res.json({ ok: true });
  });
}

/**
 * Start the bot. See the contract at the top of this file.
 * @param {import('express').Express} [app] needed for webhook mode
 * @returns {Promise<import('grammy').Bot | null>} the bot (still connecting in the background) or null when disabled
 */
export async function startBot(app) {
  if (!config.bot.enabled) {
    log('[bot] disabled: BOT_TOKEN is not set (site, admin panel and payments work without it)');
    return null;
  }
  if (!runtime) {
    const rt = { bot: createBot(), stopped: false, abort: new AbortController(), ready: null, queue: Promise.resolve(), seen: new Set() };
    runtime = rt;
    rt.ready = launch(rt);
    startScheduler();
  }
  if (config.bot.mode === 'webhook' && app) mountWebhook(app, runtime);
  return runtime.bot;
}

/** Resolves true once the bot is connected to Telegram (false: disabled, stopped or the token was rejected). */
export function whenBotReady() {
  return runtime ? runtime.ready : Promise.resolve(false);
}

/** The running bot instance or null. */
export function getBot() {
  return runtime ? runtime.bot : null;
}

export async function stopBot() {
  stopScheduler();
  const rt = runtime;
  runtime = null;
  if (!rt) return;
  rt.stopped = true;
  rt.abort.abort();
  try {
    if (rt.bot.isRunning()) {
      // bot.stop() confirms the last update with one more getUpdates — do not hang on a dead network
      await Promise.race([rt.bot.stop(), new Promise((resolve) => { setTimeout(resolve, 3000).unref(); })]);
    }
    await Promise.race([rt.queue, new Promise((resolve) => { setTimeout(resolve, 3000).unref(); })]);
  } catch (err) {
    warn(`[bot] stop: ${err.description || err.message}`);
  }
}
