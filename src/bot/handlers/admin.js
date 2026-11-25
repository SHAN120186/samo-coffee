// Admin chat (ADMIN_CHAT_ID — a private chat with the owner or a staff group):
//   reply to a forwarded customer message → the answer is delivered to the customer and stored
//   /stats  — today's visitors, orders, revenue          /orders — the last 5 orders
//   "✅ Закрыть обращение" under a forwarded message
import { config } from '../../config.js';
import * as feedback from '../../services/feedback.js';
import * as analytics from '../../services/analytics.js';
import * as orders from '../../services/orders.js';
import { escapeTg } from '../../lib/escape.js';
import { formatDate } from '../../lib/dates.js';
import { inline, urlButton, siteUrl } from '../keyboards.js';
import { ack } from '../ui.js';
import { describeMessage, findThreadForAdminMessage } from './support.js';
import * as texts from '../texts.js';

/** Is this update from the configured admin chat? */
export const isAdminChat = (ctx) => Boolean(config.bot.adminChatId) && String(ctx.chat?.id ?? '') === String(config.bot.adminChatId);

const replyTo = (ctx) => ({ reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true } });

export async function onStats(ctx) {
  const summary = analytics.summary(analytics.resolveRange({ range: 'today' }));
  await ctx.reply(texts.statsText(summary, {
    date: formatDate(Date.now()),
    openFeedback: feedback.counts().open,
    activeSubscriptions: summary.activeSubscriptions,
  }), { reply_markup: inline([[urlButton('Открыть дашборд', siteUrl('/admin'))]]) });
}

export async function onLastOrders(ctx) {
  const { items } = orders.listOrders({ limit: 5 });
  const body = items.length ? items.map(texts.adminOrderLine).join('\n\n') : 'Заказов пока нет.';
  await ctx.reply(`🧾 <b>Последние заказы</b>\n\n${body}`, { reply_markup: inline([[urlButton('Все заказы', siteUrl('/admin/orders'))]]) });
}

export async function onAdminHelp(ctx) {
  await ctx.reply(texts.ADMIN_HELP);
}

/**
 * A reply in the admin chat. When the replied message is a forwarded customer message, the answer
 * goes to the customer through the feedback service (stored as an outgoing message, via 'telegram').
 * @returns {Promise<boolean>} true when the message was an answer to a thread
 */
export async function onAdminReply(ctx) {
  const message = ctx.message;
  const replied = message.reply_to_message;
  if (!replied) return false;
  const thread = findThreadForAdminMessage(replied.message_id);
  if (!thread) return false;

  const info = describeMessage(message);
  const text = info.label ? [info.label, info.body].filter(Boolean).join(': ') : info.body;
  if (!text) return true;

  const result = await feedback.reply(thread.id, { text, via: 'telegram' });
  if (result.delivered && info.label) {
    // the text part is delivered by the service; the attachment itself is copied as is
    try {
      await ctx.api.copyMessage(thread.tg_chat_id, ctx.chat.id, message.message_id);
    } catch (err) {
      await ctx.reply(`⚠️ Текст ответа доставлен, но вложение отправить не удалось: ${escapeTg(err.description || err.message)}`, replyTo(ctx));
      return true;
    }
  }
  if (result.delivered) {
    await ctx.reply(`✅ Ответ доставлен · обращение #${thread.id}`, replyTo(ctx));
  } else if (!result.deliverable) {
    await ctx.reply(
      `💾 Ответ сохранён в обращении #${thread.id}, но клиент писал с сайта — в Telegram его нет.${thread.contact ? ` Свяжитесь с ним: ${escapeTg(thread.contact)}` : ''}`,
      replyTo(ctx),
    );
  } else {
    await ctx.reply(`⚠️ ${escapeTg(result.error || 'Не удалось отправить ответ.')}`, replyTo(ctx));
  }
  return true;
}

/** "✅ Закрыть обращение" under a forwarded message. */
export async function onCloseThread(ctx, threadId) {
  const thread = feedback.getThread(Number(threadId));
  if (!thread) {
    await ack(ctx, 'Обращение не найдено', { alert: true });
    return;
  }
  if (thread.status !== 'closed') feedback.setThreadStatus(thread.id, 'closed');
  await ack(ctx, `Обращение #${thread.id} закрыто`);
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: inline([[urlButton('Открыть в админке', siteUrl(`/admin/feedback/${thread.id}`))]]) });
  } catch { /* the message is too old to edit */ }
}
