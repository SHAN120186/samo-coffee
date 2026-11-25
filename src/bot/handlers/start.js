// /start (registration + deep links), /help, the main menu and the "open the shop" button.
import { config } from '../../config.js';
import * as analytics from '../../services/analytics.js';
import * as customers from '../../services/customers.js';
import * as orders from '../../services/orders.js';
import * as settings from '../../services/settings.js';
import { tgDisplayName } from '../../services/tgUsers.js';
import { escapeTg } from '../../lib/escape.js';
import { cb, inline, mainKeyboard, shopButton, shopLabel } from '../keyboards.js';
import { parseStartParam } from '../deeplink.js';
import { clearState } from '../state.js';
import { sendCard } from '../photos.js';
import { ack } from '../ui.js';
import { showCategories, showProduct } from './catalog.js';
import { showPlans, showPlan } from './subscription.js';
import { showOrders, openOrderByNumber } from './orders.js';
import { enterSupport } from './support.js';
import * as texts from '../texts.js';

const BANNER = '/img/tma-banner.svg';

/** Message with the button that opens the Mini App (or the link to it in local development). */
export async function sendShopCard(ctx) {
  await ack(ctx);
  const button = shopButton();
  const rows = [[button], [cb('☕ Каталог в чате', 'cats!'), cb('🔁 Подписка', 'plans!')]];
  const text = button
    ? `<b>${escapeTg(shopLabel())}</b>\nВесь каталог, корзина, подписка и история заказов — в мини-приложении, прямо в Telegram.`
    : [
      `<b>Магазин ${escapeTg(settings.get('site_name', 'Samo Coffee'))}</b>`,
      'Каталог можно полистать прямо в чате — кнопки ниже.',
      `Мини-приложение откроется кнопкой, когда у сайта будет публичный HTTPS-адрес. Сейчас оно здесь: ${escapeTg(config.tma.url)}`,
    ].join('\n');
  await sendCard(ctx.api, ctx.chat.id, BANNER, text, { reply_markup: inline(rows) });
}

/**
 * /start [payload]. The Telegram user is already registered by the tracking middleware (with the
 * payload as start_param); here the customer record is created, the start is counted in analytics
 * and the deep link is opened.
 */
export async function onStart(ctx) {
  const from = ctx.from;
  const link = parseStartParam(ctx.match);
  clearState(from.id);

  // A site order opened through its deep link is linked to the customer who placed it after the
  // phone is confirmed — do not create a second, empty customer for the same person here.
  const claimable = link.kind === 'order' && (() => {
    const order = orders.getOrderByNumber(link.value);
    return Boolean(order && !order.tg_user_id && order.customer_phone);
  })();
  if (!claimable && !customers.getCustomerByTgUserId(from.id)) {
    customers.upsertCustomer({ name: tgDisplayName(from), tgUserId: from.id, tgUsername: from.username, source: 'bot' });
  }

  analytics.trackEvent('bot_start', {
    channel: 'bot',
    tgUserId: from.id,
    meta: { start_param: link.raw, source: link.source, new_user: Boolean(ctx.isNewUser) },
  });

  await ctx.reply(texts.welcome(from.first_name), { reply_markup: mainKeyboard() });
  switch (link.kind) {
    case 'order': return openOrderByNumber(ctx, link.value);
    case 'plan': return showPlan(ctx, link.value);
    case 'product': return showProduct(ctx, link.value);
    case 'catalog': return showCategories(ctx);
    case 'plans': return showPlans(ctx);
    case 'orders': return showOrders(ctx);
    case 'support': return enterSupport(ctx);
    default: return sendShopCard(ctx);
  }
}

export async function onHelp(ctx) {
  await ctx.reply(texts.help(), { reply_markup: mainKeyboard() });
}

/** /menu, "Отмена" outside a flow: bring the keyboard back. */
export async function onMenu(ctx) {
  clearState(ctx.from.id);
  await ack(ctx);
  await ctx.reply('Главное меню — кнопки ниже 👇', { reply_markup: mainKeyboard() });
}
