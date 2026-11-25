// Customers: one record per person. A Telegram id is the only authenticated identity; phones and
// e-mails typed into forms only group anonymous site orders (see upsertCustomer / linkTelegramAccount).
import { all, get, run, tx, now } from '../db/index.js';
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
 * Find-or-create the customer record an order or a visit belongs to.
 *
 * Identity rules — a phone or an e-mail typed into a form is NOT proof of identity:
 *   • tgUserId given (an authenticated Telegram user: bot `from.id`, Mini App initData):
 *       the row linked to that Telegram id is used and refreshed with the non-empty fields.
 *       A user without a row gets a NEW one; rows of other people are never matched by phone/e-mail.
 *   • no tgUserId (site forms — anonymous input): matched by phone among the rows that are NOT
 *       linked to Telegram (by e-mail only when no phone is given, among rows without a phone).
 *       A matched row only gets its EMPTY fields filled in — a stored name, e-mail or address is
 *       never overwritten. Rows linked to a Telegram account are never matched or changed.
 *
 * Records of the same person are joined only by linkTelegramAccount(), after the phone is verified.
 * @param {{ name?: string, phone?: string, email?: string, tgUserId?: number, tgUsername?: string, address?: string,
 *           source?: 'site'|'tma'|'bot'|'admin' }} data
 * @returns {object} customer row
 */
export function upsertCustomer(data) {
  const phone = normalizePhone(data.phone);
  const email = isEmail(data.email) ? String(data.email).trim().toLowerCase() : null;
  const tgUserId = data.tgUserId ? Number(data.tgUserId) : null;
  const name = cleanName(data.name);
  const address = String(data.address ?? '').trim();
  const source = SOURCES.includes(data.source) ? data.source : 'site';
  const insert = () => {
    const ts = now();
    const { lastInsertRowid } = run(
      `INSERT INTO customers (name, phone, email, tg_user_id, tg_username, address, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      name, phone, email, tgUserId, data.tgUsername || null, address, source, ts, ts,
    );
    return getCustomer(Number(lastInsertRowid));
  };

  if (tgUserId) {
    const row = getCustomerByTgUserId(tgUserId);
    if (!row) return insert();
    // The Telegram user owns this row: refresh it with what they entered.
    run(
      'UPDATE customers SET name = ?, phone = ?, email = ?, tg_username = ?, address = ?, updated_at = ? WHERE id = ?',
      name || row.name, phone || row.phone, email || row.email, data.tgUsername || row.tg_username, address || row.address, now(), row.id,
    );
    return getCustomer(row.id);
  }

  // Anonymous input: never touches a Telegram-linked record and never overwrites stored contacts.
  let row = null;
  if (phone) row = get('SELECT * FROM customers WHERE phone = ? AND tg_user_id IS NULL ORDER BY id LIMIT 1', phone);
  else if (email) row = get('SELECT * FROM customers WHERE email = ? AND tg_user_id IS NULL AND phone IS NULL ORDER BY id LIMIT 1', email);
  if (!row) return insert();
  run('UPDATE customers SET name = ?, email = ?, address = ?, updated_at = ? WHERE id = ?',
    row.name || name, row.email || email, row.address || address, now(), row.id);
  return getCustomer(row.id);
}

const cleanName = (value) => String(value ?? '').trim().slice(0, 120);

/**
 * Join a Telegram account with the customer records of a phone number that was just VERIFIED
 * (the user shared their own Telegram contact: `contact.user_id === from.id`). This is the only
 * place where customer records are joined — never call it with a phone that was only typed in.
 *
 *   • the Telegram user has no record yet → the record of `customerId` (else the oldest record
 *     with this phone that has no Telegram account) is linked to the account;
 *   • the user already has a record → it gets the verified phone;
 *   • every other record with this phone that has no Telegram account (and `customerId`) is merged
 *     into the user's record: its orders, subscriptions and feedback threads move over and the
 *     emptied row is deleted.
 * Contact details typed into anonymous forms are not trusted: the name / e-mail / address of the
 * resulting record come from the user's own record or from `contact` (the order that was just
 * claimed), never from the merged rows. Records of ANOTHER Telegram account are never touched.
 *
 * @param {object} p
 * @param {number} p.tgUserId @param {string} p.phone verified phone
 * @param {string} [p.tgUsername] @param {number|null} [p.customerId] customer of the claimed order
 * @param {{ name?: string, email?: string, address?: string }} [p.contact] details of the claimed order
 * @param {string} [p.name] fallback name (Telegram display name) @param {string} [p.source]
 * @returns {object|null} the customer row of the Telegram user (null when the input is not valid)
 */
export function linkTelegramAccount({ tgUserId, phone, tgUsername = null, customerId = null, contact = {}, name = '', source = 'bot' }) {
  const id = Number(tgUserId);
  const verified = normalizePhone(phone);
  if (!Number.isSafeInteger(id) || id <= 0 || !verified) return null;
  const claimed = {
    name: cleanName(contact.name),
    email: isEmail(contact.email) ? String(contact.email).trim().toLowerCase() : null,
    address: String(contact.address ?? '').trim(),
  };
  return tx(() => {
    const unlinked = all('SELECT * FROM customers WHERE phone = ? AND tg_user_id IS NULL ORDER BY id', verified);
    const hinted = customerId ? getCustomer(customerId) : null;
    if (hinted && !hinted.tg_user_id && !unlinked.some((c) => c.id === hinted.id)) unlinked.unshift(hinted);

    let own = getCustomerByTgUserId(id);
    if (own) {
      run('UPDATE customers SET name = ?, phone = ?, email = ?, address = ?, tg_username = ?, updated_at = ? WHERE id = ?',
        own.name || claimed.name || cleanName(name), verified, own.email || claimed.email, own.address || claimed.address,
        tgUsername || own.tg_username, now(), own.id);
    } else {
      const adopt = (hinted && unlinked.find((c) => c.id === hinted.id)) || unlinked[0];
      if (!adopt) {
        return upsertCustomer({ name: claimed.name || name, phone: verified, email: claimed.email, address: claimed.address, tgUserId: id, tgUsername, source });
      }
      run('UPDATE customers SET tg_user_id = ?, tg_username = ?, name = ?, phone = ?, email = ?, address = ?, updated_at = ? WHERE id = ?',
        id, tgUsername || adopt.tg_username, claimed.name || adopt.name || cleanName(name), verified, claimed.email, claimed.address, now(), adopt.id);
      own = adopt;
    }
    for (const other of unlinked) {
      if (other.id === own.id) continue;
      for (const table of ['orders', 'subscriptions', 'feedback_threads']) {
        run(`UPDATE ${table} SET customer_id = ? WHERE customer_id = ?`, own.id, other.id);
      }
      if (other.notes) {
        run(`UPDATE customers SET notes = TRIM(notes || char(10) || ?, char(10)) WHERE id = ?`, other.notes, own.id);
      }
      run('DELETE FROM customers WHERE id = ?', other.id);
    }
    return getCustomer(own.id);
  });
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
