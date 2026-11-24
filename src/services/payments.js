// Payment records (table `payments`): one row per payment attempt / provider transaction.
// This is plain data access for the payment providers (src/payments/providers/*).
// Business effects of a successful payment live in orders.markPaid() — providers must call it.
import { all, get, run, now, parseJson } from '../db/index.js';

const hydrate = (row) => (row ? { ...row, raw: parseJson(row.raw, {}) } : null);

export function getPayment(id) {
  return hydrate(get('SELECT * FROM payments WHERE id = ?', Number(id)));
}

/** Find a transaction by provider + provider transaction id. */
export function findByProviderTx(provider, providerTxId) {
  return hydrate(get('SELECT * FROM payments WHERE provider = ? AND provider_tx_id = ?', String(provider), String(providerTxId)));
}

/** All payment rows of an order, newest first. */
export function listByOrder(orderId) {
  return all('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC', Number(orderId)).map(hydrate);
}

/** Latest not-finished (created/pending) transaction of a provider for an order — Payme "one active transaction per order" rule. */
export function findActiveForOrder(orderId, provider) {
  return hydrate(get(
    `SELECT * FROM payments WHERE order_id = ? AND provider = ? AND status IN ('created', 'pending') ORDER BY id DESC LIMIT 1`,
    Number(orderId), String(provider)));
}

/**
 * Create a payment row.
 * @param {{ orderId: number, provider: string, providerTxId?: string|null, amount: number, status?: string,
 *           state?: number, createTime?: number, raw?: object }} p amount in whole sums
 */
export function createPayment({ orderId, provider, providerTxId = null, amount, status = 'created', state = 0, createTime = Date.now(), raw = {} }) {
  const ts = now();
  const { lastInsertRowid } = run(
    `INSERT INTO payments (order_id, provider, provider_tx_id, amount, status, state, create_time, raw, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    Number(orderId), String(provider), providerTxId === null ? null : String(providerTxId), Math.round(amount),
    status, state, createTime, JSON.stringify(raw ?? {}), ts, ts,
  );
  return getPayment(Number(lastInsertRowid));
}

const COLUMNS = {
  providerTxId: 'provider_tx_id', status: 'status', state: 'state', reason: 'reason', error: 'error',
  createTime: 'create_time', performTime: 'perform_time', cancelTime: 'cancel_time', amount: 'amount',
};

/**
 * Patch a payment row. Allowed keys: providerTxId, status, state, reason, error, createTime, performTime,
 * cancelTime, amount, raw (object — shallow-merged into the stored JSON).
 */
export function updatePayment(id, patch = {}) {
  const current = getPayment(id);
  if (!current) return null;
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(COLUMNS)) {
    if (patch[key] !== undefined) {
      sets.push(`${column} = ?`);
      params.push(patch[key]);
    }
  }
  if (patch.raw !== undefined) {
    sets.push('raw = ?');
    params.push(JSON.stringify({ ...current.raw, ...patch.raw }));
  }
  if (!sets.length) return current;
  sets.push('updated_at = ?');
  params.push(now(), current.id);
  run(`UPDATE payments SET ${sets.join(', ')} WHERE id = ?`, ...params);
  return getPayment(current.id);
}

/** Transactions of a provider with create_time in [fromMs, toMs] ordered by create_time (Payme GetStatement). */
export function listByProviderBetween(provider, fromMs, toMs) {
  return all(
    'SELECT * FROM payments WHERE provider = ? AND create_time >= ? AND create_time <= ? ORDER BY create_time, id',
    String(provider), Number(fromMs), Number(toMs)).map(hydrate);
}

/** Admin list of recent payments with order numbers. */
export function listRecent({ limit = 50, offset = 0, provider = null } = {}) {
  return all(
    `SELECT p.*, o.number AS order_number FROM payments p JOIN orders o ON o.id = p.order_id
      ${provider ? 'WHERE p.provider = ?' : ''} ORDER BY p.id DESC LIMIT ? OFFSET ?`,
    ...(provider ? [String(provider)] : []), Number(limit), Number(offset)).map(hydrate);
}
