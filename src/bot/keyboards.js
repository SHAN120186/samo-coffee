// Keyboards and link helpers. Callback data vocabulary (max 64 bytes) — routed in bot.js:
//
//   menu                 main menu hint            cats            category list
//   cat:<id>:<page>      products of a category    p:<id>          product card
//   buy:<id>             buy a product             plans           subscription plans
//   plan:<id>            plan card                 sub:<id>        subscribe to a plan
//   renew                renew my subscription     subscription    my subscription
//   orders               my orders                 o:<id>          order card
//   pay:<id>             pay an order              support         support mode
//   co:<action>          checkout steps: courier | addr | pickup | delivery | ok | cancel | qty:+ | qty:-
//   fb:close:<threadId>  (admin chat) close a feedback thread
//   noop                 inert button (page counter)
import { config } from '../config.js';
import * as settings from '../services/settings.js';

export const MENU = {
  catalog: '☕ Каталог',
  orders: '📦 Мои заказы',
  subscription: '🔁 Моя подписка',
  support: '💬 Поддержка',
};
export const CANCEL_TEXT = '✖️ Отмена';
export const SHARE_PHONE_TEXT = '📱 Отправить мой номер';

const isLocalHost = (host) =>
  host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.test') ||
  /^127\./.test(host) || host === '0.0.0.0' || host.startsWith('[') || !host.includes('.');

/**
 * Can this URL be used in an inline URL button? Telegram refuses links it cannot open from the
 * outside ("localhost", loopback addresses), so in local development links are sent as text instead.
 */
export function isButtonUrl(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !isLocalHost(u.hostname);
  } catch {
    return false;
  }
}

/** Absolute URL of a site path ("/order/abc" → "https://shop.example/order/abc"). */
export const siteUrl = (path = '/') => `${config.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

/** Text of the Mini App button (Admin → Settings → "Бот: текст кнопки мини-приложения"). */
export const shopLabel = () => settings.get('bot_menu_button_text', 'Открыть магазин');
/** The same text as it appears on the reply keyboard. */
export const shopMenuText = () => `🛍 ${shopLabel()}`;

/** Mini Apps need HTTPS. */
export const canOpenWebApp = () => /^https:\/\//i.test(config.tma.url) && isButtonUrl(config.tma.url);

/**
 * Inline button that opens the shop: a web_app button when the Mini App URL is HTTPS,
 * a plain URL button for a public http address, null in local development.
 */
export function shopButton(text = shopMenuText()) {
  if (canOpenWebApp()) return { text, web_app: { url: config.tma.url } };
  if (isButtonUrl(config.tma.url)) return { text, url: config.tma.url };
  return null;
}

/** URL button or null when Telegram would reject the link. */
export const urlButton = (text, url) => (isButtonUrl(url) ? { text, url } : null);

/** Callback button. */
export const cb = (text, data) => ({ text, callback_data: data });

/** Build an inline keyboard from rows, dropping null buttons and empty rows. Returns undefined when nothing is left. */
export function inline(rows) {
  const kept = rows.map((row) => (Array.isArray(row) ? row : [row]).filter(Boolean)).filter((row) => row.length);
  return kept.length ? { inline_keyboard: kept } : undefined;
}

/** Persistent main menu (reply keyboard). */
export function mainKeyboard() {
  return {
    keyboard: [
      [{ text: MENU.catalog }, { text: MENU.orders }],
      [{ text: MENU.subscription }, { text: MENU.support }],
      [{ text: shopMenuText() }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: 'Выберите раздел или напишите нам',
  };
}

/** One-time keyboard that asks for the user's own phone number. */
export function phoneKeyboard() {
  return {
    keyboard: [[{ text: SHARE_PHONE_TEXT, request_contact: true }], [{ text: CANCEL_TEXT }]],
    resize_keyboard: true,
    one_time_keyboard: true,
    input_field_placeholder: '+998 90 123 45 67',
  };
}

/** Which main-menu entry (if any) a text message is. */
export function menuAction(text) {
  const t = String(text || '').trim();
  if (t === MENU.catalog) return 'catalog';
  if (t === MENU.orders) return 'orders';
  if (t === MENU.subscription) return 'subscription';
  if (t === MENU.support) return 'support';
  if (t === shopMenuText() || t.startsWith('🛍')) return 'shop';
  if (t === CANCEL_TEXT || /^отмена$/i.test(t)) return 'cancel';
  return null;
}
