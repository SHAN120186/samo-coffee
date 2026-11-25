// "Мои заказы": list, order card, paying an unpaid order, and linking a site order that was opened
// through the deep link https://t.me/<bot>?start=order_SC-100042.
import * as orders from '../../services/orders.js';
import * as customers from '../../services/customers.js';
import { tgDisplayName } from '../../services/tgUsers.js';
import { cb, inline, mainKeyboard, phoneKeyboard, siteUrl, urlButton } from '../keyboards.js';
import { normalizeOrderNumber } from '../deeplink.js';
import { STATES, setState, clearState, getState, patchMemo } from '../state.js';
import { ack, show } from '../ui.js';
import { sendPayment } from './payments.js';
import { parsePhone } from './checkout.js';
import { onCustomerMessage } from './support.js';
import * as texts from '../texts.js';

const LIST_LIMIT = 8;

export async function showOrders(ctx) {
  const list = orders.listForTgUser(ctx.from.id, LIST_LIMIT);
  await ack(ctx);
  await show(ctx, texts.ordersListText(list), inline([
    ...list.map((o) => [cb(texts.orderButtonLabel(o), `o:${o.id}`)]),
    list.length ? [] : [cb('☕ В каталог', 'cats')],
  ]));
}

function orderKeyboard(order) {
  return inline([
    order.can_pay ? [cb('💳 Оплатить', `pay:${order.id}`)] : [],
    [urlButton('Открыть на сайте', siteUrl(order.url))],
    [cb('← Мои заказы', 'orders')],
  ]);
}

/** The order when it belongs to this Telegram user, otherwise null. */
function ownOrder(ctx, orderId) {
  const order = orders.getOrder(Number(orderId));
  return order && order.tg_user_id === ctx.from.id ? order : null;
}

export async function showOrder(ctx, orderId) {
  const order = ownOrder(ctx, orderId);
  if (!order) {
    await ack(ctx, 'Заказ не найден', { alert: true });
    return;
  }
  await ack(ctx);
  await show(ctx, texts.orderCard(order), orderKeyboard(order));
}

export async function payOrder(ctx, orderId) {
  const order = ownOrder(ctx, orderId);
  if (!order) {
    await ack(ctx, 'Заказ не найден', { alert: true });
    return;
  }
  if (!order.can_pay) {
    await ack(ctx, order.is_paid ? 'Этот заказ уже оплачен' : 'Этот заказ нельзя оплатить', { alert: true });
    ctx.fresh = false;
    await show(ctx, texts.orderCard(order), orderKeyboard(order));
    return;
  }
  await ack(ctx);
  await sendPayment(ctx, order);
}

/**
 * Deep link "order_<number>". The owner sees the full card. A site order without a Telegram user
 * can be claimed by confirming the phone it was placed with (own contact shared in Telegram);
 * until then only the status is shown — an order number alone reveals nothing personal.
 */
export async function openOrderByNumber(ctx, rawNumber) {
  const number = normalizeOrderNumber(rawNumber);
  const order = orders.getOrderByNumber(number);
  if (!order) {
    await ctx.reply(`Заказ ${number.replace(/[^\w-]/g, '')} не нашёлся. Проверьте номер или загляните в «📦 Мои заказы».`, { reply_markup: mainKeyboard() });
    return;
  }
  if (order.tg_user_id === ctx.from.id) {
    await ctx.reply(texts.orderCard(order), { reply_markup: orderKeyboard(order) });
    return;
  }
  if (order.tg_user_id || !order.customer_phone) {
    await ctx.reply(`${texts.orderTeaser(order)}\n\nПодробности видны в аккаунте Telegram, с которого оформлен заказ.`, { reply_markup: mainKeyboard() });
    return;
  }
  setState(ctx.from.id, STATES.linkOrder, { orderId: order.id });
  await ctx.reply(
    `${texts.orderTeaser(order)}\n\nЧтобы видеть состав заказа и получать уведомления о доставке, подтвердите номер телефона, указанный при оформлении, — нажмите кнопку ниже.`,
    { reply_markup: phoneKeyboard() },
  );
}

/**
 * A message while the bot waits for the phone confirmation of a site order.
 * @returns {Promise<boolean>} true when consumed
 */
export async function onLinkOrderInput(ctx) {
  const { state, data } = getState(ctx.from.id);
  if (state !== STATES.linkOrder) return false;
  const contact = ctx.message.contact;
  if (!contact) {
    if (typeof ctx.message.text !== 'string') return false;
    // a question instead of the contact is passed to the team (a typed number is not: it proves nothing)
    if (ctx.message.text.replace(/\D/g, '').length < 5) await onCustomerMessage(ctx);
    await ctx.reply('Чтобы подтвердить, что заказ ваш, нажмите «📱 Отправить мой номер» — так Telegram передаст именно ваш номер. Или нажмите «✖️ Отмена».', { reply_markup: phoneKeyboard() });
    return true;
  }
  if (contact.user_id !== ctx.from.id) {
    await ctx.reply('Нужен ваш собственный номер — нажмите кнопку «📱 Отправить мой номер».', { reply_markup: phoneKeyboard() });
    return true;
  }
  const order = orders.getOrder(Number(data.orderId));
  const phone = parsePhone(contact.phone_number);
  clearState(ctx.from.id);
  if (!order || !phone || order.customer_phone !== phone || (order.tg_user_id && order.tg_user_id !== ctx.from.id)) {
    await ctx.reply('Этот номер не совпадает с номером в заказе. Если заказ оформляли вы — напишите нам сюда, поможем.', { reply_markup: mainKeyboard() });
    return true;
  }
  orders.attachTgUser(order.id, ctx.from.id);
  // The phone is verified (own Telegram contact), so the customer record of the order and this
  // Telegram account are the same person: join them. A returning user keeps their record and gets
  // the orders / subscription of the site record; a new user takes the site record over.
  const customer = customers.linkTelegramAccount({
    tgUserId: ctx.from.id,
    tgUsername: ctx.from.username,
    phone,
    customerId: order.customer_id,
    contact: { name: order.customer_name, email: order.customer_email, address: order.delivery_address },
    name: tgDisplayName(ctx.from),
  });
  if (customer) orders.assignCustomer(order.id, customer.id);
  patchMemo(ctx.from.id, { phone });
  const fresh = orders.getOrder(order.id);
  await ctx.reply('Готово, заказ привязан к вашему Telegram ✅ Сообщим здесь, когда статус изменится.', { reply_markup: mainKeyboard() });
  await ctx.reply(texts.orderCard(fresh), { reply_markup: orderKeyboard(fresh) });
  return true;
}

/** Leave the phone-confirmation state (menu button / "Отмена"). */
export function cancelLinkOrder(userId) {
  if (getState(userId).state === STATES.linkOrder) clearState(userId);
}
