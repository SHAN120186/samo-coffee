// Small helpers shared by the handlers: answering callback queries, showing "screens".
import { GrammyError } from 'grammy';

/** Answer a callback query (no-op for other updates). Never throws: an expired query must not break a handler. */
export async function ack(ctx, text = '', { alert = false } = {}) {
  if (!ctx.callbackQuery || ctx.acked) return;
  ctx.acked = true;
  try {
    await ctx.answerCallbackQuery(text ? { text: text.slice(0, 200), show_alert: alert } : undefined);
  } catch { /* query is too old — nothing to do */ }
}

const isBadRequest = (err) => err instanceof GrammyError && err.error_code === 400;
const notModified = (err) => isBadRequest(err) && /message is not modified/i.test(err.description);

/**
 * Show a text screen. When the update is a button press under a TEXT message, that message is edited
 * in place (menus do not pile up); otherwise — or when `ctx.fresh` is set — a new message is sent.
 * @returns {Promise<object>} the shown Message
 */
export async function show(ctx, html, replyMarkup) {
  const source = ctx.callbackQuery?.message;
  if (source && typeof source.text === 'string' && !ctx.fresh) {
    try {
      return await ctx.editMessageText(html, { reply_markup: replyMarkup });
    } catch (err) {
      if (notModified(err)) return source;
      if (!isBadRequest(err)) throw err; // too old / deleted → fall through to a new message
    }
  }
  return ctx.reply(html, replyMarkup ? { reply_markup: replyMarkup } : {});
}

/** Remove the inline keyboard of the message whose button was pressed (best effort). */
export async function dropButtons(ctx) {
  if (!ctx.callbackQuery?.message) return;
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
  } catch { /* already removed or too old */ }
}
