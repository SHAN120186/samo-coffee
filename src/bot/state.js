// Conversation state of a Telegram user (tg_users.state / state_data, see services/tgUsers.js).
//
//   state ''            idle — free text goes to support
//   state 'support'     the user opened "Поддержка"
//   state 'checkout'    buying a product / plan: data = the order draft (see handlers/checkout.js)
//   state 'link_order'  confirming the phone of a site order: data = { orderId }
//
// A flow state carries the time it was last touched; checkout / link_order expire after FLOW_TTL_MS
// of silence (expireStaleFlow), so an abandoned flow never swallows later messages.
// state_data also carries a small persistent memo under MEMO_KEY (reminders already sent, last
// "message received" confirmation, verified phone). The memo survives state changes and restarts.
import * as tgUsers from '../services/tgUsers.js';

export const STATES = { idle: '', support: 'support', checkout: 'checkout', linkOrder: 'link_order' };
const MEMO_KEY = '_memo';
/** When the state was last set (ms) — lets abandoned flows expire, see expireStaleFlow(). */
const AT_KEY = '_at';

/**
 * A flow (checkout, phone confirmation) that nobody touched for this long is abandoned: the next
 * message of the user is an ordinary message again (it goes to support) instead of being taken
 * for a phone number or a delivery address.
 */
export const FLOW_TTL_MS = 45 * 60_000;
const FLOW_STATES = new Set([STATES.checkout, STATES.linkOrder]);

function split(user) {
  const { [MEMO_KEY]: memo, [AT_KEY]: at, ...data } = user?.state_data || {};
  return { state: user?.state || '', data, memo: memo && typeof memo === 'object' ? memo : {}, at: Number(at) || 0 };
}

const pack = (data, memo, at) => ({
  ...data,
  ...(at ? { [AT_KEY]: at } : {}),
  ...(Object.keys(memo).length ? { [MEMO_KEY]: memo } : {}),
});

/** → { state, data, memo, at } (empty values for unknown users). */
export function getState(userId) {
  return split(tgUsers.getTgUser(userId));
}

/** Set the state and its data (and the time of the change), keeping the memo. Returns { state, data, memo, at }. */
export function setState(userId, state = STATES.idle, data = {}) {
  const { memo } = getState(userId);
  return split(tgUsers.setTgState(userId, state, pack(data, memo, state === STATES.idle ? 0 : Date.now())));
}

/** Back to idle. */
export function clearState(userId) {
  return setState(userId, STATES.idle, {});
}

/**
 * Drop a checkout / phone-confirmation flow that was abandoned more than FLOW_TTL_MS ago.
 * Called for every update of a private chat before the handlers run.
 * @returns {boolean} true when a stale flow was cleared
 */
export function expireStaleFlow(userId, now = Date.now()) {
  const { state, at } = getState(userId);
  if (!FLOW_STATES.has(state) || now - at <= FLOW_TTL_MS) return false;
  clearState(userId);
  return true;
}

/** Read the persistent memo of a user. */
export function getMemo(userId) {
  return getState(userId).memo;
}

/** Shallow-merge a patch into the memo (null/undefined values delete keys). State and data stay as they are. */
export function patchMemo(userId, patch) {
  const user = tgUsers.getTgUser(userId);
  if (!user) return null;
  const { state, data, memo, at } = split(user);
  const next = { ...memo };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  tgUsers.setTgState(userId, state, pack(data, next, at));
  return next;
}
