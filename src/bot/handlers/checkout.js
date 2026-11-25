// Buying from the chat: one product ("Купить") or a subscription plan ("Оформить подписку").
//
// The draft lives in tg_users.state_data while the state is 'checkout':
//   { kind: 'product'|'plan', id, qty, step, name, phone, method, address, savedAddress }
//   step: 'phone' → 'delivery' → 'address' (courier only) → 'confirm'
// What we already know about the customer (phone, address of the previous order) is reused, so a
// returning customer gets from "Купить" to the invoice in two taps.
// The order itself is created by the orders service (createFromCart / createSubscriptionOrder).
import * as catalog from '../../services/catalog.js';
import * as cart from '../../services/cart.js';
import * as customers from '../../services/customers.js';
import * as orders from '../../services/orders.js';
import * as subscriptions from '../../services/subscriptions.js';
import * as analytics from '../../services/analytics.js';
import { tgDisplayName } from '../../services/tgUsers.js';
import { AppError } from '../../lib/errors.js';
import { clean, escapeTg, truncate } from '../../lib/escape.js';
import { formatSum } from '../../lib/money.js';
import { cb, inline, mainKeyboard, phoneKeyboard } from '../keyboards.js';
import { parseStartParam } from '../deeplink.js';
import { STATES, setState, clearState, getState, getMemo, patchMemo } from '../state.js';
import { ack, show, dropButtons } from '../ui.js';
import { sendPayment } from './payments.js';
import * as texts from '../texts.js';

/** The bot keeps its own one-item cart per user, so the Mini App cart of the same user is left alone. */
const cartRef = (userId) => ({ token: `bot:${userId}` });

/** Traffic source label stored with the order: the user's first deep-link payload ("insta", "qr_cafe") or "telegram". */
export function orderSource(tgUser) {
  const link = parseStartParam(tgUser?.start_param);
  return link.kind === 'source' ? link.value : 'telegram';
}

/** Name for the order: what the customer told us before, else the Telegram name. */
function customerName(customer, from) {
  const name = clean(customer?.name || tgDisplayName(from), 120);
  return name.length >= 2 ? name : 'Клиент Telegram';
}

/** Phone from a shared contact or typed text → "+998901234567" or null. */
export function parsePhone(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  return customers.normalizePhone(raw) || (/^\d{10,15}$/.test(raw) ? customers.normalizePhone(`+${raw}`) : null);
}

function loadItem(draft) {
  if (draft.kind === 'plan') {
    const plan = subscriptions.getPlan(draft.id);
    return plan && plan.active ? plan : null;
  }
  const product = catalog.getProduct(draft.id);
  return product && product.active ? product : null;
}

const maxQty = (product) => Math.max(1, Math.min(product.stock, cart.MAX_QTY_PER_ITEM));

function summaryKeyboard(draft, item) {
  const qty = draft.kind === 'plan' ? 1 : draft.qty;
  const subtotal = item.price * qty;
  const total = subtotal + texts.draftDelivery(draft, subtotal);
  return inline([
    draft.kind === 'product' ? [cb('−', 'co:qty:-'), cb(`${qty} шт.`, 'noop'), cb('+', 'co:qty:+')] : [],
    [cb(`✅ Оформить · ${formatSum(total)}`, 'co:ok')],
    [cb('🚚 Изменить доставку', 'co:delivery'), cb('✖️ Отмена', 'co:cancel')],
  ]);
}

/** Save the draft and show the screen of its current step. */
async function render(ctx, draft, item) {
  const userId = ctx.from.id;
  if (!draft.phone) {
    draft.step = 'phone';
    setState(userId, STATES.checkout, draft);
    ctx.fresh = true;
    return ctx.reply(texts.askPhone(), { reply_markup: phoneKeyboard() });
  }
  if (!draft.method) {
    draft.step = 'delivery';
    setState(userId, STATES.checkout, draft);
    const fee = draft.kind === 'plan' ? 0 : cart.calcDelivery(item.price * draft.qty, 'courier');
    return show(ctx, texts.deliveryQuestion(draft, item), inline([
      [cb(`🚚 Курьером · ${fee > 0 ? formatSum(fee) : 'бесплатно'}`, 'co:courier')],
      [cb('🏪 Самовывоз · бесплатно', 'co:pickup')],
      [cb('✖️ Отмена', 'co:cancel')],
    ]));
  }
  if (draft.method === 'courier' && !draft.address) {
    draft.step = 'address';
    setState(userId, STATES.checkout, draft);
    return show(ctx, texts.askAddress(), inline([
      draft.savedAddress ? [cb(`📍 ${truncate(draft.savedAddress, 44)}`, 'co:addr')] : [],
      [cb('✖️ Отмена', 'co:cancel')],
    ]));
  }
  draft.step = 'confirm';
  setState(userId, STATES.checkout, draft);
  return show(ctx, texts.checkoutSummary(draft, item), summaryKeyboard(draft, item));
}

/** "Купить" / "Оформить подписку": open a draft and ask only for what is still unknown. */
export async function startCheckout(ctx, kind, id) {
  const draft = { kind: kind === 'plan' ? 'plan' : 'product', id: Number(id), qty: 1 };
  const item = loadItem(draft);
  if (!item) {
    await ack(ctx, draft.kind === 'plan' ? 'Этот план сейчас недоступен' : 'Этот товар больше не продаётся', { alert: true });
    return;
  }
  if (draft.kind === 'product' && !item.in_stock) {
    await ack(ctx, `«${item.title}» закончился — напишите нам, сообщим о новой обжарке`, { alert: true });
    return;
  }
  await ack(ctx);
  const customer = customers.getCustomerByTgUserId(ctx.from.id);
  // the memo keeps the phone / address of the previous bot order of this Telegram user
  const memo = getMemo(ctx.from.id);
  draft.name = customerName(customer, ctx.from);
  draft.phone = customer?.phone || memo.phone || '';
  draft.method = '';
  draft.address = '';
  draft.savedAddress = clean(customer?.address || memo.address, 300);
  analytics.trackEvent('begin_checkout', {
    channel: 'bot', tgUserId: ctx.from.id, value: item.price,
    ...(draft.kind === 'product' ? { productId: item.id } : { meta: { plan_id: item.id } }),
  });
  ctx.fresh = true; // the card with the "Купить" button stays where it is
  await render(ctx, draft, item);
}

/** Current draft + its product/plan, or null when the checkout is no longer active. */
function current(ctx) {
  const { state, data } = getState(ctx.from.id);
  if (state !== STATES.checkout || !data.kind) return null;
  const item = loadItem(data);
  return { draft: data, item };
}

export async function cancelCheckout(ctx, { silent = false } = {}) {
  clearState(ctx.from.id);
  if (silent) return;
  await ack(ctx, 'Заказ отменён');
  await dropButtons(ctx);
  await ctx.reply('Заказ не оформлен. Когда захотите — каталог всегда под рукой ☕', { reply_markup: mainKeyboard() });
}

/** Buttons of the checkout screens: co:<action>. */
export async function onCheckoutAction(ctx, action, arg) {
  const active = current(ctx);
  if (!active) {
    await ack(ctx, 'Этот заказ уже неактуален. Начните заново из каталога.', { alert: true });
    await dropButtons(ctx);
    return;
  }
  const { draft, item } = active;
  if (action === 'cancel') return cancelCheckout(ctx);
  if (!item || (draft.kind === 'product' && !item.in_stock)) {
    clearState(ctx.from.id);
    await ack(ctx, 'К сожалению, это предложение больше недоступно.', { alert: true });
    await dropButtons(ctx);
    return;
  }

  switch (action) {
    case 'courier':
      draft.method = 'courier';
      draft.address = '';
      break;
    case 'pickup':
      draft.method = 'pickup';
      draft.address = '';
      break;
    case 'addr':
      if (draft.step === 'address' && draft.savedAddress) draft.address = draft.savedAddress;
      break;
    case 'delivery':
      draft.method = '';
      draft.address = '';
      break;
    case 'qty': {
      if (draft.kind !== 'product' || draft.step !== 'confirm') break;
      const next = draft.qty + (arg === '+' ? 1 : -1);
      if (next < 1) {
        await ack(ctx, 'Меньше одной штуки не бывает 🙂');
        return;
      }
      if (next > maxQty(item)) {
        await ack(ctx, item.stock < cart.MAX_QTY_PER_ITEM ? `В наличии только ${item.stock} шт.` : `Не больше ${cart.MAX_QTY_PER_ITEM} шт. в одном заказе`);
        return;
      }
      draft.qty = next;
      break;
    }
    case 'ok':
      if (draft.step !== 'confirm') break;
      return placeOrder(ctx, draft, item);
    default:
      break;
  }
  await ack(ctx);
  await render(ctx, draft, item);
}

/** Create the order and ask for the payment. */
async function placeOrder(ctx, draft, item) {
  const userId = ctx.from.id;
  const input = {
    customer: { name: draft.name, phone: draft.phone },
    delivery: { method: draft.method, address: draft.address },
    channel: 'bot',
    tgUserId: userId,
    tgUsername: ctx.from.username,
    source: orderSource(ctx.tgUser),
  };
  let order;
  try {
    if (draft.kind === 'plan') {
      order = orders.createSubscriptionOrder({ planId: item.id, ...input });
    } else {
      const ref = cartRef(userId);
      cart.clearCart(ref);
      const view = cart.addItem(ref, item.id, draft.qty);
      const line = view.items.find((i) => i.product_id === item.id);
      if (!line || line.qty < draft.qty) {
        // somebody bought the last bags while this customer was thinking
        cart.clearCart(ref);
        draft.qty = Math.max(1, line?.qty || 1);
        await ack(ctx, `В наличии осталось ${line?.qty || 0} шт. — количество в заказе изменено`, { alert: true });
        return render(ctx, draft, catalog.getProduct(item.id));
      }
      order = orders.createFromCart(ref, input);
    }
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (err.code === 'validation' && err.details?.fields?.phone) draft.phone = '';
    if (err.code === 'validation' && err.details?.fields?.address) draft.address = '';
    await ack(ctx, err.message, { alert: true });
    if (err.code === 'validation') return render(ctx, draft, item);
    clearState(userId);
    await dropButtons(ctx);
    return;
  }
  await ack(ctx, 'Заказ оформлен');
  clearState(userId);
  patchMemo(userId, { phone: draft.phone, ...(draft.address ? { address: draft.address } : {}) });
  await dropButtons(ctx);
  await sendPayment(ctx, order);
}

/**
 * Text or a shared contact while the checkout is waiting for the phone or the address.
 * @returns {Promise<boolean>} true when the message was consumed by the checkout
 */
export async function onCheckoutInput(ctx) {
  const active = current(ctx);
  if (!active) return false;
  const { draft, item } = active;
  if (!item) {
    clearState(ctx.from.id);
    await ctx.reply('К сожалению, это предложение больше недоступно.', { reply_markup: mainKeyboard() });
    return true;
  }
  const message = ctx.message;
  ctx.fresh = true;

  if (draft.step === 'phone') {
    if (message.contact && message.contact.user_id && message.contact.user_id !== ctx.from.id) {
      await ctx.reply('Нужен ваш собственный номер — нажмите кнопку «📱 Отправить мой номер» или напишите его текстом.', { reply_markup: phoneKeyboard() });
      return true;
    }
    const phone = parsePhone(message.contact?.phone_number ?? message.text);
    if (!phone) {
      await ctx.reply('Не получилось разобрать номер. Напишите его в формате +998 90 123 45 67 или нажмите кнопку ниже.', { reply_markup: phoneKeyboard() });
      return true;
    }
    draft.phone = phone;
    await ctx.reply(`Номер ${escapeTg(customers.formatPhone(phone))} сохранён ✅`, { reply_markup: mainKeyboard() });
    await render(ctx, draft, item);
    return true;
  }

  if (draft.step === 'address' && typeof message.text === 'string') {
    const address = clean(message.text, 300);
    if (address.length < 5) {
      await ctx.reply('Адрес слишком короткий. Напишите улицу, дом и квартиру одним сообщением.');
      return true;
    }
    draft.address = address;
    await render(ctx, draft, item);
    return true;
  }

  if (typeof message.text === 'string') {
    await ctx.reply('Чтобы продолжить заказ, нажмите кнопку под сообщением выше. Если появился вопрос — «💬 Поддержка» в меню.');
    return true;
  }
  return false;
}

/**
 * "Продлить": a new period for the current plan with the delivery details we already have.
 * Falls back to the regular checkout when something is missing.
 */
export async function renewSubscription(ctx) {
  const userId = ctx.from.id;
  const sub = subscriptions.getCurrentForTgUser(userId);
  if (!sub) return false;
  const customer = customers.getCustomerByTgUserId(userId);
  const plan = subscriptions.getPlan(sub.plan_id);
  if (!plan || !plan.active) {
    await ack(ctx, 'Этот план больше не продаётся — выберите другой', { alert: true });
    return false;
  }
  if (!customer?.phone) {
    await startCheckout(ctx, 'plan', plan.id);
    return true;
  }
  await ack(ctx);
  const order = orders.createSubscriptionOrder({
    planId: plan.id,
    customer: { name: customerName(customer, ctx.from), phone: customer.phone, email: customer.email || '' },
    delivery: { method: 'courier', address: customer.address || '' },
    channel: 'bot',
    tgUserId: userId,
    tgUsername: ctx.from.username,
    source: orderSource(ctx.tgUser),
  });
  clearState(userId);
  await sendPayment(ctx, order);
  return true;
}
