// Process entry point: one process serves the site, admin, API, Mini App and runs the bot.
import { config } from './config.js';
import { closeDb } from './db/index.js';
import { createApp } from './app.js';
import { stopBot } from './bot/index.js';
import * as subscriptions from './services/subscriptions.js';
import * as notify from './services/notify.js';

const app = await createApp();

const server = app.listen(config.port, () => {
  console.log(`[samo] ${config.env} · ${config.baseUrl} (port ${config.port})`);
  console.log(`[samo] payments: ${config.payments.provider} · bot: ${config.bot.enabled ? `${config.bot.mode}` : 'disabled (no BOT_TOKEN)'} · db: ${config.databasePath}`);
});

// Housekeeping: expire subscriptions whose period has ended.
const housekeeping = () => {
  try {
    subscriptions.expireDue();
  } catch (err) {
    console.error('[housekeeping]', err);
  }
};
housekeeping();
const timer = setInterval(housekeeping, 60 * 60 * 1000);
timer.unref();

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`[samo] ${signal} received, shutting down…`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  clearInterval(timer);
  try {
    await stopBot();
  } catch (err) {
    console.error('[bot] stop failed:', err);
  }
  server.close(async () => {
    await Promise.race([notify.flush(), new Promise((r) => setTimeout(r, 3000))]);
    closeDb();
    process.exit(0);
  });
  server.closeIdleConnections?.();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
