// Like ./payments.env.js, plus a configured bot (fake Bot API server) and Telegram Payments.
// Import FIRST; then start the fake server: startFakeTelegram(FAKE_TG_PORT).
import './payments.env.js';
import { FAKE_TG_PORT, BOT_TOKEN, ADMIN_CHAT_ID } from './helpers/env-telegram.js';

export const PAYMENT_TOKEN = '398062629:TEST:samo-payments-provider-token';
process.env.TELEGRAM_PAYMENT_TOKEN = PAYMENT_TOKEN;

export { FAKE_TG_PORT, BOT_TOKEN, ADMIN_CHAT_ID };
export * from './payments.env.js';
