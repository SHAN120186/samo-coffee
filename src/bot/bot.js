// The grammY bot: one place that wires updates to handlers.
//
//   my_chat_member            user blocked / unblocked the bot → tg_users.is_blocked
//   pre_checkout_query        Telegram Payments: last check before charging
//   message.successful_payment → orders.markPaid (idempotent)
//   admin chat (ADMIN_CHAT_ID) /stats, /orders, replies to forwarded customer messages
//   private chats             /start, menu, catalog, orders, subscription, checkout, support
//   any other chat            ignored
//
// All Bot API traffic goes to config.bot.apiRoot (TELEGRAM_API_ROOT), so tests run against a local
// fake server: createBot({ botInfo }) + bot.handleUpdate(update).
import { Bot, GrammyError, HttpError } from 'grammy';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { escapeTg } from '../lib/escape.js';
import * as tgUsers from '../services/tgUsers.js';
import { installTransformers, isBlockedError } from './api.js';
import { menuAction, mainKeyboard } from './keyboards.js';
import { STATES, getState, clearState } from './state.js';
import { ack } from './ui.js';
import { onStart, onHelp, onMenu, sendShopCard } from './handlers/start.js';
import { showCategories, showCategory, showProduct } from './handlers/catalog.js';
import { showOrders, showOrder, payOrder, onLinkOrderInput, cancelLinkOrder } from './handlers/orders.js';
import { showPlans, showPlan, showSubscription, subscribe, renew } from './handlers/subscription.js';
import { startCheckout, onCheckoutAction, onCheckoutInput, cancelCheckout } from './handlers/checkout.js';
import { enterSupport, onCustomerMessage } from './handlers/support.js';
import { isAdminChat, onStats, onLastOrders, onAdminHelp, onAdminReply, onCloseThread } from './handlers/admin.js';
import { onPreCheckoutQuery, onSuccessfulPayment } from './handlers/payments.js';

/** Update types the bot needs (getUpdates / setWebhook `allowed_updates`). */
export const ALLOWED_UPDATES = ['message', 'callback_query', 'pre_checkout_query', 'my_chat_member'];

/** Commands shown in the "/" menu of private chats. */
export const USER_COMMANDS = [
  { command: 'start', description: 'Главное меню' },
  { command: 'catalog', description: 'Каталог: зерно, дрипы, аксессуары' },
  { command: 'orders', description: 'Мои заказы' },
  { command: 'subscription', description: 'Моя подписка' },
  { command: 'support', description: 'Написать в поддержку' },
  { command: 'help', description: 'Что умеет бот' },
];
/** Extra commands of the admin chat. */
export const ADMIN_COMMANDS = [
  { command: 'stats', description: 'Сегодня: посетители, заказы, выручка' },
  { command: 'orders', description: 'Последние 5 заказов' },
  { command: 'help', description: 'Как отвечать клиентам' },
];

const GENERIC_ERROR = 'Что-то пошло не так. Попробуйте ещё раз, а если не получится — напишите нам, мы на связи.';

/** Leave whatever flow the user was in when a menu section is opened. */
function leaveFlows(ctx) {
  const { state } = getState(ctx.from.id);
  if (state === STATES.checkout || state === STATES.linkOrder || state === STATES.support) clearState(ctx.from.id);
}

/** Buttons under messages in private chats. See keyboards.js for the vocabulary. */
async function onCallback(ctx) {
  let data = String(ctx.callbackQuery.data || '');
  // "orders!" — a trailing "!" asks for a new message instead of editing the one with the button
  if (data.endsWith('!')) {
    ctx.fresh = true;
    data = data.slice(0, -1);
  }
  const [action, a, b] = data.split(':');
  switch (action) {
    case 'noop': return ack(ctx);
    case 'menu': return onMenu(ctx);
    case 'cats': return showCategories(ctx);
    case 'cat': return showCategory(ctx, a, b);
    case 'p': return showProduct(ctx, a);
    case 'buy': return startCheckout(ctx, 'product', a);
    case 'plans': return showPlans(ctx);
    case 'plan': return showPlan(ctx, a);
    case 'sub': return subscribe(ctx, a);
    case 'renew': return renew(ctx);
    case 'subscription': return showSubscription(ctx);
    case 'orders': return showOrders(ctx);
    case 'o': return showOrder(ctx, a);
    case 'pay': return payOrder(ctx, a);
    case 'support': return enterSupport(ctx);
    case 'co': return onCheckoutAction(ctx, a, b);
    default: return ack(ctx, 'Эта кнопка устарела. Откройте меню: /start');
  }
}

/** Reply-keyboard buttons. Returns true when the text was a menu button. */
async function onMenuButton(ctx) {
  const action = menuAction(ctx.message.text);
  if (!action) return false;
  if (action === 'cancel') {
    const { state } = getState(ctx.from.id);
    if (state === STATES.checkout) await cancelCheckout(ctx);
    else await onMenu(ctx);
    return true;
  }
  if (action === 'support') {
    await enterSupport(ctx);
    return true;
  }
  leaveFlows(ctx);
  if (action === 'catalog') await showCategories(ctx);
  else if (action === 'orders') await showOrders(ctx);
  else if (action === 'subscription') await showSubscription(ctx);
  else if (action === 'shop') await sendShopCard(ctx);
  return true;
}

/**
 * Build the bot. Nothing is sent and no network call is made here.
 * @param {{ botInfo?: object }} [options] botInfo — result of getMe (skips bot.init(); used by index.js and tests)
 */
export function createBot({ botInfo } = {}) {
  const bot = new Bot(config.bot.token, { client: { apiRoot: config.bot.apiRoot }, ...(botInfo ? { botInfo } : {}) });
  installTransformers(bot.api);

  // ── the user blocked / unblocked the bot
  bot.on('my_chat_member', (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const status = ctx.myChatMember.new_chat_member.status;
    if (tgUsers.getTgUser(ctx.chat.id)) tgUsers.markTgBlocked(ctx.chat.id, status === 'kicked');
  });

  // ── Telegram Payments (the invoice may be paid from any chat it was forwarded to)
  bot.on('pre_checkout_query', onPreCheckoutQuery);
  bot.on('message:successful_payment', onSuccessfulPayment);

  // ── admin chat
  const admin = bot.filter(isAdminChat);
  admin.command('stats', onStats);
  admin.command('orders', onLastOrders);
  admin.callbackQuery(/^fb:close:(\d+)$/, (ctx) => onCloseThread(ctx, ctx.match[1]));
  admin.on('message', async (ctx, next) => {
    if (ctx.message.reply_to_message && await onAdminReply(ctx)) return;
    // The owner's private chat is also a normal customer chat (handy for demos); a staff group is not.
    if (ctx.chat.type === 'private') {
      if (ctx.message.text === '/help' || ctx.message.text?.startsWith('/help@')) await onAdminHelp(ctx);
      await next();
      return;
    }
    if (/^\/(help|start)(@\w+)?$/.test(ctx.message.text || '')) await onAdminHelp(ctx);
  });

  // ── private chats
  const pm = bot.chatType('private');

  // register / refresh the Telegram user on every update; "/start <payload>" stores the payload once
  pm.use(async (ctx, next) => {
    if (!ctx.from || ctx.from.is_bot) return;
    const startParam = /^\/start(?:@\w+)?\s+(\S{1,64})/.exec(ctx.message?.text || '')?.[1] || null;
    const { user, isNew } = tgUsers.upsertTgUser(ctx.from, { chatId: ctx.chat.id, startParam, source: 'bot' });
    ctx.tgUser = user;
    ctx.isNewUser = isNew;
    try {
      await next();
    } catch (err) {
      // service errors carry a message meant for the customer
      if (!(err instanceof AppError)) throw err;
      await ack(ctx, err.message, { alert: true });
      if (!ctx.callbackQuery) await ctx.reply(escapeTg(err.message), { reply_markup: mainKeyboard() });
    }
  });

  pm.command('start', onStart);
  pm.command('help', onHelp);
  pm.command(['menu', 'cancel'], (ctx) => (getState(ctx.from.id).state === STATES.checkout ? cancelCheckout(ctx) : onMenu(ctx)));
  pm.command('catalog', (ctx) => { leaveFlows(ctx); return showCategories(ctx); });
  pm.command('orders', (ctx) => { leaveFlows(ctx); return showOrders(ctx); });
  pm.command('subscription', (ctx) => { leaveFlows(ctx); return showSubscription(ctx); });
  pm.command('plans', (ctx) => { leaveFlows(ctx); return showPlans(ctx); });
  pm.command('support', enterSupport);

  pm.on('callback_query:data', onCallback);

  pm.on('message', async (ctx) => {
    const message = ctx.message;
    // service messages (pinned, payments handled above, etc.) are not customer messages
    const isContent = typeof message.text === 'string' || message.photo || message.document || message.video || message.animation
      || message.voice || message.audio || message.video_note || message.sticker || message.location || message.contact;
    if (!isContent) return;
    if (typeof message.text === 'string') {
      if (await onMenuButton(ctx)) return;
      if (message.text.startsWith('/')) {
        await ctx.reply('Не знаю такой команды. Откройте меню: /start, список возможностей: /help', { reply_markup: mainKeyboard() });
        return;
      }
    }
    if (await onCheckoutInput(ctx)) return;
    if (await onLinkOrderInput(ctx)) return;
    cancelLinkOrder(ctx.from.id);
    await onCustomerMessage(ctx);
  });

  // ── errors (long polling and the webhook route both end up here)
  bot.catch(async (err) => {
    const { error, ctx } = err;
    const id = ctx?.update?.update_id;
    if (isBlockedError(error)) return; // the user is already marked as blocked by the API transformer
    if (error instanceof GrammyError) console.error(`[bot] update ${id}: Bot API error ${error.error_code} in ${error.method}: ${error.description}`);
    else if (error instanceof HttpError) console.error(`[bot] update ${id}: Telegram is unreachable: ${error.message}`);
    else console.error(`[bot] update ${id}: handler failed:`, error);
    if (error instanceof HttpError || !ctx) return;
    try {
      await ack(ctx, GENERIC_ERROR, { alert: true });
      if (ctx.chat?.type === 'private' && !ctx.callbackQuery) await ctx.reply(GENERIC_ERROR);
    } catch { /* nothing else we can do */ }
  });

  return bot;
}
