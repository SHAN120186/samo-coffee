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
/** Interface to listen on. 0.0.0.0 = every interface (needed inside containers and on PaaS such as Railway). */
const host = str('HOST', '0.0.0.0');

// Public address. When BASE_URL is not set, hosting platforms that publish the service domain in the
// environment (Railway: RAILWAY_PUBLIC_DOMAIN) are used; the last resort is http://localhost:PORT.
function resolveBaseUrl() {
  const explicit = str('BASE_URL', '');
  if (explicit) return explicit;
  const railwayDomain = str('RAILWAY_PUBLIC_DOMAIN', '').replace(/^https?:\/\//, '');
  if (railwayDomain) return `https://${railwayDomain}`;
  return `http://localhost:${port}`;
}
const baseUrl = resolveBaseUrl().replace(/\/+$/, '');
/** true when neither BASE_URL nor a platform domain was available — links in Telegram, sitemap and payment returns are wrong */
const baseUrlIsFallback = !str('BASE_URL', '') && !str('RAILWAY_PUBLIC_DOMAIN', '');

const sessionSecret = str('SESSION_SECRET', '');
if (isProd && sessionSecret.length < 16) {
  throw new Error('SESSION_SECRET (16+ chars) is required when NODE_ENV=production');
}

const resolvePath = (p) => (p === ':memory:' ? p : path.isAbsolute(p) ? p : path.resolve(ROOT_DIR, p));
/**
 * ONE directory holds everything that must survive a redeploy: the SQLite database and the uploaded
 * media. Mount a persistent volume there (Docker: /data, Railway: a Volume mounted at /data).
 * DATABASE_PATH / UPLOAD_DIR still override the individual locations.
 */
const dataDir = resolvePath(str('DATA_DIR', './data'));
const botToken = str('BOT_TOKEN', '');

/**
 * '' = do not trust X-Forwarded-* at all (req.ip is the TCP peer); '1' = one proxy in front.
 * Trusting the header while clients can reach the app directly lets them pick their own "IP" and
 * walk around every IP-keyed rate limit, so it is on by default only where a proxy is known to
 * exist (Railway). Everywhere else it is opt-in: TRUST_PROXY=1 behind nginx / Caddy / another PaaS
 * (docker-compose.yml sets it and publishes the port on 127.0.0.1 only).
 */
function resolveTrustProxy() {
  const onRailway = Boolean(str('RAILWAY_ENVIRONMENT', '') || str('RAILWAY_PUBLIC_DOMAIN', ''));
  const value = str('TRUST_PROXY', onRailway ? '1' : '');
  return ['0', 'false', 'off', 'no'].includes(value.toLowerCase()) ? '' : value;
}

export const config = {
  env: nodeEnv,
  isProd,
  isTest,
  port,
  host,
  baseUrl,
  baseUrlIsFallback,
  isHttps: baseUrl.startsWith('https://'),
  /**
   * Express "trust proxy": how many reverse proxies sit in front of the app (req.ip, req.protocol).
   * Defaults to 1 on Railway (one edge proxy) and to "none" everywhere else — set TRUST_PROXY=1
   * when the app is reachable ONLY through your own reverse proxy.
   */
  trustProxy: resolveTrustProxy(),
  rootDir: ROOT_DIR,
  publicDir: path.join(ROOT_DIR, 'public'),
  dataDir,
  databasePath: str('DATABASE_PATH', '') ? resolvePath(str('DATABASE_PATH', '')) : path.join(dataDir, 'samo.db'),
  /** Opt-in: load the demo data on boot when the database is still empty (first deploy of a demo stand). */
  seedOnEmpty: bool('SEED_ON_EMPTY', false),
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
    /** The built-in demo checkout works outside production only, unless explicitly allowed (demo stands). */
    allowMock: !isProd || bool('ALLOW_MOCK_PAYMENTS', false),
    telegram: {
      providerToken: str('TELEGRAM_PAYMENT_TOKEN', ''),
      /** Ask the payer for a phone number in the Telegram invoice form. */
      needPhone: bool('TELEGRAM_PAYMENT_NEED_PHONE', false),
    },
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
    /** Served at /uploads. Lives next to the database so one volume keeps both. */
    dir: str('UPLOAD_DIR', '') ? resolvePath(str('UPLOAD_DIR', '')) : path.join(dataDir, 'uploads'),
    maxBytes: int('UPLOAD_MAX_MB', 5) * 1024 * 1024,
  },

  analytics: {
    enabled: bool('ANALYTICS_ENABLED', true),
    /** Page views older than this many days are deleted by the hourly housekeeping (0 = keep forever). */
    retentionDays: Math.max(0, Math.floor(Number(process.env.ANALYTICS_RETENTION_DAYS ?? 400)) || 0),
  },
};

export default config;
