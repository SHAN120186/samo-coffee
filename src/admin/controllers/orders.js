// Orders: list with filters, CSV export, detail page, status machine actions.
// All state changes go through the order service (which also sends customer notifications).
import { Router } from 'express';
import * as orders from '../../services/orders.js';
import * as paymentsRepo from '../../services/payments.js';
import * as customers from '../../services/customers.js';
import * as subscriptions from '../../services/subscriptions.js';
import * as auth from '../../services/auth.js';
import { notFound } from '../../lib/errors.js';
import { clean } from '../../lib/escape.js';
import { formatDateTimeFull } from '../../lib/dates.js';
import { view, intParam, flatQuery, paginate, pageOffset, toCsv, actorLabel, qs, PROVIDER_LABELS } from '../lib.js';

const router = Router();
const PER_PAGE = 25;

const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/** Query string → validated filters for orders.listOrders(). */
function readFilters(query) {
  const q = flatQuery(query);
  return {
    status: orders.ORDER_STATUSES.includes(q.status) ? q.status : '',
    paymentStatus: orders.PAYMENT_STATUSES.includes(q.payment) ? q.payment : '',
    channel: orders.CHANNEL_LABELS[q.channel] ? q.channel : '',
    kind: orders.KIND_LABELS[q.kind] ? q.kind : '',
    from: isDay(q.from) ? q.from : '',
    to: isDay(q.to) ? q.to : '',
    search: clean(q.search, 80),
  };
}

/** Filters as they appear in URLs (payment status is `payment`). */
const filterQuery = (f) => ({ status: f.status, payment: f.paymentStatus, channel: f.channel, kind: f.kind, from: f.from, to: f.to, search: f.search });

router.get('/', (req, res) => {
  const filters = readFilters(req.query);
  const { items, total } = orders.listOrders({ ...filters, limit: PER_PAGE, offset: pageOffset(req, PER_PAGE) });
  const counts = orders.countByStatus();
  const query = filterQuery(filters);
  res.render(view('orders/index'), {
    title: 'Заказы',
    section: 'orders',
    items,
    pager: paginate(req, total, PER_PAGE),
    filters,
    counts,
    statuses: orders.ORDER_STATUS_LABELS,
    paymentStatuses: orders.PAYMENT_STATUS_LABELS,
    channels: orders.CHANNEL_LABELS,
    kinds: orders.KIND_LABELS,
    hasFilters: Object.values(filters).some(Boolean),
    statusLink: (status) => `/admin/orders${qs({ ...query, status })}`,
    exportUrl: `/admin/orders/export.csv${qs(query)}`,
  });
});

router.get('/export.csv', (req, res) => {
  const filters = readFilters(req.query);
  const rows = [];
  const MAX_ROWS = 20000;
  for (let offset = 0; offset < MAX_ROWS; offset += 500) {
    const { items } = orders.listOrders({ ...filters, limit: 500, offset });
    for (const o of items) {
      rows.push([
        o.number, formatDateTimeFull(o.created_at), o.status_label, o.payment_status_label,
        PROVIDER_LABELS[o.payment_provider] || o.payment_provider || '', o.channel_label, o.kind_label,
        o.customer_name, o.customer_phone, o.customer_email, o.delivery_method_label, o.delivery_address,
        o.items_count, o.subtotal, o.delivery_fee, o.total, o.paid_at ? formatDateTimeFull(o.paid_at) : '', o.source, o.comment,
      ]);
    }
    if (items.length < 500) break;
  }
  const header = ['Номер', 'Создан', 'Статус', 'Оплата', 'Провайдер', 'Канал', 'Тип', 'Клиент', 'Телефон', 'E-mail', 'Доставка', 'Адрес',
    'Позиций', 'Товары, сум', 'Доставка, сум', 'Итого, сум', 'Оплачен', 'Источник', 'Комментарий'];
  const stamp = new Date().toISOString().slice(0, 10);
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="samo-orders-${stamp}.csv"`,
  });
  res.send(toCsv(header, rows));
});

function loadOrder(req) {
  const id = intParam(req.params.id);
  const order = id ? orders.getOrder(id) : null;
  if (!order) throw notFound('Заказ');
  return order;
}

router.get('/:id', (req, res) => {
  const order = loadOrder(req);
  const adminsById = new Map(auth.listAdmins().map((a) => [a.id, a]));
  const events = orders.getOrderEvents(order.id).map((e) => ({
    ...e,
    actor_label: actorLabel(e.actor, adminsById),
    from_label: orders.ORDER_STATUS_LABELS[e.from_value] || orders.PAYMENT_STATUS_LABELS[e.from_value] || e.from_value,
    to_label: orders.ORDER_STATUS_LABELS[e.to_value] || orders.PAYMENT_STATUS_LABELS[e.to_value] || e.to_value,
  }));
  const customer = order.customer_id ? customers.getCustomer(order.customer_id) : null;
  const transitions = orders.allowedTransitions(order);
  res.render(view('orders/show'), {
    title: `Заказ ${order.number}`,
    section: 'orders',
    order,
    events,
    payments: paymentsRepo.listByOrder(order.id),
    customer,
    customerStats: customer ? customers.customerStats(customer.id) : null,
    subscription: order.kind === 'subscription' && customer ? subscriptions.getCurrentForCustomer(customer.id) : null,
    // "paid", "cancelled" and "refunded" have dedicated buttons with confirmation.
    nextStatuses: transitions.filter((t) => !['paid', 'cancelled', 'refunded', 'pending_payment'].includes(t.status)),
    canMarkPaid: transitions.some((t) => t.status === 'paid'),
    canCancel: transitions.some((t) => t.status === 'cancelled'),
    canRefund: transitions.some((t) => t.status === 'refunded'),
    notifiable: Boolean(order.tg_user_id),
  });
});

const actor = (req) => `admin:${req.admin.id}`;

router.post('/:id/status', (req, res) => {
  const order = loadOrder(req);
  const status = clean(req.body.status, 30);
  const note = clean(req.body.note, 500);
  const result = orders.setStatus(order.id, status, { actor: actor(req), note });
  if (result.changed) {
    const tail = order.tg_user_id ? ' Клиент получит уведомление в Telegram.' : '';
    req.flash('success', `Статус заказа ${order.number}: «${result.order.status_label}».${tail}`);
  } else {
    req.flash('info', 'Статус не изменился');
  }
  res.redirect(`/admin/orders/${order.id}`);
});

router.post('/:id/mark-paid', (req, res) => {
  const order = loadOrder(req);
  const result = orders.markPaid(order.id, { provider: 'manual', actor: actor(req) });
  req.flash(result.changed ? 'success' : 'info', result.changed
    ? `Заказ ${order.number} отмечен оплаченным${order.kind === 'subscription' ? ', подписка активирована' : ', остатки списаны'}.`
    : 'Заказ уже был оплачен');
  res.redirect(`/admin/orders/${order.id}`);
});

router.post('/:id/cancel', (req, res) => {
  const order = loadOrder(req);
  const result = orders.cancel(order.id, { actor: actor(req), reason: clean(req.body.reason, 300) });
  req.flash(result.changed ? 'success' : 'info', result.changed ? `Заказ ${order.number} отменён` : 'Заказ уже отменён');
  res.redirect(`/admin/orders/${order.id}`);
});

router.post('/:id/refund', (req, res) => {
  const order = loadOrder(req);
  const result = orders.refund(order.id, { actor: actor(req), reason: clean(req.body.reason, 300) });
  req.flash(result.changed ? 'warning' : 'info', result.changed
    ? `Возврат по заказу ${order.number} оформлен: ${order.kind === 'subscription' ? 'период подписки отменён' : 'товары возвращены на склад'}. Деньги верните клиенту в кабинете платёжного провайдера.`
    : 'Возврат уже оформлен');
  res.redirect(`/admin/orders/${order.id}`);
});

router.post('/:id/note', (req, res) => {
  const order = loadOrder(req);
  orders.setAdminNote(order.id, req.body.admin_note);
  req.flash('success', 'Заметка сохранена');
  res.redirect(`/admin/orders/${order.id}`);
});

router.post('/:id/comment', (req, res) => {
  const order = loadOrder(req);
  const note = clean(req.body.note, 500);
  if (!note) {
    req.flash('error', 'Напишите текст записи');
  } else {
    orders.addNote(order.id, note, actor(req));
    req.flash('success', 'Запись добавлена в историю заказа');
  }
  res.redirect(`/admin/orders/${order.id}`);
});

export default router;
