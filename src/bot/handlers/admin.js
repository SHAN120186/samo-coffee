// Admin chat (ADMIN_CHAT_ID — a private chat with the owner or a staff group):
//   reply to a forwarded customer message → the answer is delivered to the customer and stored;
//   a follow-up: reply to your own answer or to the bot's "✅ Ответ доставлен · обращение #N"
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
  await ctx.reply(texts.adminHelp());
}

/**
 * Which feedback thread does a reply in the admin chat belong to?
 *   1. a reply to the forwarded customer message (or the copy of its sticker / location);
 *   2. a reply to a staff answer that went to the customer — only by the author of that answer
 *      (a follow-up); a reply to a COLLEAGUE'S answer is staff talk and is not sent anywhere;
 *   3. a reply to a message of the bot itself that names the thread — the confirmation
 *      "✅ Ответ доставлен · обращение #N" is the natural thing to answer for a follow-up, and after
 *      a restart the header "Обращение #N" still identifies the thread.
 * @returns {object|null}
 */
function threadOfReply(ctx, replied) {
  const stored = feedback.findMessageByAdminMessageId(replied.message_id);
  if (stored) {
    if (stored.message.direction === 'in') return stored.thread;
    return replied.from?.id && replied.from.id === ctx.from?.id ? stored.thread : null;
  }
  const extra = findThreadForAdminMessage(replied.message_id);
  if (extra) return extra;
  if (replied.from?.id && replied.from.id === ctx.me?.id) {
    const m = /обращени[еи] #(\d{1,12})/i.exec(String(replied.text ?? replied.caption ?? ''));
    if (m) return feedback.getThread(Number(m[1]));
  }
  return null;
}

/**
 * A reply in the admin chat. When it belongs to a feedback thread (see threadOfReply), the answer
 * goes to the customer through the feedback service (stored as an outgoing message, via 'telegram').
 * In a staff group a reply to one of the bot's messages that belongs to no thread gets a short
 * hint — it must not look as if the answer had been delivered.
 * @returns {Promise<boolean>} true when the message was handled here
 */
export async function onAdminReply(ctx) {
  const message = ctx.message;
  const replied = message.reply_to_message;
  if (!replied) return false;
  const thread = threadOfReply(ctx, replied);
  if (!thread) {
    // The owner's private chat is also a customer chat: there the message goes on to the usual flow.
    if (ctx.chat.type === 'private' || replied.from?.id !== ctx.me?.id) return false;
    await ctx.reply(texts.ADMIN_REPLY_NOWHERE, replyTo(ctx));
    return true;
  }

  const info = describeMessage(message);
  const text = info.label ? [info.label, info.body].filter(Boolean).join(': ') : info.body;
  if (!text) return true;

  const result = await feedback.reply(thread.id, { text, via: 'telegram' });
  // a later reply to this very message (a follow-up by the same person) finds the thread again
  feedback.setAdminMessageId(result.message.id, message.message_id);
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
    await ctx.reply(`⚠️ ${escapeTg(result.error || 'Не удалось отправить ответ.')} · обращение #${thread.id}`, replyTo(ctx));
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
