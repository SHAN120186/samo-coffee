// BOT module entry (STUB — replaced by the BOT module).
// Contract with app.js / server.js:
//   startBot(app)  called once while the app is being built, BEFORE the site catch-all is mounted.
//                  - must return quickly: never await grammY's bot.start() (it resolves only on stop)
//                  - with config.bot.enabled === false it must do nothing
//                  - webhook mode: mount the handler on `app` at config.bot.webhookPath (it is CSRF-exempt)
//   stopBot()      called on graceful shutdown; must be safe to call when the bot never started.
import { config } from '../config.js';

export async function startBot(app) { // eslint-disable-line no-unused-vars
  if (!config.bot.enabled) return null;
  console.log('[bot] stub: BOT_TOKEN is set but the bot module is not implemented yet');
  return null;
}

export async function stopBot() {}
