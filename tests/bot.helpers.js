// Helpers for tests/bot.*.test.js: Telegram update factories and shortcuts over the fake Bot API.
// Import AFTER one of the bot.env*.js files.
import { ADMIN_CHAT_ID } from './helpers/env-telegram.js';

export const BOT_INFO = {
  id: 123456, is_bot: true, first_name: 'Samo Test', username: 'samo_test_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
};
export const ADMIN_CHAT = { id: Number(ADMIN_CHAT_ID), type: 'supergroup', title: 'Samo — команда' };
export const STAFF = { id: 555001, is_bot: false, first_name: 'Мадина', username: 'madina_samo' };

let updateId = 9000;
let messageId = 4000;
const now = () => Math.floor(Date.now() / 1000);

/** A Telegram user. Different ids → different customers. */
export const makeUser = (id, extra = {}) => ({
  id, is_bot: false, first_name: 'Алишер', last_name: 'Каримов', username: `alisher_${id}`, language_code: 'ru', ...extra,
});

const privateChat = (user) => ({ id: user.id, type: 'private', first_name: user.first_name, username: user.username });
const commandEntity = (text) => (text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(/\s/)[0].length }] : undefined);

/** A message in the user's private chat with the bot. `extra` may replace text with photo/contact/… */
export function message(user, text, extra = {}) {
  const msg = { message_id: messageId++, date: now(), chat: privateChat(user), from: user, ...(text === null ? {} : { text, entities: commandEntity(text) }), ...extra };
  if (!msg.entities) delete msg.entities;
  return { update_id: updateId++, message: msg };
}

/** A message in a group chat (the admin chat by default). */
export function groupMessage(user, text, extra = {}, chat = ADMIN_CHAT) {
  const msg = { message_id: messageId++, date: now(), chat, from: user, ...(text === null ? {} : { text, entities: commandEntity(text) }), ...extra };
  if (!msg.entities) delete msg.entities;
  return { update_id: updateId++, message: msg };
}

/** A press on an inline button. `source` — the message that carries the button (a text message by default). */
export function callback(user, data, source = {}) {
  return {
    update_id: updateId++,
    callback_query: {
      id: `cq${updateId}`, from: user, chat_instance: 'ci', data,
      message: { message_id: messageId++, date: now(), chat: privateChat(user), from: BOT_INFO, text: 'экран', ...source },
    },
  };
}

export function preCheckout(user, { payload, amount, currency = 'UZS' }) {
  return { update_id: updateId++, pre_checkout_query: { id: `pcq${updateId}`, from: user, currency, total_amount: amount, invoice_payload: payload } };
}

export function successfulPayment(user, { payload, amount, currency = 'UZS', chargeId = `tg_charge_${updateId}` }) {
  return message(user, null, {
    successful_payment: {
      currency, total_amount: amount, invoice_payload: payload,
      telegram_payment_charge_id: chargeId, provider_payment_charge_id: `prov_${chargeId}`,
    },
  });
}

/** Calls of a Bot API method addressed to one chat. */
export const callsToChat = (fake, method, chatId) => fake.callsTo(method).filter((p) => String(p.chat_id) === String(chatId));
/** The last sendMessage to a chat (or undefined). */
export const lastText = (fake, chatId) => callsToChat(fake, 'sendMessage', chatId).at(-1);
/** All inline buttons of a sent message, flattened. */
export const buttons = (params) => (params?.reply_markup?.inline_keyboard || []).flat();
export const buttonData = (params) => buttons(params).map((b) => b.callback_data).filter(Boolean);

/**
 * Make the fake sendPhoto answer like Telegram does (with photo sizes), so the bot caches the
 * file_id. The first send of a local picture is multipart (the fake cannot parse its fields); every
 * later send of the same picture is plain JSON with `photo: <file_id>` and a readable caption.
 */
export function enablePhotoIds(fake) {
  let n = 0;
  fake.on('sendPhoto', (p) => {
    n += 1;
    return { message_id: 70000 + n, date: now(), chat: { id: Number(p.chat_id) || 0, type: 'private' }, photo: [{ file_id: `PHOTO_${n}_s` }, { file_id: `PHOTO_${n}` }], caption: p.caption };
  });
}
