// Message texts and card formatters (Telegram HTML). Every piece of user/DB text goes through escapeTg().
import { escapeTg, plural, truncate } from '../lib/escape.js';
import { formatSum } from '../lib/money.js';
import { formatDate, formatDateTime, formatDayMonth } from '../lib/dates.js';
import * as settings from '../services/settings.js';
import * as cart from '../services/cart.js';
import { formatPhone } from '../services/customers.js';
import { FEEDBACK_CHANNEL_LABELS } from '../services/feedback.js';
import { fitCaption } from './photos.js';

const e = escapeTg;
const lines = (...parts) => parts.flat(Infinity).filter((l) => l !== null && l !== undefined && l !== false).join('\n');
const lower = (s) => String(s || '').toLocaleLowerCase('ru');

export const STATUS_ICON = {
  new: '🆕', pending_payment: '⏳', paid: '✅', processing: '☕', shipped: '🚚', delivered: '🎉', cancelled: '✖️', refunded: '↩️',
};

/** 30 → "месяц", 7 → "неделю", 90 → "3 месяца", 10 → "10 дней" (accusative: "на …", "за …"). */
export function periodLabel(days) {
  const d = Number(days) || 30;
  if (d === 7) return 'неделю';
  if (d === 14) return '2 недели';
  if (d === 30 || d === 31) return 'месяц';
  if (d % 30 === 0 && d <= 360) return `${d / 30} ${plural(d / 30, ['месяц', 'месяца', 'месяцев'])}`;
  return `${d} ${plural(d, ['день', 'дня', 'дней'])}`;
}

export const daysLabel = (n) => `${n} ${plural(n, ['день', 'дня', 'дней'])}`;

// ─────────────────────────────── general

export function welcome(firstName) {
  const name = String(firstName || '').trim() || 'друг';
  return e(settings.get('bot_welcome_text')).replaceAll('{name}', e(name));
}

/** Shop name from Admin → Настройки (so a rebranded shop needs no code changes). */
const brand = () => e(settings.get('site_name', 'Samo Coffee'));

export const help = () => lines(
  `<b>Что умеет бот ${brand()}</b>`,
  '',
  '☕ <b>Каталог</b> — зерно, дрип-пакеты и аксессуары, покупка в пару касаний',
  '📦 <b>Мои заказы</b> — статусы и оплата',
  '🔁 <b>Моя подписка</b> — свежий кофе по расписанию',
  '💬 <b>Поддержка</b> — напишите сюда любое сообщение, ответит человек',
  '',
  'Команды: /catalog · /orders · /subscription · /support · /help',
);

export const adminHelp = () => lines(
  `<b>Админ-чат ${brand()}</b>`,
  '',
  'Сюда приходят новые заказы, оплаты и обращения клиентов.',
  '↩️ Чтобы ответить клиенту, сделайте <b>reply</b> на его сообщение — ответ уйдёт ему в Telegram и сохранится в админ-панели.',
  '',
  '/stats — посетители, заказы и выручка за сегодня',
  '/orders — последние 5 заказов',
);

export const supportIntro = () => lines(e(settings.get('bot_support_text')), '', '<i>Можно прислать текст, фото или файл. Чтобы вернуться в меню — нажмите любую кнопку ниже.</i>');
export const supportReceived = () => e(settings.get('bot_support_received_text'));

// ─────────────────────────────── catalog

export function categoriesText(categories) {
  return lines(
    `☕ <b>Каталог ${brand()}</b>`,
    'Обжариваем по средам и пятницам — к вам приедет свежее зерно.',
    '',
    categories.length ? 'Выберите раздел:' : 'Каталог пока пуст — загляните чуть позже.',
  );
}

export function categoryText(category, products, { page, pages, total }) {
  return lines(
    `<b>${e(category.title)}</b>${pages > 1 ? `  ·  стр. ${page + 1} из ${pages}` : ''}`,
    category.description ? e(category.description) : null,
    '',
    total
      ? products.map((p) => `• ${e(p.title)} — <b>${formatSum(p.price)}</b>${p.in_stock ? '' : ' <i>(нет в наличии)</i>'}`)
      : 'В этом разделе пока нет товаров.',
    total ? '' : null,
    total ? 'Нажмите на товар, чтобы посмотреть подробнее.' : null,
  );
}

export function productButtonLabel(product) {
  return truncate(`${product.title} · ${formatSum(product.price)}`, 60);
}

/** Product card — fits into a photo caption (1024 chars). */
export function productCard(product) {
  const head = [`<b>${e(product.title)}</b>`, product.subtitle ? `<i>${e(product.subtitle)}</i>` : null];
  const origin = [product.origin, product.process ? lower(product.process) : null].filter(Boolean).join(' · ');
  const roast = [product.roast ? `обжарка ${lower(product.roast)}` : null, product.weight_g ? `${product.weight_g} г` : null].filter(Boolean).join(' · ');
  const facts = [origin ? `🌍 ${e(origin)}` : null, roast ? `🔥 ${e(roast.charAt(0).toUpperCase() + roast.slice(1))}` : null];
  const price = `<b>${formatSum(product.price)}</b>${product.old_price > product.price ? `  <s>${formatSum(product.old_price)}</s>` : ''}`;
  const stock = !product.in_stock ? '⛔️ Нет в наличии' : product.stock <= 5 ? `⚡️ Осталось ${product.stock} шт.` : '✅ В наличии';
  const description = fitCaption([...head, ...facts, price, stock], product.description || '', 6);
  return lines(head, '', description ? [e(description), ''] : null, facts.some(Boolean) ? [facts, ''] : null, price, stock);
}

// ─────────────────────────────── plans & subscription

/** "• План — цена за период" lines (or a note that there are no plans). */
export function plansList(plans) {
  return plans.length
    ? plans.map((p) => `• <b>${e(p.title)}</b> — ${formatSum(p.price)} за ${periodLabel(p.period_days)}${p.badge ? ` · <i>${e(lower(p.badge))}</i>` : ''}`).join('\n')
    : 'Сейчас нет доступных планов — напишите нам, подберём вариант.';
}

export function plansText(plans) {
  return lines(
    '🔁 <b>Подписка на кофе</b>',
    'Свежая обжарка приезжает сама — выбираете план, мы подбираем лоты и привозим по расписанию. Доставка бесплатная.',
    '',
    plansList(plans),
  );
}

export function planCard(plan) {
  const head = [`🌿 <b>Подписка «${e(plan.title)}»</b>`, plan.badge ? `<i>${e(plan.badge)}</i>` : null];
  const perks = (plan.perks || []).slice(0, 8).map((p) => `• ${e(p)}`);
  const price = `<b>${formatSum(plan.price)}</b> за ${periodLabel(plan.period_days)} · доставка бесплатно`;
  const description = fitCaption([...head, ...perks, price], plan.description || '', 6);
  return lines(head, '', description ? [e(description), ''] : null, perks.length ? [perks, ''] : null, price);
}

export function subscriptionCard(sub) {
  const until = formatDate(sub.current_period_end);
  const left = sub.days_left;
  return lines(
    `🔁 <b>Подписка «${e(sub.plan_title)}»</b>`,
    '',
    `Статус: <b>${e(sub.status_label)}</b>`,
    sub.status === 'paused'
      ? `Оплаченный период — до ${until}. Чтобы возобновить доставки, напишите нам в поддержку.`
      : `Оплачена до <b>${until}</b>${left > 0 ? ` — ещё ${daysLabel(left)}` : ''}`,
    `Стоимость: ${formatSum(sub.plan_price)} за ${periodLabel(sub.plan_period_days)}`,
    sub.renewals > 0 ? `Продлевали: ${sub.renewals} ${plural(sub.renewals, ['раз', 'раза', 'раз'])}` : null,
    '',
    '<i>Продление добавляет новый период к оплаченному — дни не сгорают.</i>',
  );
}

export const noSubscription = (plans) => lines(
  '🔁 <b>У вас пока нет подписки</b>',
  '',
  'С подпиской свежий кофе приезжает сам: мы подбираем лоты под ваш вкус, обжариваем и привозим по расписанию. Доставка бесплатная.',
  '',
  plansList(plans),
);

// ─────────────────────────────── orders

export function orderItems(order) {
  return (order.items || []).map((i) => `• ${e(i.title)}${i.qty > 1 ? ` × ${i.qty}` : ''} — ${formatSum(i.total)}`);
}

export function deliveryLine(order) {
  if (order.delivery_method === 'pickup') return `🏪 Самовывоз: ${e(settings.get('pickup_address'))}`;
  if (order.delivery_address) return `🚚 Курьером: ${e(order.delivery_address)}`;
  return order.kind === 'subscription' ? '🚚 Адрес доставки уточним по телефону' : null;
}

/** Full order card for its owner. */
export function orderCard(order) {
  return lines(
    `📦 <b>Заказ ${e(order.number)}</b>`,
    `от ${formatDateTime(order.created_at)}`,
    '',
    orderItems(order),
    order.delivery_fee > 0 ? `Доставка: ${formatSum(order.delivery_fee)}` : null,
    `<b>Итого: ${formatSum(order.total)}</b>`,
    '',
    `${STATUS_ICON[order.status] || '•'} Статус: <b>${e(order.status_label)}</b>`,
    order.can_pay ? '💳 Ждёт оплаты' : null,
    deliveryLine(order),
    order.comment ? `💬 ${e(order.comment)}` : null,
  );
}

/** What a stranger may learn about an order by its number: nothing personal. */
export function orderTeaser(order) {
  return lines(
    `📦 <b>Заказ ${e(order.number)}</b>`,
    `${STATUS_ICON[order.status] || '•'} Статус: <b>${e(order.status_label)}</b>`,
  );
}

export function ordersListText(list) {
  if (!list.length) {
    return lines('📦 <b>У вас пока нет заказов</b>', '', 'Загляните в каталог — обжариваем по средам и пятницам, привозим в день заказа.');
  }
  return lines(
    '📦 <b>Ваши заказы</b>',
    '',
    list.map((o) => `${STATUS_ICON[o.status] || '•'} <b>${e(o.number)}</b> · ${formatDayMonth(o.created_at)} · ${formatSum(o.total)} — ${e(lower(o.status_label))}`),
    '',
    'Нажмите на заказ, чтобы посмотреть состав и статус.',
  );
}

export const orderButtonLabel = (o) => `${STATUS_ICON[o.status] || '•'} ${o.number} · ${formatSum(o.total)}`;

// ─────────────────────────────── checkout

/** Delivery fee of a draft in sums (subscriptions are delivered free). */
export function draftDelivery(draft, subtotal) {
  return draft.kind === 'plan' ? 0 : cart.calcDelivery(subtotal, draft.method || 'courier');
}

/**
 * @param {object} draft checkout draft (handlers/checkout.js)
 * @param {{ title: string, price: number }} item product or plan
 */
export function checkoutSummary(draft, item) {
  const qty = draft.kind === 'plan' ? 1 : draft.qty;
  const subtotal = item.price * qty;
  const fee = draftDelivery(draft, subtotal);
  const title = draft.kind === 'plan' ? `Подписка «${item.title}» на ${periodLabel(item.period_days)}` : item.title;
  return lines(
    '🧾 <b>Проверьте заказ</b>',
    '',
    `• ${e(title)}${qty > 1 ? ` × ${qty}` : ''} — ${formatSum(subtotal)}`,
    draft.method === 'pickup' ? null : `Доставка: ${fee > 0 ? formatSum(fee) : 'бесплатно'}`,
    `<b>Итого: ${formatSum(subtotal + fee)}</b>`,
    '',
    `👤 ${e(draft.name)}, ${e(formatPhone(draft.phone))}`,
    draft.method === 'pickup' ? `🏪 Самовывоз: ${e(settings.get('pickup_address'))}` : `🚚 Курьером: ${e(draft.address)}`,
    draft.method !== 'pickup' && settings.get('delivery_note') ? `<i>${e(settings.get('delivery_note'))}</i>` : null,
  );
}

export function deliveryQuestion(draft, item) {
  const subtotal = item.price * (draft.kind === 'plan' ? 1 : draft.qty);
  const fee = draft.kind === 'plan' ? 0 : cart.calcDelivery(subtotal, 'courier');
  return lines(
    '🚚 <b>Как получить заказ?</b>',
    '',
    `Курьером по Ташкенту — ${fee > 0 ? formatSum(fee) : 'бесплатно'}`,
    `Самовывоз — бесплатно: ${e(settings.get('pickup_address'))}`,
  );
}

export const askPhone = () => lines(
  '📱 <b>Оставьте номер телефона</b>',
  '',
  'Курьер позвонит перед доставкой. Нажмите кнопку ниже или напишите номер в формате +998 90 123 45 67.',
);

export const askAddress = () => 'Напишите адрес доставки одним сообщением: улица, дом, квартира, ориентир.';

export function paymentLinkText(order, url, { asButton }) {
  return lines(
    `🧾 <b>Заказ ${e(order.number)} оформлен</b>`,
    `К оплате: <b>${formatSum(order.total)}</b>`,
    '',
    asButton
      ? 'Оплатите по кнопке ниже — подтверждение придёт в этот чат.'
      : ['Оплатите по ссылке — подтверждение придёт в этот чат:', e(url)],
  );
}

export function invoiceIntro(order) {
  return lines(`🧾 <b>Заказ ${e(order.number)} оформлен</b>`, 'Счёт ниже — оплата проходит прямо в Telegram, подтверждение придёт в этот чат.');
}

// ─────────────────────────────── subscription reminders (scheduler)

export function subscriptionExpiring(sub) {
  const left = Math.max(1, sub.days_left);
  return lines(
    `⏰ <b>Подписка «${e(sub.plan_title)}» скоро закончится</b>`,
    '',
    `Оплаченный период — до ${formatDate(sub.current_period_end)} (${left === 1 ? 'остался 1 день' : `осталось ${daysLabel(left)}`}).`,
    `Продлите сейчас за ${formatSum(sub.plan_price)} — новый период добавится к текущему, дни не сгорят.`,
  );
}

export function subscriptionExpired(sub) {
  return lines(
    `☕ <b>Подписка «${e(sub.plan_title)}» закончилась</b>`,
    '',
    `Оплаченный период истёк ${formatDate(sub.current_period_end)}. Оформите её заново — и свежая обжарка снова будет приезжать сама.`,
  );
}

// ─────────────────────────────── admin chat

/** Header of a customer message forwarded to the admin chat. */
export function feedbackHeader(thread, tgUser, { isNew }) {
  const who = [
    e(thread.name || 'Без имени'),
    tgUser?.username ? `@${e(tgUser.username)}` : null,
    tgUser?.id ? `id <code>${tgUser.id}</code>` : null,
  ].filter(Boolean).join(' · ');
  return lines(
    `💬 <b>Обращение #${thread.id}</b> · ${FEEDBACK_CHANNEL_LABELS[thread.channel] || thread.channel}${isNew ? ' · новое' : ''}`,
    `👤 ${who}`,
  );
}

export const FEEDBACK_REPLY_HINT = '<i>↩️ Ответьте на это сообщение (reply) — клиент получит ответ в Telegram.</i>';

export function adminOrderLine(o) {
  return lines(
    `${STATUS_ICON[o.status] || '•'} <b>${e(o.number)}</b> · ${formatSum(o.total)} · ${e(lower(o.status_label))}`,
    `   ${formatDateTime(o.created_at)} · ${e(o.channel_label)} · ${e(o.customer_name)}${o.customer_phone ? `, ${e(formatPhone(o.customer_phone))}` : ''}`,
  );
}

export function statsText(s, { date, openFeedback, activeSubscriptions }) {
  return lines(
    `📊 <b>Сегодня, ${e(date)}</b>`,
    '',
    `👥 Посетители: <b>${s.visitors}</b> · просмотров ${s.pageViews}`,
    `🧾 Заказы: <b>${s.orders}</b>, оплачено ${s.paidOrders}`,
    `💰 Выручка: <b>${formatSum(s.revenue)}</b>${s.paidOrders ? ` · средний чек ${formatSum(s.avgCheck)}` : ''}`,
    `🤖 Бот: ${s.botStarts} ${plural(s.botStarts, ['запуск', 'запуска', 'запусков'])} · мини-приложение: ${s.tmaOpens} ${plural(s.tmaOpens, ['открытие', 'открытия', 'открытий'])}`,
    `🔁 Активных подписок: ${activeSubscriptions}${s.newSubscriptions ? ` (+${s.newSubscriptions} сегодня)` : ''}`,
    `💬 Обращений ждут ответа: ${openFeedback}`,
  );
}
