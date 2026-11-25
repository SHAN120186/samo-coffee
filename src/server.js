// Process entry point: one process serves the site, admin, API, Mini App and runs the bot.
import { config } from './config.js';
import { closeDb } from './db/index.js';
import { createApp } from './app.js';
import { stopBot } from './bot/index.js';
import * as subscriptions from './services/subscriptions.js';
import * as notify from './services/notify.js';
import { activeProviderId, resolveProvider } from './payments/index.js';

// Opt-in demo data for a first deploy (SEED_ON_EMPTY=1): only when the database holds no business
// data yet — an existing shop is never touched, and a second boot finds the data and skips.
if (config.seedOnEmpty) {
  try {
    const { seedIfEmpty } = await import('./db/seed.js');
    const summary = seedIfEmpty({ quiet: true });
    console.log(summary
      ? `[samo] SEED_ON_EMPTY: demo data loaded (${summary.products} products, ${summary.orders} orders, ${summary.posts} posts)`
      : '[samo] SEED_ON_EMPTY: the database already has data — nothing was changed');
  } catch (err) {
    console.error('[samo] SEED_ON_EMPTY failed (the app starts without demo data):', err);
  }
}

const app = await createApp();

/** What a customer gets at checkout right now (for the boot log). */
function paymentStatus() {
  try {
    const provider = resolveProvider();
    const wanted = activeProviderId();
    return provider.id === wanted ? provider.id : `${provider.id} (fallback: "${wanted}" is not configured)`;
  } catch {
    return `UNAVAILABLE — "${activeProviderId()}" is not configured${config.isProd ? ' (the demo checkout is off in production: set ALLOW_MOCK_PAYMENTS=1 or configure a provider)' : ''}`;
  }
}

const server = app.listen(config.port, config.host, () => {
  console.log(`[samo] ${config.env} · ${config.baseUrl} (listening on ${config.host}:${config.port})`);
  console.log(`[samo] payments: ${paymentStatus()} · bot: ${config.bot.enabled ? `${config.bot.mode}` : 'disabled (no BOT_TOKEN)'} · db: ${config.databasePath} · uploads: ${config.uploads.dir}`);
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
