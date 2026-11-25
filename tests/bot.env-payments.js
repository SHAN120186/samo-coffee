// Like bot.env.js, plus Telegram Payments switched on (TELEGRAM_PAYMENT_TOKEN).
import './bot.env.js';

export const PAYMENT_TOKEN = '398062629:TEST:samo-test-provider-token';
process.env.TELEGRAM_PAYMENT_TOKEN = PAYMENT_TOKEN;

export { FAKE_TG_PORT, BOT_TOKEN, ADMIN_CHAT_ID } from './helpers/env-telegram.js';
