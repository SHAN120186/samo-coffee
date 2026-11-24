// Conversation state of a Telegram user (tg_users.state / state_data, see services/tgUsers.js).
//
//   state ''            idle — free text goes to support
//   state 'support'     the user opened "Поддержка"
//   state 'checkout'    buying a product / plan: data = the order draft (see handlers/checkout.js)
//   state 'link_order'  confirming the phone of a site order: data = { orderId }
//
// state_data also carries a small persistent memo under MEMO_KEY (reminders already sent, last
// "message received" confirmation, verified phone). The memo survives state changes and restarts.
import * as tgUsers from '../services/tgUsers.js';

export const STATES = { idle: '', support: 'support', checkout: 'checkout', linkOrder: 'link_order' };
const MEMO_KEY = '_memo';

function split(user) {
  const { [MEMO_KEY]: memo, ...data } = user?.state_data || {};
  return { state: user?.state || '', data, memo: memo && typeof memo === 'object' ? memo : {} };
}

/** → { state, data, memo } (empty values for unknown users). */
export function getState(userId) {
  return split(tgUsers.getTgUser(userId));
}

/** Set the state and its data, keeping the memo. Returns { state, data, memo }. */
export function setState(userId, state = STATES.idle, data = {}) {
  const { memo } = getState(userId);
  const payload = Object.keys(memo).length ? { ...data, [MEMO_KEY]: memo } : { ...data };
  return split(tgUsers.setTgState(userId, state, payload));
}

/** Back to idle. */
export function clearState(userId) {
  return setState(userId, STATES.idle, {});
}

/** Read the persistent memo of a user. */
export function getMemo(userId) {
  return getState(userId).memo;
}

/** Shallow-merge a patch into the memo (null/undefined values delete keys). State and data stay as they are. */
export function patchMemo(userId, patch) {
  const user = tgUsers.getTgUser(userId);
  if (!user) return null;
  const { state, data, memo } = split(user);
  const next = { ...memo };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  tgUsers.setTgState(userId, state, Object.keys(next).length ? { ...data, [MEMO_KEY]: next } : { ...data });
  return next;
}
