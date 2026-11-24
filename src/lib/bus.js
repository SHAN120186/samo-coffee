// In-process event bus. Services emit domain events after the DB work is committed;
// modules (bot, payments, ...) may subscribe for extra side effects.
//
// Events and payloads:
//   'order.created'           { order }
//   'order.paid'              { order, payment }
//   'order.status'            { order, from, to }
//   'order.payment_failed'    { order, reason }
//   'order.refunded'          { order }
//   'subscription.activated'  { subscription, order, renewed }
//   'feedback.thread'         { thread, message }      (new thread)
//   'feedback.message'        { thread, message }      (every in/out message)
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(50);

/** Emit without ever throwing into the caller (listener errors are logged). */
export function emit(event, payload) {
  for (const listener of bus.listeners(event)) {
    try {
      const r = listener(payload);
      if (r && typeof r.catch === 'function') r.catch((err) => console.error(`[bus] ${event} listener failed:`, err));
    } catch (err) {
      console.error(`[bus] ${event} listener failed:`, err);
    }
  }
}
