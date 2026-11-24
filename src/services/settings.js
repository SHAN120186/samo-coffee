// Key-value site settings with typed schema + defaults. Editable in Admin → Settings.
import { all, run, tx, now } from '../db/index.js';

/**
 * Every known setting. The admin settings screen can be rendered straight from this list.
 * type: text | textarea | number | url | email | tel | select
 */
export const SETTINGS_SCHEMA = [
  // ── general
  { key: 'site_name', group: 'general', label: 'Название сайта', type: 'text', default: 'Samo Coffee' },
  { key: 'site_tagline', group: 'general', label: 'Слоган', type: 'text', default: 'Обжарщики спешелти-кофе в Ташкенте' },
  { key: 'seo_title', group: 'general', label: 'SEO-заголовок по умолчанию', type: 'text', default: 'Samo Coffee — свежеобжаренный кофе с доставкой по Ташкенту' },
  { key: 'seo_description', group: 'general', label: 'SEO-описание по умолчанию', type: 'textarea', default: 'Спешелти-кофе собственной обжарки: зерно для эспрессо и фильтра, дрип-пакеты, аксессуары и подписка на кофе. Обжариваем каждую неделю, доставляем по Ташкенту за день.' },
  // ── contacts
  { key: 'phone', group: 'contacts', label: 'Телефон', type: 'tel', default: '+998 71 200 45 45' },
  { key: 'email', group: 'contacts', label: 'E-mail', type: 'email', default: 'hello@samo.coffee' },
  { key: 'address', group: 'contacts', label: 'Адрес', type: 'text', default: 'Ташкент, ул. Шота Руставели, 12' },
  { key: 'work_hours', group: 'contacts', label: 'Часы работы', type: 'text', default: 'Ежедневно с 8:00 до 22:00' },
  { key: 'map_url', group: 'contacts', label: 'Ссылка на карту', type: 'url', default: 'https://yandex.uz/maps/?text=Ташкент%2C%20Шота%20Руставели%2012' },
  // ── socials
  { key: 'social_instagram', group: 'socials', label: 'Instagram', type: 'url', default: 'https://instagram.com/samo.coffee' },
  { key: 'social_telegram', group: 'socials', label: 'Telegram-канал', type: 'url', default: 'https://t.me/samo_coffee' },
  { key: 'social_facebook', group: 'socials', label: 'Facebook', type: 'url', default: '' },
  { key: 'social_youtube', group: 'socials', label: 'YouTube', type: 'url', default: '' },
  // ── delivery
  { key: 'delivery_fee', group: 'delivery', label: 'Стоимость доставки курьером, сум', type: 'number', default: '25000' },
  { key: 'free_delivery_from', group: 'delivery', label: 'Бесплатная доставка от суммы, сум (0 — выключить)', type: 'number', default: '300000' },
  { key: 'pickup_address', group: 'delivery', label: 'Адрес самовывоза', type: 'text', default: 'Ташкент, ул. Шота Руставели, 12 (обжарочный цех Samo)' },
  { key: 'delivery_note', group: 'delivery', label: 'Примечание о доставке', type: 'text', default: 'Заказы до 15:00 привозим в тот же день' },
  // ── payments
  {
    key: 'payment_provider', group: 'payments', label: 'Платёжный провайдер', type: 'select', default: '',
    options: [
      { value: '', label: 'По умолчанию (из .env)' },
      { value: 'mock', label: 'Демо-оплата (тестовая страница)' },
      { value: 'telegram', label: 'Telegram Payments' },
      { value: 'payme', label: 'Payme' },
      { value: 'click', label: 'Click' },
    ],
  },
  // ── bot texts
  { key: 'bot_welcome_text', group: 'bot', label: 'Бот: приветствие (/start)', type: 'textarea', default: 'Здравствуйте, {name}! ☕\n\nЭто Samo Coffee — обжарщики спешелти-кофе в Ташкенте. Здесь можно заказать зерно и дрип-пакеты, оформить подписку и написать нам напрямую.' },
  { key: 'bot_support_text', group: 'bot', label: 'Бот: вход в режим поддержки', type: 'textarea', default: 'Напишите ваш вопрос одним или несколькими сообщениями — бариста на связи с 8:00 до 22:00 и ответит прямо здесь.' },
  { key: 'bot_support_received_text', group: 'bot', label: 'Бот: сообщение принято', type: 'textarea', default: 'Спасибо! Передали сообщение команде, ответим в этом чате.' },
  { key: 'bot_order_paid_text', group: 'bot', label: 'Бот: заказ оплачен', type: 'textarea', default: 'Оплата получена, спасибо! Заказ {number} уже у обжарщика — сообщим, когда передадим курьеру.' },
  { key: 'bot_menu_button_text', group: 'bot', label: 'Бот: текст кнопки мини-приложения', type: 'text', default: 'Открыть магазин' },
];

export const SETTINGS_GROUPS = [
  { id: 'general', title: 'Основное' },
  { id: 'contacts', title: 'Контакты' },
  { id: 'socials', title: 'Соцсети' },
  { id: 'delivery', title: 'Доставка' },
  { id: 'payments', title: 'Оплата' },
  { id: 'bot', title: 'Тексты бота' },
];

const DEFAULTS = Object.fromEntries(SETTINGS_SCHEMA.map((s) => [s.key, s.default]));
let cache = null;

function load() {
  if (!cache) {
    cache = { ...DEFAULTS };
    for (const row of all('SELECT key, value FROM settings')) cache[row.key] = row.value;
  }
  return cache;
}

/** Drop the in-memory cache (after writing to the settings table directly, e.g. in seeds/tests). */
export function clearCache() {
  cache = null;
}

/** All settings as a plain object { key: string } with defaults applied. */
export function getAll() {
  return { ...load() };
}

/** One setting as a string (fallback → schema default → ''). */
export function get(key, fallback = undefined) {
  const v = load()[key];
  if (v === undefined || v === null || v === '') return fallback !== undefined ? fallback : (DEFAULTS[key] ?? '');
  return v;
}

/** One setting as an integer. */
export function getInt(key, fallback = 0) {
  const n = Number.parseInt(get(key, ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Save one setting (any key is allowed; values are stored as strings). */
export function set(key, value) {
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    String(key), String(value ?? ''), now(),
  );
  cache = null;
}

/** Save several settings at once: setMany({ phone: '...', email: '...' }). */
export function setMany(values) {
  tx(() => {
    for (const [key, value] of Object.entries(values)) set(key, value);
  });
  cache = null;
}

/** Schema entries of a group with current values: [{ key, label, type, value, options? }]. */
export function describe(group = null) {
  const current = load();
  return SETTINGS_SCHEMA.filter((s) => !group || s.group === group).map((s) => ({ ...s, value: current[s.key] ?? s.default }));
}
