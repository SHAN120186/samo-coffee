// Like bot.env.js, but the bot runs in webhook mode behind an HTTPS address.
import './bot.env.js';

export const WEBHOOK_SECRET = 'samo-test-webhook-secret_42';
process.env.BOT_MODE = 'webhook';
process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.BASE_URL = 'https://shop.samo-test.example';

export { FAKE_TG_PORT, BOT_TOKEN, ADMIN_CHAT_ID } from './helpers/env-telegram.js';
