// Like env.js, but with a configured bot that talks to a local fake Bot API server.
// Import FIRST (instead of env.js), then start the server in a before() hook:
//   import { FAKE_TG_PORT, BOT_TOKEN, ADMIN_CHAT_ID } from './helpers/env-telegram.js';
//   import { startFakeTelegram } from './helpers/fakeTelegram.js';
//   const fake = await startFakeTelegram(FAKE_TG_PORT);
// NOTE: no top-level await here — sibling imports must not start before the env is ready.
import './env.js';

export const FAKE_TG_PORT = 20000 + (process.pid % 20000);
export const BOT_TOKEN = '123456:TEST-TOKEN';
export const ADMIN_CHAT_ID = '-1001234567890';
process.env.BOT_TOKEN = BOT_TOKEN;
process.env.BOT_USERNAME = 'samo_test_bot';
process.env.ADMIN_CHAT_ID = ADMIN_CHAT_ID;
process.env.TELEGRAM_API_ROOT = `http://127.0.0.1:${FAKE_TG_PORT}`;
