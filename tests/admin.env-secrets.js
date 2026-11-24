// Import right after ./helpers/env.js (and before anything from src/) in tests that check that the
// admin panel never prints secrets: fills the payment / bot credentials with recognisable values.
export const SECRETS = {
  PAYME_MERCHANT_ID: 'payme-merchant-SECRET-1f9a',
  PAYME_KEY: 'payme-key-SECRET-77c2',
  CLICK_SERVICE_ID: 'click-service-SECRET-5510',
  CLICK_MERCHANT_ID: 'click-merchant-SECRET-9d01',
  CLICK_SECRET_KEY: 'click-secret-SECRET-ab42',
  TELEGRAM_PAYMENT_TOKEN: 'tg-pay-token-SECRET-e3e3',
  WEBHOOK_SECRET: 'webhook-SECRET-0c0c',
};
Object.assign(process.env, SECRETS);
