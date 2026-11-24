// Settings: site name, contacts, socials, delivery, payment provider, bot texts.
// Secrets live in the environment (.env) and are NEVER rendered — only "set / not set" flags.
import { Router } from 'express';
import * as settings from '../../services/settings.js';
import * as payments from '../../payments/index.js';
import * as notify from '../../services/notify.js';
import { config } from '../../config.js';
import { clean } from '../../lib/escape.js';
import { view, wrap } from '../lib.js';

const router = Router();

const GROUP_HINTS = {
  general: 'Название и SEO-тексты по умолчанию. Тексты отдельных страниц редактируются в разделе «Страницы».',
  contacts: 'Показываются в шапке, подвале и на странице контактов.',
  socials: 'Оставьте поле пустым, чтобы скрыть иконку соцсети на сайте.',
  delivery: 'Используется при расчёте корзины на сайте и в мини-приложении.',
  payments: 'Ключи платёжных систем задаются в файле .env на сервере — здесь выбирается, какой провайдер активен.',
  bot: 'Тексты, которые бот отправляет пользователям. Переменные в фигурных скобках подставляются автоматически.',
};

/** Environment variables every provider needs: [name, isSet, optional?]. Values never leave this file. */
function providerEnv() {
  const p = config.payments;
  const set = (v) => Boolean(v);
  return {
    mock: [],
    telegram: [
      { name: 'BOT_TOKEN', set: set(config.bot.token) },
      { name: 'TELEGRAM_PAYMENT_TOKEN', set: set(p.telegram.providerToken) },
    ],
    payme: [
      { name: 'PAYME_MERCHANT_ID', set: set(p.payme.merchantId) },
      { name: 'PAYME_KEY', set: set(p.payme.key) },
    ],
    click: [
      { name: 'CLICK_SERVICE_ID', set: set(p.click.serviceId) },
      { name: 'CLICK_MERCHANT_ID', set: set(p.click.merchantId) },
      { name: 'CLICK_SECRET_KEY', set: set(p.click.secretKey) },
      { name: 'CLICK_MERCHANT_USER_ID', set: set(p.click.merchantUserId), optional: true },
    ],
  };
}

const PROVIDER_INFO = {
  mock: { title: 'Демо-оплата', note: 'Тестовая страница оплаты без реальных списаний — для показов и проверки сценариев.' },
  telegram: { title: 'Telegram Payments', note: 'Счёт внутри Telegram (мини-приложение и бот). Токен выдаёт @BotFather → Payments (Click, Payme и др.).' },
  payme: { title: 'Payme', note: `Страница оплаты Payme + Merchant API. Адрес для кабинета Payme: ${config.baseUrl}/pay/payme` },
  click: { title: 'Click', note: `Страница оплаты Click + SHOP API. Адреса: ${config.baseUrl}/pay/click/prepare и ${config.baseUrl}/pay/click/complete` },
};

function paymentStatus() {
  const env = providerEnv();
  const registry = new Map(payments.listProviders().map((p) => [p.id, p]));
  const selected = settings.get('payment_provider', '');
  const activeId = payments.activeProviderId();
  let effective = null;
  try {
    effective = payments.resolveProvider().id;
  } catch {
    effective = null; // production + nothing configured
  }
  const providers = Object.keys(PROVIDER_INFO).map((id) => {
    const reg = registry.get(id);
    const keys = env[id];
    const envReady = keys.filter((k) => !k.optional).every((k) => k.set);
    return {
      id,
      title: reg?.title || PROVIDER_INFO[id].title,
      note: PROVIDER_INFO[id].note,
      keys,
      installed: Boolean(reg),
      configured: reg ? reg.configured : false,
      envReady,
      active: id === activeId,
      effective: id === effective,
    };
  });
  return {
    providers,
    selected,
    activeId,
    effective,
    envDefault: config.payments.provider,
    fallback: Boolean(effective && effective !== activeId),
    isProd: config.isProd,
  };
}

function botStatus() {
  return {
    enabled: config.bot.enabled,
    username: config.bot.username,
    adminChat: Boolean(config.bot.adminChatId),
    mode: config.bot.mode,
    webhookSecret: Boolean(config.bot.webhookSecret),
    tmaUrl: config.tma.url,
    https: config.isHttps,
    devAuth: config.tma.devAuth,
    notifications: notify.isEnabled() && Boolean(config.bot.adminChatId),
  };
}

const REQUIRED = new Set(['site_name']);

function validate(def, raw) {
  const value = def.type === 'textarea' ? String(raw ?? '').replace(/\r\n/g, '\n').trim().slice(0, 4000) : clean(raw, 500);
  if (!value) return REQUIRED.has(def.key) ? { error: 'Это поле не может быть пустым' } : { value: '' };
  if (def.type === 'number' && !/^\d{1,12}$/.test(value.replace(/\s/g, ''))) return { error: 'Введите целое неотрицательное число' };
  if (def.type === 'number') return { value: value.replace(/\s/g, '') };
  if (def.type === 'url' && !/^https?:\/\/[^\s]+$/i.test(value)) return { error: 'Ссылка должна начинаться с https://' };
  if (def.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) return { error: 'Проверьте e-mail' };
  if (def.type === 'select' && !def.options.some((o) => o.value === value)) return { error: 'Выберите значение из списка' };
  return { value };
}

function render(req, res, tab, { status = 200, values = null, fields = {}, error = null } = {}) {
  const group = settings.SETTINGS_GROUPS.find((g) => g.id === tab) || settings.SETTINGS_GROUPS[0];
  const items = settings.describe(group.id).map((s) => (values && values[s.key] !== undefined ? { ...s, value: values[s.key] } : s));
  res.status(status).render(view('settings/index'), {
    title: 'Настройки',
    section: 'settings',
    groups: settings.SETTINGS_GROUPS,
    group,
    hint: GROUP_HINTS[group.id] || '',
    items,
    fields,
    error,
    payment: group.id === 'payments' ? paymentStatus() : null,
    bot: group.id === 'bot' ? botStatus() : null,
  });
}

router.get('/', (req, res) => {
  render(req, res, typeof req.query.tab === 'string' ? req.query.tab : 'general');
});

router.post('/:group', wrap((req, res, next) => {
  const group = settings.SETTINGS_GROUPS.find((g) => g.id === req.params.group);
  if (!group) return next();
  const submitted = req.body.s && typeof req.body.s === 'object' && !Array.isArray(req.body.s) ? req.body.s : {};
  const values = {};
  const fields = {};
  for (const def of settings.SETTINGS_SCHEMA.filter((s) => s.group === group.id)) {
    if (typeof submitted[def.key] !== 'string') continue;
    const result = validate(def, submitted[def.key]);
    if (result.error) {
      fields[def.key] = result.error;
      values[def.key] = submitted[def.key];
    } else {
      values[def.key] = result.value;
    }
  }
  if (Object.keys(fields).length) {
    return render(req, res, group.id, { status: 422, values, fields, error: 'Проверьте отмеченные поля — настройки не сохранены' });
  }
  settings.setMany(values);
  req.flash('success', `Настройки сохранены: ${group.title.toLowerCase()}`);
  return res.redirect(`/admin/settings?tab=${group.id}`);
}));

export default router;
