// Central configuration. Reads process.env (and .env when present) exactly once.
// The app must boot with an empty .env in development; production requires SESSION_SECRET.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT_DIR, '.env');
if (fs.existsSync(envFile) && process.env.SKIP_DOTENV !== '1') {
  try {
    process.loadEnvFile(envFile); // never overrides variables that are already set
  } catch (err) {
    console.warn(`[config] cannot parse .env: ${err.message}`);
  }
}

const env = process.env;
const str = (name, def = '') => (env[name] === undefined || env[name] === '' ? def : String(env[name]).trim());
const int = (name, def) => {
  const n = Number.parseInt(str(name, ''), 10);
  return Number.isFinite(n) ? n : def;
};
const bool = (name, def = false) => {
  const v = str(name, '').toLowerCase();
  if (!v) return def;
  return ['1', 'true', 'yes', 'on'].includes(v);
};
const oneOf = (name, allowed, def) => {
  const v = str(name, def).toLowerCase();
  return allowed.includes(v) ? v : def;
};

const nodeEnv = str('NODE_ENV', 'development');
const isProd = nodeEnv === 'production';
const isTest = nodeEnv === 'test';
const port = int('PORT', 3000);
const baseUrl = str('BASE_URL', `http://localhost:${port}`).replace(/\/+$/, '');

const sessionSecret = str('SESSION_SECRET', '');
if (isProd && sessionSecret.length < 16) {
  throw new Error('SESSION_SECRET (16+ chars) is required when NODE_ENV=production');
}

const resolvePath = (p) => (p === ':memory:' ? p : path.isAbsolute(p) ? p : path.resolve(ROOT_DIR, p));
const botToken = str('BOT_TOKEN', '');

export const config = {
  env: nodeEnv,
  isProd,
  isTest,
  port,
  baseUrl,
  isHttps: baseUrl.startsWith('https://'),
  trustProxy: str('TRUST_PROXY', isProd ? '1' : ''),
  rootDir: ROOT_DIR,
  publicDir: path.join(ROOT_DIR, 'public'),
  databasePath: resolvePath(str('DATABASE_PATH', './data/samo.db')),
  sessionSecret: sessionSecret || 'dev-only-insecure-secret-change-me',
  /** Minutes added to UTC for "business day" grouping in analytics (Tashkent = +300). */
  tzOffsetMinutes: int('TZ_OFFSET_MINUTES', 300),

  admin: {
    email: str('ADMIN_EMAIL', 'admin@samo.coffee').toLowerCase(),
    password: str('ADMIN_PASSWORD', isProd ? '' : 'admin12345'),
    sessionDays: int('ADMIN_SESSION_DAYS', 14),
  },

  bot: {
    token: botToken,
    enabled: Boolean(botToken),
    username: str('BOT_USERNAME', '').replace(/^@/, ''),
    /** Chat (user, group or supergroup id) that receives admin notifications and feedback. */
    adminChatId: str('ADMIN_CHAT_ID', ''),
    apiRoot: str('TELEGRAM_API_ROOT', 'https://api.telegram.org').replace(/\/+$/, ''),
    mode: oneOf('BOT_MODE', ['polling', 'webhook'], 'polling'),
    webhookSecret: str('WEBHOOK_SECRET', ''),
    /** Path the webhook is served on (BOT module mounts it). */
    webhookPath: '/bot/webhook',
  },

  payments: {
    /** Default provider; can be overridden at runtime by the `payment_provider` setting. */
    provider: oneOf('PAYMENT_PROVIDER', ['mock', 'telegram', 'payme', 'click'], 'mock'),
    currency: 'UZS',
    telegram: { providerToken: str('TELEGRAM_PAYMENT_TOKEN', '') },
    payme: {
      merchantId: str('PAYME_MERCHANT_ID', ''),
      key: str('PAYME_KEY', ''),
      test: bool('PAYME_TEST', true),
      /** Name of the `account` field configured in the Payme cabinet. */
      accountField: str('PAYME_ACCOUNT_FIELD', 'order_id'),
    },
    click: {
      serviceId: str('CLICK_SERVICE_ID', ''),
      merchantId: str('CLICK_MERCHANT_ID', ''),
      secretKey: str('CLICK_SECRET_KEY', ''),
      merchantUserId: str('CLICK_MERCHANT_USER_ID', ''),
    },
  },

  tma: {
    /** Browser "dev preview" of the Mini App without Telegram. Never active in production. */
    devAuth: !isProd && bool('TMA_DEV_AUTH', false),
    /** Max age of initData.auth_date in seconds. */
    initDataMaxAge: int('TMA_INITDATA_MAX_AGE', 86400),
    url: str('TMA_URL', `${baseUrl}/tma/`),
  },

  uploads: {
    dir: resolvePath(str('UPLOAD_DIR', './public/uploads')),
    maxBytes: int('UPLOAD_MAX_MB', 5) * 1024 * 1024,
  },

  analytics: {
    enabled: bool('ANALYTICS_ENABLED', true),
  },
};

export default config;
