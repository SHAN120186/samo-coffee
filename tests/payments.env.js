// Test environment of the PAYMENTS module — import FIRST (instead of ./helpers/env.js):
// own temp database file, Payme and Click configured with test credentials, bot disabled.
// (No top-level await here: the env must be complete before any src/** module is evaluated.)
import './payments.env-db.js';
import './helpers/env.js';

export const PAYME_MERCHANT_ID = '5e730e8e0b852a417aa49ceb';
export const PAYME_KEY = 'Vs@S8pK?test&key#Zx7QmT2wYhB5nR9c';
export const CLICK_SERVICE_ID = '31415';
export const CLICK_MERCHANT_ID = '27182';
export const CLICK_SECRET_KEY = 'cl1ckS3cretT3st';
export const CLICK_MERCHANT_USER_ID = '16180';

process.env.PAYME_MERCHANT_ID = PAYME_MERCHANT_ID;
process.env.PAYME_KEY = PAYME_KEY;
process.env.PAYME_TEST = '1';
process.env.PAYME_ACCOUNT_FIELD = 'order_id';
process.env.CLICK_SERVICE_ID = CLICK_SERVICE_ID;
process.env.CLICK_MERCHANT_ID = CLICK_MERCHANT_ID;
process.env.CLICK_SECRET_KEY = CLICK_SECRET_KEY;
process.env.CLICK_MERCHANT_USER_ID = CLICK_MERCHANT_USER_ID;
for (const key of ['TELEGRAM_PAYMENT_TOKEN', 'TELEGRAM_PAYMENT_NEED_PHONE', 'ALLOW_MOCK_PAYMENTS']) delete process.env[key];
