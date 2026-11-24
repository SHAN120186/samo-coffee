// Subscription plans (CRUD) and customer subscriptions (list + pause / resume / cancel).
import { Router } from 'express';
import * as subscriptions from '../../services/subscriptions.js';
import { notFound } from '../../lib/errors.js';
import { clean } from '../../lib/escape.js';
import { view, intParam, flag, list, isUserError, flatQuery, paginate, pageOffset, backUrl } from '../lib.js';

const router = Router();

// ─────────────────────────────── plans

router.get('/plans', (req, res) => {
  const plans = subscriptions.listPlans({ activeOnly: false }).map((p) => ({
    ...p,
    subscribers: subscriptions.listSubscriptions({ planId: p.id, status: 'active', limit: 1 }).total,
  }));
  res.render(view('plans/index'), { title: 'Планы подписки', section: 'plans', plans, stats: subscriptions.subscriptionStats() });
});

function planInput(body) {
  return {
    title: clean(body.title, 120),
    slug: clean(body.slug, 120),
    description: clean(body.description, 1000),
    price: clean(body.price, 12).replace(/\s/g, ''),
    period_days: clean(body.period_days, 4) || '30',
    perks: String(body.perks ?? '').split(/\r?\n/).map((p) => clean(p, 200)).filter(Boolean),
    image: clean(body.image, 1000),
    badge: clean(body.badge, 40),
    sort: clean(body.sort, 6) || '0',
    active: flag(body.active),
  };
}

function validatePlan(data) {
  const fields = {};
  if (!data.title) fields.title = 'Укажите название плана';
  if (!/^\d+$/.test(data.price)) fields.price = 'Цена — целое число сумов';
  if (!/^\d+$/.test(data.period_days) || Number(data.period_days) < 1 || Number(data.period_days) > 366) fields.period_days = 'Период — от 1 до 366 дней';
  if (data.slug && !/^[a-z0-9-]+$/i.test(data.slug)) fields.slug = 'Только латинские буквы, цифры и дефис';
  if (data.image && !/^(\/(?!\/)|https?:\/\/)/.test(data.image)) fields.image = 'Ссылка должна начинаться с «/» или «https://»';
  return fields;
}

function renderPlanForm(req, res, { plan, isNew, status = 200, error = null, fields = {} }) {
  res.status(status).render(view('plans/form'), {
    title: isNew ? 'Новый план' : plan.title || 'План',
    section: 'plans',
    plan,
    isNew,
    error,
    fields,
  });
}

router.get('/plans/new', (req, res) => {
  renderPlanForm(req, res, {
    plan: { title: '', slug: '', description: '', price: '', period_days: 30, perks: [], image: '', badge: '', sort: 0, active: 1 },
    isNew: true,
  });
});

router.post('/plans', (req, res, next) => {
  const data = planInput(req.body);
  const fields = validatePlan(data);
  if (Object.keys(fields).length) return renderPlanForm(req, res, { plan: data, isNew: true, status: 422, error: 'Проверьте отмеченные поля', fields });
  try {
    const plan = subscriptions.createPlan(data);
    req.flash('success', `План «${plan.title}» создан`);
    return res.redirect('/admin/plans');
  } catch (err) {
    if (isUserError(err)) return renderPlanForm(req, res, { plan: data, isNew: true, status: 422, error: err.message });
    return next(err);
  }
});

function loadPlan(req) {
  const id = intParam(req.params.id);
  const plan = id ? subscriptions.getPlan(id) : null;
  if (!plan) throw notFound('План');
  return plan;
}

router.post('/plans/reorder', (req, res) => {
  const ids = list(req.body.ids, 100).map(intParam).filter(Boolean);
  ids.forEach((id, index) => {
    if (subscriptions.getPlan(id)) subscriptions.updatePlan(id, { sort: index + 1 });
  });
  if (req.xhr || req.accepts(['html', 'json']) === 'json') return res.json({ ok: true });
  req.flash('success', 'Порядок планов сохранён');
  return res.redirect('/admin/plans');
});

router.get('/plans/:id', (req, res) => {
  // The stored image may be empty (the service substitutes a default picture when reading).
  renderPlanForm(req, res, { plan: loadPlan(req), isNew: false });
});

router.post('/plans/:id', (req, res, next) => {
  const current = loadPlan(req);
  const data = planInput(req.body);
  const fields = validatePlan(data);
  if (Object.keys(fields).length) return renderPlanForm(req, res, { plan: { ...current, ...data }, isNew: false, status: 422, error: 'Проверьте отмеченные поля', fields });
  try {
    const plan = subscriptions.updatePlan(current.id, data);
    req.flash('success', `План «${plan.title}» сохранён`);
    return res.redirect('/admin/plans');
  } catch (err) {
    if (isUserError(err)) return renderPlanForm(req, res, { plan: { ...current, ...data }, isNew: false, status: 422, error: err.message });
    return next(err);
  }
});

router.post('/plans/:id/delete', (req, res) => {
  const plan = loadPlan(req);
  const result = subscriptions.deletePlan(plan.id);
  if (result === 'deactivated') {
    req.flash('warning', `У плана «${plan.title}» есть подписчики, поэтому он не удалён, а скрыт с сайта.`);
  } else {
    req.flash('success', `План «${plan.title}» удалён`);
  }
  res.redirect('/admin/plans');
});

// ─────────────────────────────── subscriptions

const SUB_PER_PAGE = 25;

router.get('/subscriptions', (req, res) => {
  const q = flatQuery(req.query);
  const status = subscriptions.SUBSCRIPTION_STATUS_LABELS[q.status] ? q.status : '';
  const planId = intParam(q.plan);
  const { items, total } = subscriptions.listSubscriptions({
    status: status || undefined, planId: planId || undefined, limit: SUB_PER_PAGE, offset: pageOffset(req, SUB_PER_PAGE),
  });
  res.render(view('subscriptions/index'), {
    title: 'Подписки',
    section: 'subscriptions',
    items,
    pager: paginate(req, total, SUB_PER_PAGE),
    stats: subscriptions.subscriptionStats(),
    plans: subscriptions.listPlans({ activeOnly: false }),
    statuses: subscriptions.SUBSCRIPTION_STATUS_LABELS,
    filters: { status, plan: planId || '' },
  });
});

const SUB_ACTIONS = {
  pause: { fn: subscriptions.pauseSubscription, done: 'Подписка поставлена на паузу' },
  resume: { fn: subscriptions.resumeSubscription, done: 'Подписка возобновлена' },
  cancel: { fn: subscriptions.cancelSubscription, done: 'Подписка отменена' },
};

router.post('/subscriptions/:id/:action', (req, res, next) => {
  const id = intParam(req.params.id);
  const action = SUB_ACTIONS[req.params.action];
  if (!id || !action) return next();
  action.fn(id); // throws not_found / bad_transition → flash + redirect back (router error handler)
  req.flash('success', action.done);
  return res.redirect(backUrl(req, '/admin/subscriptions'));
});

export default router;
