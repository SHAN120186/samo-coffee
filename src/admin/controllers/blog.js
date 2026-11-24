// Blog posts (rich text) and FAQ (with manual ordering).
import { Router } from 'express';
import * as posts from '../../services/posts.js';
import * as faq from '../../services/faq.js';
import { notFound } from '../../lib/errors.js';
import { clean } from '../../lib/escape.js';
import { isoDate } from '../../lib/dates.js';
import { view, intParam, flag, list, isUserError, paginate, pageOffset, backUrl } from '../lib.js';

const router = Router();

// ─────────────────────────────── posts

const POSTS_PER_PAGE = 20;

router.get('/posts', (req, res) => {
  const { items, total } = posts.listPosts({ publishedOnly: false, limit: POSTS_PER_PAGE, offset: pageOffset(req, POSTS_PER_PAGE) });
  res.render(view('posts/index'), { title: 'Блог', section: 'posts', posts: items, pager: paginate(req, total, POSTS_PER_PAGE) });
});

function postInput(body) {
  const date = clean(body.published_date, 10);
  return {
    title: clean(body.title, 200),
    slug: clean(body.slug, 120),
    excerpt: clean(body.excerpt, 400),
    body_html: typeof body.body_html === 'string' ? body.body_html : '',
    cover: clean(body.cover, 1000),
    author: clean(body.author, 120),
    published: flag(body.published),
    // Noon UTC keeps the chosen calendar day stable in the business timezone.
    published_at: /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T07:00:00.000Z` : '',
    published_date: date,
  };
}

function validatePost(data) {
  const fields = {};
  if (!data.title) fields.title = 'Укажите заголовок статьи';
  if (data.slug && !/^[a-z0-9-]+$/i.test(data.slug)) fields.slug = 'Только латинские буквы, цифры и дефис';
  if (data.cover && !/^(\/(?!\/)|https?:\/\/)/.test(data.cover)) fields.cover = 'Ссылка должна начинаться с «/» или «https://»';
  if (data.published_date && !data.published_at) fields.published_date = 'Дата в формате ГГГГ-ММ-ДД';
  return fields;
}

function renderPostForm(req, res, { post, isNew, status = 200, error = null, fields = {} }) {
  res.status(status).render(view('posts/form'), {
    title: isNew ? 'Новая статья' : post.title || 'Статья',
    section: 'posts',
    post: { ...post, published_date: post.published_date ?? (post.published_at ? isoDate(post.published_at) : '') },
    isNew,
    error,
    fields,
  });
}

router.get('/posts/new', (req, res) => {
  renderPostForm(req, res, {
    post: { title: '', slug: '', excerpt: '', body_html: '', cover: '', author: req.admin.name || '', published: 0, published_at: null },
    isNew: true,
  });
});

router.post('/posts', (req, res, next) => {
  const data = postInput(req.body);
  const fields = validatePost(data);
  if (Object.keys(fields).length) return renderPostForm(req, res, { post: data, isNew: true, status: 422, error: 'Проверьте отмеченные поля', fields });
  try {
    const post = posts.createPost(data);
    req.flash('success', post.published ? `Статья «${post.title}» опубликована` : `Черновик «${post.title}» сохранён`);
    return res.redirect(`/admin/posts/${post.id}`);
  } catch (err) {
    if (isUserError(err)) return renderPostForm(req, res, { post: data, isNew: true, status: 422, error: err.message });
    return next(err);
  }
});

function loadPost(req) {
  const id = intParam(req.params.id);
  const post = id ? posts.getPost(id) : null;
  if (!post) throw notFound('Статья');
  return post;
}

router.get('/posts/:id', (req, res) => {
  renderPostForm(req, res, { post: loadPost(req), isNew: false });
});

router.post('/posts/:id', (req, res, next) => {
  const current = loadPost(req);
  const data = postInput(req.body);
  const fields = validatePost(data);
  if (Object.keys(fields).length) return renderPostForm(req, res, { post: { ...current, ...data }, isNew: false, status: 422, error: 'Проверьте отмеченные поля', fields });
  try {
    const post = posts.updatePost(current.id, data);
    req.flash('success', post.published ? `Статья «${post.title}» сохранена и опубликована` : `Черновик «${post.title}» сохранён`);
    return res.redirect(`/admin/posts/${post.id}`);
  } catch (err) {
    if (isUserError(err)) return renderPostForm(req, res, { post: { ...current, ...data }, isNew: false, status: 422, error: err.message });
    return next(err);
  }
});

router.post('/posts/:id/toggle', (req, res) => {
  const post = loadPost(req);
  const updated = posts.updatePost(post.id, { published: post.published ? 0 : 1 });
  req.flash('success', updated.published ? `Статья «${updated.title}» опубликована` : `Статья «${updated.title}» снята с публикации`);
  res.redirect(backUrl(req, '/admin/posts'));
});

router.post('/posts/:id/delete', (req, res) => {
  const post = loadPost(req);
  posts.deletePost(post.id);
  req.flash('success', `Статья «${post.title}» удалена`);
  res.redirect('/admin/posts');
});

// ─────────────────────────────── FAQ

router.get('/faq', (req, res) => {
  const items = faq.listFaq({ activeOnly: false });
  res.render(view('faq/index'), { title: 'Вопросы и ответы', section: 'faq', items });
});

function faqInput(body) {
  return {
    question: clean(body.question, 300),
    answer: typeof body.answer === 'string' ? body.answer : '',
    topic: clean(body.topic, 80),
    sort: clean(body.sort, 6),
    active: flag(body.active),
  };
}

function renderFaqForm(req, res, { item, isNew, status = 200, error = null, fields = {} }) {
  const topics = [...new Set(faq.listFaq({ activeOnly: false }).map((f) => f.topic).filter(Boolean))];
  res.status(status).render(view('faq/form'), {
    title: isNew ? 'Новый вопрос' : 'Вопрос',
    section: 'faq',
    item,
    isNew,
    topics,
    error,
    fields,
  });
}

router.get('/faq/new', (req, res) => {
  renderFaqForm(req, res, { item: { question: '', answer: '', topic: '', sort: '', active: 1 }, isNew: true });
});

router.post('/faq', (req, res, next) => {
  const data = faqInput(req.body);
  if (!data.question) return renderFaqForm(req, res, { item: data, isNew: true, status: 422, error: 'Проверьте отмеченные поля', fields: { question: 'Укажите вопрос' } });
  try {
    // New questions go to the end of the list unless a position was typed in.
    const all = faq.listFaq({ activeOnly: false });
    const sort = /^\d+$/.test(data.sort) ? data.sort : String(all.reduce((m, f) => Math.max(m, f.sort), 0) + 1);
    faq.createFaq({ ...data, sort });
    req.flash('success', 'Вопрос добавлен');
    return res.redirect('/admin/faq');
  } catch (err) {
    if (isUserError(err)) return renderFaqForm(req, res, { item: data, isNew: true, status: 422, error: err.message });
    return next(err);
  }
});

/** Save a new order: ids[] in the order shown on the screen. */
router.post('/faq/reorder', (req, res) => {
  const ids = list(req.body.ids, 500).map(intParam).filter(Boolean);
  ids.forEach((id, index) => {
    if (faq.getFaq(id)) faq.updateFaq(id, { sort: index + 1 });
  });
  if (req.xhr || req.accepts(['html', 'json']) === 'json') return res.json({ ok: true });
  req.flash('success', 'Порядок вопросов сохранён');
  return res.redirect('/admin/faq');
});

function loadFaq(req) {
  const id = intParam(req.params.id);
  const item = id ? faq.getFaq(id) : null;
  if (!item) throw notFound('Запись');
  return item;
}

router.get('/faq/:id', (req, res) => {
  renderFaqForm(req, res, { item: loadFaq(req), isNew: false });
});

router.post('/faq/:id', (req, res, next) => {
  const current = loadFaq(req);
  const data = faqInput(req.body);
  if (!data.question) return renderFaqForm(req, res, { item: { ...current, ...data }, isNew: false, status: 422, error: 'Проверьте отмеченные поля', fields: { question: 'Укажите вопрос' } });
  try {
    faq.updateFaq(current.id, { ...data, sort: /^\d+$/.test(data.sort) ? data.sort : current.sort });
    req.flash('success', 'Вопрос сохранён');
    return res.redirect('/admin/faq');
  } catch (err) {
    if (isUserError(err)) return renderFaqForm(req, res, { item: { ...current, ...data }, isNew: false, status: 422, error: err.message });
    return next(err);
  }
});

/** Move one step up / down (works without JavaScript). */
router.post('/faq/:id/move', (req, res) => {
  const item = loadFaq(req);
  const all = faq.listFaq({ activeOnly: false });
  const index = all.findIndex((f) => f.id === item.id);
  const target = req.body.dir === 'up' ? index - 1 : index + 1;
  if (index >= 0 && target >= 0 && target < all.length) {
    const order = all.map((f) => f.id);
    [order[index], order[target]] = [order[target], order[index]];
    order.forEach((id, i) => faq.updateFaq(id, { sort: i + 1 }));
  }
  res.redirect('/admin/faq');
});

router.post('/faq/:id/toggle', (req, res) => {
  const item = loadFaq(req);
  faq.updateFaq(item.id, { active: item.active ? 0 : 1 });
  req.flash('success', item.active ? 'Вопрос скрыт с сайта' : 'Вопрос опубликован');
  res.redirect('/admin/faq');
});

router.post('/faq/:id/delete', (req, res) => {
  const item = loadFaq(req);
  faq.deleteFaq(item.id);
  req.flash('success', 'Вопрос удалён');
  res.redirect('/admin/faq');
});

export default router;
