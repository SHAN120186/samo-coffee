// Customers: one record per person, matched by Telegram id → phone → e-mail.
import { all, get, run, now } from '../db/index.js';
import { AppError, notFound } from '../lib/errors.js';

const SOURCES = ['site', 'tma', 'bot', 'admin'];

/**
 * Normalize an Uzbek phone number to "+998901234567".
 * Accepts "+998 90 123-45-67", "998901234567", "901234567", "8 90 123 45 67".
 * Returns null when the input cannot be a valid number. Other international numbers
 * ("+7...", "+1...") are kept as "+<digits>" when they have 10–15 digits.
 */
export function normalizePhone(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 9) return `+998${digits}`;
  if (digits.length === 12 && digits.startsWith('998')) return `+${digits}`;
  if (digits.length === 10 && digits.startsWith('8')) return `+998${digits.slice(1)}`;
  if (raw.startsWith('+') && digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return null;
}

/** "+998901234567" -> "+998 90 123 45 67" */
export function formatPhone(phone) {
  const m = /^\+998(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(String(phone ?? ''));
  return m ? `+998 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : String(phone ?? '');
}

export function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value ?? '').trim());
}

export function getCustomer(id) {
  return get('SELECT * FROM customers WHERE id = ?', Number(id));
}

export function getCustomerByTgUserId(tgUserId) {
  return get('SELECT * FROM customers WHERE tg_user_id = ?', Number(tgUserId));
}

/**
 * Find-or-create a customer and refresh the non-empty fields.
 * Match order: tgUserId → phone → email.
 * @param {{ name?: string, phone?: string, email?: string, tgUserId?: number, tgUsername?: string, address?: string, source?: 'site'|'tma'|'bot'|'admin' }} data
 * @returns {object} customer row
 */
export function upsertCustomer(data) {
  const phone = normalizePhone(data.phone);
  const email = isEmail(data.email) ? String(data.email).trim().toLowerCase() : null;
  const tgUserId = data.tgUserId ? Number(data.tgUserId) : null;
  const name = String(data.name ?? '').trim().slice(0, 120);
  const source = SOURCES.includes(data.source) ? data.source : 'site';

  let row = null;
  if (tgUserId) row = getCustomerByTgUserId(tgUserId);
  if (!row && phone) row = get('SELECT * FROM customers WHERE phone = ? ORDER BY id LIMIT 1', phone);
  if (!row && email) row = get('SELECT * FROM customers WHERE email = ? ORDER BY id LIMIT 1', email);

  if (!row) {
    const ts = now();
    const { lastInsertRowid } = run(
      `INSERT INTO customers (name, phone, email, tg_user_id, tg_username, address, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      name, phone, email, tgUserId, data.tgUsername || null, String(data.address ?? '').trim(), source, ts, ts,
    );
    return getCustomer(Number(lastInsertRowid));
  }

  // Attach a Telegram id only when it is free (tg_user_id is UNIQUE).
  const canSetTg = tgUserId && !row.tg_user_id && !getCustomerByTgUserId(tgUserId);
  run(
    `UPDATE customers SET name = ?, phone = ?, email = ?, tg_user_id = ?, tg_username = ?, address = ?, updated_at = ? WHERE id = ?`,
    name || row.name,
    phone || row.phone,
    email || row.email,
    canSetTg ? tgUserId : row.tg_user_id,
    data.tgUsername || row.tg_username,
    String(data.address ?? '').trim() || row.address,
    now(),
    row.id,
  );
  return getCustomer(row.id);
}

/** Admin edit. data: { name, phone, email, address, notes } */
export function updateCustomer(id, data) {
  const row = getCustomer(id);
  if (!row) throw notFound('Клиент');
  let phone = row.phone;
  if (data.phone !== undefined) {
    phone = data.phone === '' ? null : normalizePhone(data.phone);
    if (data.phone !== '' && !phone) throw new AppError('validation', 'Некорректный номер телефона', 422);
  }
  let email = row.email;
  if (data.email !== undefined) {
    if (data.email !== '' && !isEmail(data.email)) throw new AppError('validation', 'Некорректный e-mail', 422);
    email = data.email === '' ? null : String(data.email).trim().toLowerCase();
  }
  run('UPDATE customers SET name = ?, phone = ?, email = ?, address = ?, notes = ?, updated_at = ? WHERE id = ?',
    String(data.name ?? row.name).trim(), phone, email, String(data.address ?? row.address).trim(),
    String(data.notes ?? row.notes).trim(), now(), row.id);
  return getCustomer(row.id);
}

/**
 * Customers with order stats, newest first.
 * @param {{ search?: string, limit?: number, offset?: number }} [o]
 * @returns {{ items: Array<object & { orders_count: number, paid_total: number, last_order_at: string|null }>, total: number }}
 */
export function listCustomers({ search = '', limit = 50, offset = 0 } = {}) {
  const rows = all(
    `SELECT c.*,
            (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS orders_count,
            (SELECT COALESCE(SUM(o.total), 0) FROM orders o WHERE o.customer_id = c.id AND o.payment_status = 'paid') AS paid_total,
            (SELECT MAX(o.created_at) FROM orders o WHERE o.customer_id = c.id) AS last_order_at
       FROM customers c ORDER BY c.created_at DESC, c.id DESC`,
  );
  const s = String(search).toLocaleLowerCase('ru').trim();
  const digits = s.replace(/\D/g, '');
  const filtered = !s
    ? rows
    : rows.filter((r) =>
        `${r.name} ${r.email || ''} ${r.tg_username || ''}`.toLocaleLowerCase('ru').includes(s) ||
        (digits.length >= 3 && String(r.phone || '').replace(/\D/g, '').includes(digits)));
  return { items: filtered.slice(Number(offset), Number(offset) + Number(limit)), total: filtered.length };
}

/** { orders_count, paid_count, paid_total, avg_check, first_order_at, last_order_at } */
export function customerStats(id) {
  const r = get(
    `SELECT COUNT(*) AS orders_count,
            SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END) AS paid_count,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total ELSE 0 END), 0) AS paid_total,
            MIN(created_at) AS first_order_at, MAX(created_at) AS last_order_at
       FROM orders WHERE customer_id = ?`, Number(id));
  const paidCount = r.paid_count || 0;
  return { ...r, paid_count: paidCount, avg_check: paidCount ? Math.round(r.paid_total / paidCount) : 0 };
}

export function countCustomers() {
  return get('SELECT COUNT(*) AS n FROM customers').n;
}
