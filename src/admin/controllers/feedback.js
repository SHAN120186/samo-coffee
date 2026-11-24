// Feedback inbox: one list for site / bot / Mini App threads, chat view and replies.
// Replies go through feedback.reply(): Telegram threads are delivered by the bot.
import { Router } from 'express';
import * as feedback from '../../services/feedback.js';
import * as customers from '../../services/customers.js';
import { notFound } from '../../lib/errors.js';
import { clean } from '../../lib/escape.js';
import { view, wrap, intParam, flatQuery, qs, paginate, pageOffset, isUserError } from '../lib.js';

const router = Router();
const PER_PAGE = 30;

function readFilters(query) {
  const q = flatQuery(query);
  return {
    status: feedback.FEEDBACK_STATUS_LABELS[q.status] ? q.status : '',
    channel: feedback.FEEDBACK_CHANNELS.includes(q.channel) ? q.channel : '',
    search: clean(q.search, 80),
  };
}

function inbox(req, res, { thread = null, status = 200, error = null, draft = '' } = {}) {
  const filters = readFilters(req.query);
  const { items, total } = feedback.listThreads({ ...filters, limit: PER_PAGE, offset: pageOffset(req, PER_PAGE) });
  const page = Number.parseInt(req.query.page, 10) > 1 ? Number.parseInt(req.query.page, 10) : '';
  const keep = { ...filters, page };
  res.status(status).render(view('feedback/index'), {
    title: thread ? `Обращение #${thread.id}` : 'Обращения',
    section: 'feedback',
    items,
    pager: paginate(req, total, PER_PAGE, '/admin/feedback'),
    filters,
    counts: feedback.counts(),
    statuses: feedback.FEEDBACK_STATUS_LABELS,
    channels: feedback.FEEDBACK_CHANNEL_LABELS,
    thread,
    customer: thread?.customer_id ? customers.getCustomer(thread.customer_id) : null,
    threadLink: (id) => `/admin/feedback/${id}${qs(keep)}`,
    listLink: (extra = {}) => `/admin/feedback${qs({ ...filters, ...extra })}`,
    keepQuery: qs(keep),
    maxLength: feedback.MAX_MESSAGE_LENGTH,
    error,
    draft,
  });
}

router.get('/', (req, res) => inbox(req, res));

function loadThread(req) {
  const id = intParam(req.params.id);
  const thread = id ? feedback.getThread(id) : null;
  if (!thread) throw notFound('Обращение');
  return thread;
}

router.get('/:id', (req, res) => {
  const thread = loadThread(req);
  if (thread.unread) feedback.markRead(thread.id);
  // Re-read the counters after marking as read so the sidebar badge is already correct.
  res.locals.navCounts = { ...res.locals.navCounts, feedback: feedback.counts().unread };
  inbox(req, res, { thread: { ...thread, unread: 0 } });
});

const back = (req, id) => `/admin/feedback/${id}${qs(readFiltersWithPage(req))}`;
function readFiltersWithPage(req) {
  const page = Number.parseInt(req.query.page, 10);
  return { ...readFilters(req.query), page: page > 1 ? page : '' };
}

router.post('/:id/reply', wrap(async (req, res) => {
  const thread = loadThread(req);
  const text = clean(req.body.text, feedback.MAX_MESSAGE_LENGTH);
  if (!text) {
    return inbox(req, res, { thread, status: 422, error: 'Напишите текст ответа' });
  }
  let result;
  try {
    result = await feedback.reply(thread.id, { text, adminId: req.admin.id, via: 'panel' });
  } catch (err) {
    if (isUserError(err)) return inbox(req, res, { thread, status: 422, error: err.message, draft: text });
    throw err;
  }
  if (result.delivered) {
    req.flash('success', 'Ответ отправлен клиенту в Telegram');
  } else if (result.deliverable) {
    req.flash('warning', result.error || 'Ответ сохранён, но не доставлен в Telegram');
  } else {
    req.flash('info', `Ответ сохранён. Это обращение с сайта — свяжитесь с клиентом по контакту: ${thread.contact || 'не указан'}`);
  }
  return res.redirect(back(req, thread.id));
}));

router.post('/:id/status', (req, res) => {
  const thread = loadThread(req);
  const status = clean(req.body.status, 20);
  feedback.setThreadStatus(thread.id, status); // throws 'validation' for unknown values
  const messages = { closed: 'Обращение закрыто', open: 'Обращение снова открыто', answered: 'Обращение отмечено как отвеченное' };
  req.flash('success', messages[status]);
  res.redirect(back(req, thread.id));
});

router.post('/:id/delete', (req, res) => {
  const thread = loadThread(req);
  feedback.deleteThread(thread.id);
  req.flash('success', `Обращение #${thread.id} удалено`);
  res.redirect(`/admin/feedback${qs(readFilters(req.query))}`);
});

export default router;
