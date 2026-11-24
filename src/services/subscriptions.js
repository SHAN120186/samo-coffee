// Subscription plans + customer subscriptions.
// A subscription is created/extended ONLY by orders.markPaid() → activateFromOrder().
import { all, get, run, tx, now, parseJson } from '../db/index.js';
import { slugify, uniqueSlug } from '../lib/slugify.js';
import { AppError, notFound } from '../lib/errors.js';

export const SUBSCRIPTION_STATUS_LABELS = { active: 'Активна', paused: 'На паузе', cancelled: 'Отменена', expired: 'Истекла' };

const DAY = 86400000;
const flag = (v) => (v === true || v === 1 || v === '1' || v === 'on' || v === 'true' ? 1 : 0);
const toInt = (v, d = 0) => (Number.isFinite(Number.parseInt(v, 10)) ? Number.parseInt(v, 10) : d);

// ─────────────────────────────── plans

const hydratePlan = (row) => (row ? { ...row, perks: parseJson(row.perks, []), image: row.image || '/img/plans/plan-1.svg' } : null);

/** Plans ordered by sort. activeOnly defaults to true. Each plan has perks[] parsed. */
export function listPlans({ activeOnly = true } = {}) {
  return all(`SELECT * FROM plans ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY sort, id`).map(hydratePlan);
}

export function getPlan(id) {
  return hydratePlan(get('SELECT * FROM plans WHERE id = ?', Number(id)));
}

export function getPlanBySlug(slug) {
  return hydratePlan(get('SELECT * FROM plans WHERE slug = ?', String(slug)));
}

function planFields(data, current = null) {
  const pick = (k, def) => (data[k] !== undefined ? data[k] : current ? current[k] : def);
  const title = String(pick('title', '')).trim();
  if (!title) throw new AppError('validation', 'Укажите название плана', 422);
  const price = toInt(pick('price', NaN), NaN);
  if (!Number.isFinite(price) || price < 0) throw new AppError('validation', 'Укажите корректную цену', 422);
  const period = toInt(pick('period_days', 30), 30);
  if (period < 1 || period > 366) throw new AppError('validation', 'Период — от 1 до 366 дней', 422);
  let perks = pick('perks', []);
  if (typeof perks === 'string') {
    const parsed = parseJson(perks, null);
    perks = Array.isArray(parsed) ? parsed : perks.split(/\r?\n/);
  }
  perks = (Array.isArray(perks) ? perks : []).map((p) => String(p).trim()).filter(Boolean).slice(0, 12);
  return {
    title,
    description: String(pick('description', '')).trim(),
    price,
    period_days: period,
    perks: JSON.stringify(perks),
    image: String(pick('image', '')).trim(),
    badge: String(pick('badge', '')).trim(),
    active: data.active === undefined ? (current?.active ?? 1) : flag(data.active),
    sort: toInt(pick('sort', 0)),
  };
}

const planSlugTaken = (slug, exceptId = 0) => Boolean(get('SELECT 1 AS x FROM plans WHERE slug = ? AND id <> ?', slug, exceptId));

/** data: { title*, price*, period_days, description, perks (array | JSON | newline-separated), image, badge, active, sort, slug } */
export function createPlan(data) {
  const f = planFields(data);
  const slug = uniqueSlug(data.slug || f.title, (s) => planSlugTaken(s));
  const ts = now();
  const { lastInsertRowid } = run(
    `INSERT INTO plans (slug, title, description, price, period_days, perks, image, badge, active, sort, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    slug, f.title, f.description, f.price, f.period_days, f.perks, f.image, f.badge, f.active, f.sort, ts, ts,
  );
  return getPlan(Number(lastInsertRowid));
}

export function updatePlan(id, data) {
  const row = get('SELECT * FROM plans WHERE id = ?', Number(id));
  if (!row) throw notFound('План');
  const f = planFields(data, row);
  let slug = row.slug;
  if (data.slug && slugify(data.slug) !== row.slug) slug = uniqueSlug(data.slug, (s) => planSlugTaken(s, row.id));
  run(
    `UPDATE plans SET slug = ?, title = ?, description = ?, price = ?, period_days = ?, perks = ?, image = ?, badge = ?,
       active = ?, sort = ?, updated_at = ? WHERE id = ?`,
    slug, f.title, f.description, f.price, f.period_days, f.perks, f.image, f.badge, f.active, f.sort, now(), row.id,
  );
  return getPlan(row.id);
}

/** Delete a plan. Plans with subscriptions cannot be deleted — they are deactivated instead. Returns 'deleted' | 'deactivated'. */
export function deletePlan(id) {
  const used = get('SELECT 1 AS x FROM subscriptions WHERE plan_id = ? LIMIT 1', Number(id));
  if (used) {
    run('UPDATE plans SET active = 0, updated_at = ? WHERE id = ?', now(), Number(id));
    return 'deactivated';
  }
  run('DELETE FROM plans WHERE id = ?', Number(id));
  return 'deleted';
}

// ─────────────────────────────── subscriptions

const SUB_SELECT = `
  SELECT s.*, p.title AS plan_title, p.price AS plan_price, p.period_days AS plan_period_days, p.slug AS plan_slug,
         c.name AS customer_name, c.phone AS customer_phone, c.tg_user_id AS customer_tg_user_id, c.tg_username AS customer_tg_username
    FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN customers c ON c.id = s.customer_id`;

const hydrateSub = (row) => {
  if (!row) return null;
  const end = Date.parse(row.current_period_end);
  return {
    ...row,
    status_label: SUBSCRIPTION_STATUS_LABELS[row.status] || row.status,
    days_left: Math.max(0, Math.ceil((end - Date.now()) / DAY)),
    is_active: row.status === 'active' && end > Date.now(),
  };
};

export function getSubscription(id) {
  return hydrateSub(get(`${SUB_SELECT} WHERE s.id = ?`, Number(id)));
}

/** The customer's current (active or paused) subscription, or null. */
export function getCurrentForCustomer(customerId) {
  return hydrateSub(get(`${SUB_SELECT} WHERE s.customer_id = ? AND s.status IN ('active', 'paused') ORDER BY s.id DESC LIMIT 1`, Number(customerId)));
}

/** Current subscription of a Telegram user (via customers.tg_user_id), or null. */
export function getCurrentForTgUser(tgUserId) {
  return hydrateSub(get(`${SUB_SELECT} WHERE c.tg_user_id = ? AND s.status IN ('active', 'paused') ORDER BY s.id DESC LIMIT 1`, Number(tgUserId)));
}

/**
 * Admin list, newest first.
 * @param {{ status?: string, planId?: number, customerId?: number, limit?: number, offset?: number }} [f]
 * @returns {{ items: object[], total: number }}
 */
export function listSubscriptions(f = {}) {
  const where = [];
  const params = [];
  if (f.status) { where.push('s.status = ?'); params.push(String(f.status)); }
  if (f.planId) { where.push('s.plan_id = ?'); params.push(Number(f.planId)); }
  if (f.customerId) { where.push('s.customer_id = ?'); params.push(Number(f.customerId)); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = get(`SELECT COUNT(*) AS n FROM subscriptions s ${w}`, ...params).n;
  const items = all(`${SUB_SELECT} ${w} ORDER BY s.id DESC LIMIT ? OFFSET ?`, ...params, Number(f.limit || 50), Number(f.offset || 0)).map(hydrateSub);
  return { items, total };
}

/** { active, paused, cancelled, expired, mrr } — mrr = monthly-normalized revenue of active subscriptions. */
export function subscriptionStats() {
  const out = { active: 0, paused: 0, cancelled: 0, expired: 0, mrr: 0 };
  for (const r of all('SELECT status, COUNT(*) AS n FROM subscriptions GROUP BY status')) out[r.status] = r.n;
  out.mrr = Math.round(get(
    `SELECT COALESCE(SUM(p.price * 30.0 / p.period_days), 0) AS mrr FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.status = 'active'`).mrr);
  return out;
}

/**
 * Activate or extend a subscription from a PAID subscription order. Called by orders.markPaid()
 * inside its transaction — do not call directly from routes.
 * Same plan active → period is extended from max(now, current end); otherwise the previous
 * active/paused subscription is cancelled and a new one starts now.
 * @returns {{ subscription: object, renewed: boolean }}
 */
export function activateFromOrder(order) {
  if (order.kind !== 'subscription' || !order.plan_id || !order.customer_id) {
    throw new AppError('validation', 'Заказ не является заказом подписки', 400);
  }
  const plan = get('SELECT * FROM plans WHERE id = ?', order.plan_id);
  if (!plan) throw notFound('План подписки');
  return tx(() => {
    const ts = now();
    const current = get(
      `SELECT * FROM subscriptions WHERE customer_id = ? AND status IN ('active', 'paused') ORDER BY id DESC LIMIT 1`, order.customer_id);
    if (current && current.plan_id === plan.id) {
      const base = Math.max(Date.now(), Date.parse(current.current_period_end));
      run(
        `UPDATE subscriptions SET status = 'active', current_period_end = ?, last_order_id = ?, renewals = renewals + 1, updated_at = ? WHERE id = ?`,
        new Date(base + plan.period_days * DAY).toISOString(), order.id, ts, current.id,
      );
      return { subscription: getSubscription(current.id), renewed: true };
    }
    if (current) {
      run(`UPDATE subscriptions SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?`, ts, ts, current.id);
    }
    const { lastInsertRowid } = run(
      `INSERT INTO subscriptions (customer_id, plan_id, status, started_at, current_period_end, last_order_id, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?, ?)`,
      order.customer_id, plan.id, ts, new Date(Date.now() + plan.period_days * DAY).toISOString(), order.id, ts, ts,
    );
    return { subscription: getSubscription(Number(lastInsertRowid)), renewed: false };
  });
}

/**
 * Undo the effect of a refunded subscription order: a renewal loses one period,
 * a first payment cancels the subscription. Called by orders.refund().
 */
export function revertFromOrder(order) {
  const sub = get('SELECT * FROM subscriptions WHERE last_order_id = ?', order.id);
  if (!sub) return null;
  const plan = get('SELECT period_days FROM plans WHERE id = ?', sub.plan_id);
  const ts = now();
  if (sub.renewals > 0 && plan) {
    const end = Date.parse(sub.current_period_end) - plan.period_days * DAY;
    run(`UPDATE subscriptions SET current_period_end = ?, renewals = renewals - 1, status = ?, updated_at = ? WHERE id = ?`,
      new Date(end).toISOString(), end > Date.now() ? sub.status : 'expired', ts, sub.id);
  } else {
    run(`UPDATE subscriptions SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?`, ts, ts, sub.id);
  }
  return getSubscription(sub.id);
}

/**
 * Change status: 'paused' | 'active' (resume) | 'cancelled'.
 * Allowed: active→paused, paused→active, active|paused→cancelled.
 */
export function setSubscriptionStatus(id, status) {
  const sub = get('SELECT * FROM subscriptions WHERE id = ?', Number(id));
  if (!sub) throw notFound('Подписка');
  const allowed = { active: ['paused', 'cancelled'], paused: ['active', 'cancelled'] };
  if (!(allowed[sub.status] || []).includes(status)) {
    throw new AppError('bad_transition', 'Нельзя изменить статус этой подписки', 409);
  }
  const ts = now();
  run('UPDATE subscriptions SET status = ?, cancelled_at = ?, updated_at = ? WHERE id = ?',
    status, status === 'cancelled' ? ts : sub.cancelled_at, ts, sub.id);
  return getSubscription(sub.id);
}

export const pauseSubscription = (id) => setSubscriptionStatus(id, 'paused');
export const resumeSubscription = (id) => setSubscriptionStatus(id, 'active');
export const cancelSubscription = (id) => setSubscriptionStatus(id, 'cancelled');

/** Mark active subscriptions whose period ended as expired. Runs at boot and hourly. Returns the number expired. */
export function expireDue() {
  return run(`UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE status = 'active' AND current_period_end < ?`, now(), now()).changes;
}
