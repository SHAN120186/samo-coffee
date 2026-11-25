// Test environment for the BOT module: a configured bot that talks to the local fake Bot API server.
// Import this FIRST in tests/bot.*.test.js (before anything from src/). No top-level await here.
import './helpers/env-telegram.js';

for (const key of ['TELEGRAM_PAYMENT_TOKEN', 'BOT_MODE', 'WEBHOOK_SECRET', 'TMA_URL']) delete process.env[key];

export { FAKE_TG_PORT, BOT_TOKEN, ADMIN_CHAT_ID } from './helpers/env-telegram.js';
