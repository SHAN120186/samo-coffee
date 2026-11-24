// Customers: searchable list and a profile with order history, subscriptions and feedback.
import { Router } from 'express';
import * as customers from '../../services/customers.js';
import * as orders from '../../services/orders.js';
import * as subscriptions from '../../services/subscriptions.js';
import * as feedback from '../../services/feedback.js';
import { notFound } from '../../lib/errors.js';
import { clean } from '../../lib/escape.js';
import { view, intParam, flatQuery, paginate, pageOffset, isUserError, toCsv } from '../lib.js';
import { formatDateTimeFull } from '../../lib/dates.js';

const router = Router();
const PER_PAGE = 25;
const SOURCE_LABELS = { site: 'Сайт', tma: 'Мини-приложение', bot: 'Бот', admin: 'Админ-панель' };

router.get('/', (req, res) => {
  const q = flatQuery(req.query);
  const search = clean(q.search, 80);
  const { items, total } = customers.listCustomers({ search, limit: PER_PAGE, offset: pageOffset(req, PER_PAGE) });
  res.render(view('customers/index'), {
    title: 'Клиенты',
    section: 'customers',
    items,
    pager: paginate(req, total, PER_PAGE),
    search,
    totalAll: customers.countCustomers(),
    sourceLabels: SOURCE_LABELS,
  });
});

router.get('/export.csv', (req, res) => {
  const search = clean(flatQuery(req.query).search, 80);
  const { items } = customers.listCustomers({ search, limit: 100000, offset: 0 });
  const rows = items.map((c) => [
    c.id, c.name, c.phone || '', c.email || '', c.tg_username ? `@${c.tg_username}` : '', SOURCE_LABELS[c.source] || c.source,
    c.orders_count, c.paid_total, c.last_order_at ? formatDateTimeFull(c.last_order_at) : '', formatDateTimeFull(c.created_at),
  ]);
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="samo-customers-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
  res.send(toCsv(['ID', 'Имя', 'Телефон', 'E-mail', 'Telegram', 'Источник', 'Заказов', 'Оплачено, сум', 'Последний заказ', 'Создан'], rows));
});

function loadCustomer(req) {
  const id = intParam(req.params.id);
  const customer = id ? customers.getCustomer(id) : null;
  if (!customer) throw notFound('Клиент');
  return customer;
}

function renderCustomer(req, res, customer, { status = 200, error = null, form = null } = {}) {
  const threads = customer.tg_user_id ? feedback.listThreads({ tgUserId: customer.tg_user_id, limit: 10 }).items : [];
  res.status(status).render(view('customers/show'), {
    title: customer.name || `Клиент #${customer.id}`,
    section: 'customers',
    customer,
    form: form || customer,
    stats: customers.customerStats(customer.id),
    orders: orders.listOrders({ customerId: customer.id, limit: 50 }),
    subs: subscriptions.listSubscriptions({ customerId: customer.id, limit: 20 }).items,
    threads,
    sourceLabels: SOURCE_LABELS,
    error,
  });
}

router.get('/:id', (req, res) => {
  renderCustomer(req, res, loadCustomer(req));
});

router.post('/:id', (req, res, next) => {
  const customer = loadCustomer(req);
  const form = {
    name: clean(req.body.name, 120),
    phone: clean(req.body.phone, 30),
    email: clean(req.body.email, 160),
    address: clean(req.body.address, 300),
    notes: clean(req.body.notes, 2000),
  };
  try {
    customers.updateCustomer(customer.id, form);
  } catch (err) {
    if (isUserError(err)) return renderCustomer(req, res, customer, { status: 422, error: err.message, form: { ...customer, ...form } });
    return next(err);
  }
  req.flash('success', 'Данные клиента сохранены');
  return res.redirect(`/admin/customers/${customer.id}`);
});

export default router;
