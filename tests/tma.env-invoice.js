// Like helpers/env-telegram.js, plus Telegram Payments switched on. Import FIRST.
import './helpers/env-telegram.js';

export const PAYMENT_TOKEN = '398062629:TEST:samo-tma-provider-token';
process.env.TELEGRAM_PAYMENT_TOKEN = PAYMENT_TOKEN;

export { FAKE_TG_PORT, BOT_TOKEN, ADMIN_CHAT_ID } from './helpers/env-telegram.js';
