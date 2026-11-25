// Feedback from customers ("💬 Поддержка" and any free message outside a flow).
//
//   customer message → stored as a feedback thread message (services/feedback.js)
//                    → shown in the admin chat as ONE message: header (name, @username, thread id)
//                      + the text, or a copy of the photo / document with that header as its caption
//                    → the id of that admin-chat message is saved, so a reply to it finds the thread
//   attachments are stored by reference: "[file_id: …]" at the end of the stored text
import { config } from '../../config.js';
import * as feedback from '../../services/feedback.js';
import { escapeTg, truncate } from '../../lib/escape.js';
import { RateLimiter } from '../../lib/ratelimit.js';
import { cb, inline, mainKeyboard, urlButton, siteUrl } from '../keyboards.js';
import { STATES, setState, getMemo, patchMemo } from '../state.js';
import { ack } from '../ui.js';
import * as texts from '../texts.js';

/** Do not repeat "we got your message" for every part of an album / a burst of messages. */
const ACK_GAP_MS = 20_000;
/** One customer cannot flood the inbox and the admin chat: 30 messages per 10 minutes. */
export const supportLimiter = new RateLimiter({ windowMs: 10 * 60_000, max: 30 });
const floodNotice = new RateLimiter({ windowMs: 10 * 60_000, max: 1 });

/**
 * Admin-chat messages that belong to a thread but are not stored in feedback_messages (the copy of
 * a sticker / location that follows its header). In memory only: after a restart the header message
 * still maps to the thread.
 */
const extraAdminMessages = new Map();
const EXTRA_LIMIT = 500;

function rememberExtra(adminMessageId, threadId) {
  extraAdminMessages.set(Number(adminMessageId), Number(threadId));
  if (extraAdminMessages.size > EXTRA_LIMIT) extraAdminMessages.delete(extraAdminMessages.keys().next().value);
}

/** Thread for a message of the admin chat (the forwarded customer message), or null. */
export function findThreadForAdminMessage(adminMessageId) {
  const thread = feedback.findThreadByAdminMessageId(adminMessageId);
  if (thread) return thread;
  const threadId = extraAdminMessages.get(Number(adminMessageId));
  return threadId ? feedback.getThread(threadId) : null;
}

/**
 * What a Telegram message is, for storing and forwarding.
 * @returns {{ label: string, body: string, fileId: string, captionable: boolean }}
 *   label — "📷 Фото" ('' for plain text); body — text or caption; captionable — a copy can carry our header
 */
export function describeMessage(message) {
  const body = String(message.text ?? message.caption ?? '').trim();
  const media = (label, fileId, captionable = true) => ({ label, body, fileId: fileId || '', captionable });
  if (message.photo?.length) return media('📷 Фото', message.photo.at(-1).file_id);
  if (message.document) return media(`📎 Файл${message.document.file_name ? ` «${message.document.file_name}»` : ''}`, message.document.file_id);
  if (message.video) return media('🎬 Видео', message.video.file_id);
  if (message.animation) return media('🎞 GIF', message.animation.file_id);
  if (message.voice) return media('🎤 Голосовое сообщение', message.voice.file_id);
  if (message.audio) return media('🎵 Аудио', message.audio.file_id);
  if (message.video_note) return media('⏺ Видеосообщение', message.video_note.file_id, false);
  if (message.sticker) return media(`Стикер ${message.sticker.emoji || ''}`.trim(), message.sticker.file_id, false);
  if (message.location) return media(`📍 Геопозиция: ${message.location.latitude}, ${message.location.longitude}`, '', false);
  if (message.contact) return media(`👤 Контакт: ${[message.contact.first_name, message.contact.last_name].filter(Boolean).join(' ')}, ${message.contact.phone_number}`, '', false);
  if (typeof message.text === 'string') return { label: '', body, fileId: '', captionable: false };
  return media('Сообщение', '', false);
}

/** Text stored in the feedback thread: label, caption/text and the file reference. */
export function storedText({ label, body, fileId }) {
  return [label, body, fileId ? `[file_id: ${fileId}]` : ''].filter(Boolean).join('\n');
}

function adminKeyboard(thread) {
  return inline([[
    cb('✅ Закрыть обращение', `fb:close:${thread.id}`),
    urlButton('Открыть в админке', siteUrl(`/admin/feedback/${thread.id}`)),
  ]]);
}

/** Show a stored customer message in the admin chat and remember which admin message represents it. */
async function forwardToAdminChat(ctx, thread, message, info, { isNew }) {
  const adminChatId = config.bot.adminChatId;
  if (!adminChatId) return null;
  const header = texts.feedbackHeader(thread, ctx.from, { isNew });
  const replyMarkup = adminKeyboard(thread);
  const tail = `\n\n${texts.FEEDBACK_REPLY_HINT}`;

  if (!info.label) {
    const sent = await ctx.api.sendMessage(adminChatId, `${header}\n\n${escapeTg(truncate(info.body, 3500))}${tail}`, { reply_markup: replyMarkup });
    feedback.setAdminMessageId(message.id, sent.message_id);
    return sent;
  }
  if (info.captionable) {
    const caption = `${header}${info.body ? `\n\n${escapeTg(truncate(info.body, 600))}` : ''}${tail}`;
    const sent = await ctx.api.copyMessage(adminChatId, ctx.chat.id, ctx.message.message_id, { caption, parse_mode: 'HTML', reply_markup: replyMarkup });
    feedback.setAdminMessageId(message.id, sent.message_id);
    return sent;
  }
  // stickers, video notes, locations cannot carry a caption: header first, then the copy as a reply to it
  const sent = await ctx.api.sendMessage(adminChatId, `${header}\n\n${escapeTg(info.label)}${tail}`, { reply_markup: replyMarkup });
  feedback.setAdminMessageId(message.id, sent.message_id);
  try {
    const copy = await ctx.api.copyMessage(adminChatId, ctx.chat.id, ctx.message.message_id, {
      reply_parameters: { message_id: sent.message_id, allow_sending_without_reply: true },
    });
    rememberExtra(copy.message_id, thread.id);
  } catch (err) {
    if (!config.isTest) console.warn(`[bot] cannot copy an attachment to the admin chat: ${err.description || err.message}`);
  }
  return sent;
}

/** "💬 Поддержка": switch to support mode. */
export async function enterSupport(ctx) {
  setState(ctx.from.id, STATES.support, {});
  await ack(ctx);
  await ctx.reply(texts.supportIntro(), { reply_markup: mainKeyboard() });
}

/** Store a customer message, pass it to the admins, confirm receipt. */
export async function onCustomerMessage(ctx) {
  const info = describeMessage(ctx.message);
  const text = storedText(info);
  if (!text) return;
  const limit = supportLimiter.hit(String(ctx.from.id));
  if (!limit.allowed) {
    // say it once, then stay silent until the window is over
    if (floodNotice.hit(String(ctx.from.id)).allowed) {
      await ctx.reply('Сообщений слишком много подряд — мы уже читаем то, что вы прислали. Напишите, пожалуйста, чуть позже.');
    }
    return;
  }
  const { thread, message, isNew } = await feedback.receiveFromTelegram({
    tgUser: ctx.from,
    chatId: ctx.chat.id,
    text,
    tgMessageId: ctx.message.message_id,
    notify: false, // the bot forwards the original itself (with attachments)
  });
  try {
    await forwardToAdminChat(ctx, thread, message, info, { isNew });
  } catch (err) {
    // The message is safe in the admin panel; a broken admin chat must not lose it or scare the customer.
    console.error(`[bot] cannot forward feedback #${thread.id} to ADMIN_CHAT_ID: ${err.description || err.message}`);
  }
  const lastAck = Number(getMemo(ctx.from.id).ackAt) || 0;
  if (Date.now() - lastAck > ACK_GAP_MS) {
    patchMemo(ctx.from.id, { ackAt: Date.now() });
    await ctx.reply(texts.supportReceived(), { reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true } });
  }
}
