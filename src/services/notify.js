// Telegram notifications. Every function is best-effort: it never throws and resolves to the
// sent Message (or null when the bot is not configured / the call failed).
import { config } from '../config.js';
import * as tg from '../lib/telegramApi.js';
import { escapeTg } from '../lib/escape.js';
import { formatSum } from '../lib/money.js';
import * as settings from './settings.js';
import { markTgBlocked } from './tgUsers.js';

export const ORDER_STATUS_LABELS = {
  new: 'Новый',
  pending_payment: 'Ожидает оплаты',
  paid: 'Оплачен',
  processing: 'Собирается',
  shipped: 'Передан курьеру',
  delivered: 'Доставлен',
  cancelled: 'Отменён',
  refunded: 'Возврат',
};
export const PAYMENT_STATUS_LABELS = {
  unpaid: 'Не оплачен',
  pending: 'Ожидает оплаты',
  paid: 'Оплачен',
  failed: 'Ошибка оплаты',
  refunded: 'Возвращён',
};
export const CHANNEL_LABELS = { site: 'Сайт', tma: 'Мини-приложение', bot: 'Бот', admin: 'Админ-панель' };

const pending = new Set();
/** Track a background promise so tests can await flush(). */
function track(promise) {
  const p = Promise.resolve(promise).catch((err) => {
    console.error('[notify] failed:', err?.message || err);
    return null;
  });
  pending.add(p);
  p.finally(() => pending.delete(p));
  return p;
}
/** Wait for all in-flight notifications (tests, graceful shutdown). */
export async function flush() {
  while (pending.size) await Promise.allSettled([...pending]);
}

/** True when notifications can be delivered at all. */
export const isEnabled = () => tg.isConfigured();

/** Send an HTML message to ADMIN_CHAT_ID. */
export function notifyAdmins(html, extra = {}) {
  if (!tg.isConfigured() || !config.bot.adminChatId) return Promise.resolve(null);
  return track(tg.trySendMessage(config.bot.adminChatId, html, extra));
}

/** Send an HTML message to a Telegram user (private chat id == user id). Marks blocked users. */
export function notifyTgUser(tgUserId, html, extra = {}) {
  if (!tg.isConfigured() || !tgUserId) return Promise.resolve(null);
  return track(
    tg.sendMessage(tgUserId, html, extra).catch((err) => {
      if (err.isBlocked) markTgBlocked(tgUserId, true);
      if (!config.isTest) console.warn(`[notify] user ${tgUserId}: ${err.message}`);
      return null;
    }),
  );
}

/** Public status page of an order. */
export const orderUrl = (order) => `${config.baseUrl}/order/${order.public_token}`;
/** Admin page of an order. */
export const adminOrderUrl = (order) => `${config.baseUrl}/admin/orders/${order.id}`;

// Telegram rejects inline URL buttons that are not public HTTPS links.
const linkButton = (text, url) => (config.isHttps ? { reply_markup: { inline_keyboard: [[{ text, url }]] } } : {});

function itemsLines(order) {
  return (order.items || []).map((i) => `• ${escapeTg(i.title)} × ${i.qty} — ${formatSum(i.total)}`).join('\n');
}

/** Admin-facing order card (HTML). */
export function formatOrderForAdmin(order, title = 'Новый заказ') {
  const lines = [
    `🧾 <b>${escapeTg(title)} ${escapeTg(order.number)}</b>`,
    `${CHANNEL_LABELS[order.channel] || order.channel} · ${order.kind === 'subscription' ? 'подписка' : 'товары'}`,
    '',
    itemsLines(order),
    '',
    order.delivery_fee ? `Доставка: ${formatSum(order.delivery_fee)}` : null,
    `<b>Итого: ${formatSum(order.total)}</b>`,
    '',
    `👤 ${escapeTg(order.customer_name)}${order.customer_phone ? `, ${escapeTg(order.customer_phone)}` : ''}`,
    order.delivery_method === 'pickup' ? '📍 Самовывоз' : order.delivery_address ? `📍 ${escapeTg(order.delivery_address)}` : null,
    order.comment ? `💬 ${escapeTg(order.comment)}` : null,
  ];
  return lines.filter((l) => l !== null).join('\n');
}

/** New order → admins. */
export function orderCreated(order) {
  return notifyAdmins(formatOrderForAdmin(order, 'Новый заказ'), linkButton('Открыть в админке', adminOrderUrl(order)));
}

/** Order paid → admins + customer. */
export function orderPaid(order) {
  const customerText = settings
    .get('bot_order_paid_text')
    .replaceAll('{number}', order.number)
    .replaceAll('{total}', formatSum(order.total));
  return Promise.all([
    notifyAdmins(`✅ <b>Оплачен заказ ${escapeTg(order.number)}</b> — ${formatSum(order.total)}\n${escapeTg(order.customer_name)}${order.payment_provider ? ` · ${escapeTg(order.payment_provider)}` : ''}`,
      linkButton('Открыть в админке', adminOrderUrl(order))),
    order.tg_user_id
      ? notifyTgUser(order.tg_user_id, `✅ ${escapeTg(customerText)}\n\n${itemsLines(order)}\n<b>Итого: ${formatSum(order.total)}</b>`, linkButton('Статус заказа', orderUrl(order)))
      : null,
  ]);
}

const CUSTOMER_STATUS_TEXT = {
  processing: (o) => `☕ Заказ <b>${escapeTg(o.number)}</b> собирается: обжарщик уже пакует ваш кофе.`,
  shipped: (o) => `🚚 Заказ <b>${escapeTg(o.number)}</b> передан курьеру. Скоро будет у вас!`,
  delivered: (o) => `🎉 Заказ <b>${escapeTg(o.number)}</b> доставлен. Вкусного кофе! Если что-то не так — просто напишите сюда.`,
  cancelled: (o) => `Заказ <b>${escapeTg(o.number)}</b> отменён. Если это ошибка — напишите нам, всё исправим.`,
  refunded: (o) => `Оформили возврат по заказу <b>${escapeTg(o.number)}</b> на ${formatSum(o.total)}. Деньги вернутся на карту в течение нескольких дней.`,
};

/** Status change → customer (only for statuses the customer cares about). */
export function orderStatusChanged(order, from, to) {
  const build = CUSTOMER_STATUS_TEXT[to];
  if (!build || !order.tg_user_id) return Promise.resolve(null);
  return notifyTgUser(order.tg_user_id, build(order), linkButton('Статус заказа', orderUrl(order)));
}

/** Payment failed → customer. */
export function paymentFailed(order) {
  if (!order.tg_user_id) return Promise.resolve(null);
  return notifyTgUser(order.tg_user_id, `⚠️ Оплата заказа <b>${escapeTg(order.number)}</b> не прошла. Деньги не списаны — попробуйте ещё раз.`,
    linkButton('Оплатить', orderUrl(order)));
}

/** Subscription activated / renewed → customer. */
export function subscriptionActivated(subscription, order, renewed) {
  if (!order?.tg_user_id) return Promise.resolve(null);
  const until = new Date(subscription.current_period_end).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Asia/Tashkent' });
  const title = subscription.plan_title ? `«${escapeTg(subscription.plan_title)}»` : '';
  return notifyTgUser(order.tg_user_id, `${renewed ? '🔁 Подписка продлена' : '🌿 Подписка оформлена'} ${title}\nДействует до ${until}.`);
}
