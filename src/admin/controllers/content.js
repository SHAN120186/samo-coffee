// Content editor: every text / image block of the public pages, grouped by page.
import { Router } from 'express';
import * as content from '../../services/content.js';
import { notFound } from '../../lib/errors.js';
import { view, isUserError } from '../lib.js';

const router = Router();

/** Where a page of blocks can be seen on the public site. */
const PAGE_URLS = {
  global: '/',
  home: '/',
  catalog: '/catalog',
  subscriptions: '/subscriptions',
  about: '/about',
  blog: '/blog',
  delivery: '/delivery',
  faq: '/faq',
  contacts: '/contacts',
  cart: '/cart',
  checkout: '/checkout',
  notfound: '/404',
  tma: '/tma/',
};

const PAGE_HINTS = {
  global: 'Логотип, строка-анонс, кнопка в шапке и тексты подвала — видны на всех страницах.',
  order: 'Тексты страницы статуса заказа: показываются после оплаты и по ссылке из уведомлений.',
  tma: 'Тексты и баннер мини-приложения в Telegram.',
  notfound: 'Что видит посетитель, если страница не найдена.',
};

/** Blocks → sections by the label prefix before ":" ("Первый экран: заголовок"). */
function groupBlocks(blocks) {
  const groups = [];
  const byTitle = new Map();
  for (const block of blocks) {
    const label = block.label || block.key;
    const idx = label.indexOf(':');
    const title = idx > 0 ? label.slice(0, idx).trim() : 'Основное';
    const short = idx > 0 ? label.slice(idx + 1).trim() : label;
    if (!byTitle.has(title)) {
      const group = { title, blocks: [] };
      byTitle.set(title, group);
      groups.push(group);
    }
    byTitle.get(title).blocks.push({ ...block, short_label: short.charAt(0).toUpperCase() + short.slice(1) });
  }
  return groups;
}

router.get('/', (req, res) => {
  const pages = content.listPages().map((p) => ({ ...p, url: PAGE_URLS[p.page] || null, hint: PAGE_HINTS[p.page] || '' }));
  res.render(view('content/index'), { title: 'Страницы сайта', section: 'content', pages });
});

function renderPage(req, res, page, { status = 200, values = null, error = null } = {}) {
  const blocks = content.listBlocks(page).map((b) => (values && values[b.key] !== undefined ? { ...b, value: String(values[b.key]) } : b));
  if (!blocks.length) throw notFound('Страница');
  res.status(status).render(view('content/edit'), {
    title: content.PAGE_TITLES[page] || page,
    section: 'content',
    page,
    pageTitle: content.PAGE_TITLES[page] || page,
    pageUrl: PAGE_URLS[page] || null,
    hint: PAGE_HINTS[page] || '',
    groups: groupBlocks(blocks),
    total: blocks.length,
    error,
  });
}

router.get('/:page', (req, res) => {
  renderPage(req, res, String(req.params.page));
});

router.post('/:page', (req, res, next) => {
  const page = String(req.params.page);
  const existing = content.listBlocks(page);
  if (!existing.length) return next(notFound('Страница'));
  const submitted = req.body.blocks && typeof req.body.blocks === 'object' && !Array.isArray(req.body.blocks) ? req.body.blocks : {};
  // Only known keys of this page; everything else in the body is ignored.
  const values = {};
  for (const block of existing) {
    if (typeof submitted[block.key] === 'string') values[block.key] = submitted[block.key];
  }
  try {
    content.setBlocks(page, values);
  } catch (err) {
    if (isUserError(err)) return renderPage(req, res, page, { status: 422, values, error: err.message });
    return next(err);
  }
  req.flash('success', 'Изменения сохранены и уже видны на сайте');
  return res.redirect(`/admin/content/${page}`);
});

export default router;
