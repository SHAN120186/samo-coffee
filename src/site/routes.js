// SITE module: the public multi-page website, mounted at "/".
// Views live in src/site/views and are rendered as res.render('site/views/<name>').
// No SQL here — everything goes through the service layer. The router ends with its own 404 / error pages.
import { Router } from 'express';
import { config } from '../config.js';
import { clean, plural } from '../lib/escape.js';
import { formatSum } from '../lib/money.js';
import { RateLimiter } from '../lib/ratelimit.js';
import { AppError } from '../lib/errors.js';
import * as catalog from '../services/catalog.js';
import * as cartService from '../services/cart.js';
import * as orders from '../services/orders.js';
import * as subscriptions from '../services/subscriptions.js';
import * as postsService from '../services/posts.js';
import * as faqService from '../services/faq.js';
import * as feedback from '../services/feedback.js';
import * as analytics from '../services/analytics.js';
import * as customers from '../services/customers.js';
import { ensureSiteBlocks, pageContent } from './blocks.js';
import {
  icon, abs, metaText, telHref, accentTitle, periodLabel, paginate, withQuery, safeLocalPath, tastingNotes,
} from './helpers.js';

const router = Router();
const view = (name) => `site/views/${name}`;

/** Cache-busting stamp for /site/css and /site/js (static files are cached for days in production). */
const ASSET_VERSION = Date.now().toString(36);
const CATALOG_PER_PAGE = 12;
const BLOG_PER_PAGE = 9;

const NAV = [
  { href: '/catalog', label: 'Каталог' },
  { href: '/subscriptions', label: 'Подписка' },
  { href: '/about', label: 'О нас' },
  { href: '/blog', label: 'Журнал' },
  { href: '/delivery', label: 'Доставка' },
  { href: '/contacts', label: 'Контакты' },
];

const SORT_OPTIONS = [{ value: '', label: 'Сначала рекомендуемые' }, ...Object.entries(catalog.PRODUCT_SORTS).map(([value, label]) => ({ value, label }))];

// Extra editable blocks of the site (reviews, product page texts, …) — additive, never overwrites.
try {
  ensureSiteBlocks();
} catch (err) {
  console.error('[site] cannot register content blocks:', err.message);
}

const wantsJson = (req) => req.xhr || req.accepts(['html', 'json']) === 'json';

// ─────────────────────────────── shared locals

const FOREIGN_PATH = /^\/(api|admin|pay|bot|tma)(\/|$)/;

/** Layout data every site view needs (header, footer, helpers). Safe to call twice. */
function applySiteLocals(req, res) {
  if (res.locals.nav) return;
  const { botUrl } = res.locals.appConfig;
  Object.assign(res.locals, {
    g: pageContent('global'),
    nav: NAV,
    icon, abs, accentTitle, periodLabel, withQuery, telHref,
    formatPhone: customers.formatPhone,
    assetVersion: ASSET_VERSION,
    currentUrl: req.originalUrl,
    cartCount: cartService.countItems(cartService.siteCartRef(req, res)),
    /** "Open in Telegram" link — only when BOT_USERNAME is configured. */
    tgLink: botUrl ? `${botUrl}?start=site` : '',
    isActive: (href) => req.path === href || req.path.startsWith(`${href}/`),
    meta: {},
  });
}

router.use((req, res, next) => {
  if (FOREIGN_PATH.test(req.path)) return next();
  // One URL per page: "/catalog/" → "/catalog" (keeps the query string).
  if (req.method === 'GET' && req.path.length > 1 && req.path.endsWith('/')) {
    const query = req.originalUrl.slice(req.path.length);
    return res.redirect(301, `${req.path.replace(/\/+$/, '') || '/'}${query}`);
  }
  // Pages carry per-visitor data (cart counter, CSRF token): never store them in shared caches.
  res.set('Cache-Control', 'private, no-cache');
  applySiteLocals(req, res);
  return next();
});

/**
 * Rate limit that answers through the normal error flow: a branded page for form posts,
 * JSON ({ ok: false, error: 'rate_limited', message }) for fetch().
 */
function limit({ windowMs, max, message }) {
  const limiter = new RateLimiter({ windowMs, max });
  return (req, res, next) => {
    const result = limiter.hit(String(req.ip));
    if (result.allowed) return next();
    res.set('Retry-After', String(result.retryAfterSec));
    return next(new AppError('rate_limited', message, 429));
  };
}

/** Organization data for JSON-LD (home, contacts). */
function organizationLd(settings) {
  const sameAs = [settings.social_instagram, settings.social_telegram, settings.social_facebook, settings.social_youtube].filter(Boolean);
  return {
    '@context': 'https://schema.org',
    '@type': 'Store',
    name: settings.site_name,
    description: settings.seo_description,
    url: config.baseUrl,
    logo: abs('/img/logo.svg'),
    image: abs('/img/og.png'),
    telephone: settings.phone,
    email: settings.email,
    address: { '@type': 'PostalAddress', streetAddress: settings.address, addressLocality: 'Ташкент', addressCountry: 'UZ' },
    openingHours: settings.work_hours,
    priceRange: '$$',
    ...(sameAs.length ? { sameAs } : {}),
  };
}

const breadcrumbLd = (crumbs) => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.label, item: abs(c.href) })),
});

// ─────────────────────────────── home

router.get('/', (req, res) => {
  const c = pageContent('home');
  const { settings } = res.locals;
  const all = catalog.listProducts().items;
  const featuredAll = all.filter((p) => p.featured);
  const featured = [...featuredAll.filter((p) => p.in_stock), ...featuredAll.filter((p) => !p.in_stock), ...all.filter((p) => !p.featured)].slice(0, 4);
  res.render(view('home'), {
    c,
    featured,
    categories: catalog.listCategories().filter((cat) => cat.product_count > 0),
    plans: subscriptions.listPlans(),
    posts: postsService.listPosts({ limit: 3 }).items,
    notes: tastingNotes(all),
    reviews: [1, 2, 3].map((n) => ({ text: c[`review${n}_text`], author: c[`review${n}_author`], role: c[`review${n}_role`] })).filter((r) => r.text),
    meta: {
      title: c.seo_title || settings.seo_title,
      description: c.seo_description || settings.seo_description,
      jsonLd: [organizationLd(settings), { '@context': 'https://schema.org', '@type': 'WebSite', name: settings.site_name, url: config.baseUrl }],
    },
  });
});

// ─────────────────────────────── catalog

router.get('/catalog', (req, res) => {
  const c = pageContent('catalog');
  const categories = catalog.listCategories();
  const categorySlug = clean(req.query.category, 80);
  const category = categorySlug ? categories.find((cat) => cat.slug === categorySlug) : null;
  if (categorySlug && !category) return res.redirect('/catalog');

  const sort = Object.hasOwn(catalog.PRODUCT_SORTS, String(req.query.sort)) ? String(req.query.sort) : '';
  const q = clean(req.query.q, 80);
  const total = catalog.listProducts({ categorySlug: category?.slug, search: q }).total;
  const pager = paginate(total, req.query.page, CATALOG_PER_PAGE);
  const { items } = catalog.listProducts({
    categorySlug: category?.slug, search: q, sort: sort || undefined, limit: CATALOG_PER_PAGE, offset: pager.offset,
  });
  const params = { category: category?.slug, sort, q };
  const crumbs = [{ href: '/', label: 'Главная' }, { href: '/catalog', label: c.title || 'Каталог' }];
  if (category) crumbs.push({ href: withQuery('/catalog', { category: category.slug }), label: category.title });

  return res.render(view('catalog'), {
    c, categories, category, sort, q, products: items, total, pager,
    sortOptions: SORT_OPTIONS,
    allCount: categories.reduce((sum, cat) => sum + cat.product_count, 0),
    pageUrl: (page) => withQuery('/catalog', { ...params, page }),
    filterUrl: (slug) => withQuery('/catalog', { category: slug, sort, q }),
    resetUrl: withQuery('/catalog', { category: category?.slug, sort }),
    crumbs,
    meta: {
      title: category ? `${category.title} — ${c.title || 'Каталог'} · ${res.locals.settings.site_name}` : c.seo_title,
      description: category?.description || c.seo_description,
      canonical: abs(withQuery('/catalog', { category: category?.slug, page: pager.page })),
      noindex: Boolean(q),
      image: category?.image,
      jsonLd: [breadcrumbLd(crumbs)],
    },
  });
});

router.get('/catalog/:slug', (req, res, next) => {
  const product = catalog.getProductBySlug(req.params.slug);
  if (!product) return next();
  const c = pageContent('catalog');
  analytics.trackEventFromReq(req, 'view_product', { productId: product.id });

  const specs = [
    ['Обжарка', product.roast],
    ['Происхождение', product.origin],
    ['Обработка', product.process],
    ['Вес', product.weight_g ? (product.weight_g >= 1000 ? `${String(product.weight_g / 1000).replace('.', ',')} кг` : `${product.weight_g} г`) : ''],
    ...Object.entries(product.attributes || {}),
  ].filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '');

  const crumbs = [{ href: '/', label: 'Главная' }, { href: '/catalog', label: c.title || 'Каталог' }];
  if (product.category_slug) crumbs.push({ href: withQuery('/catalog', { category: product.category_slug }), label: product.category_title });
  crumbs.push({ href: product.url, label: product.title });

  const description = metaText(product.description || product.subtitle);
  const cart = cartService.getCart(cartService.siteCartRef(req, res));
  return res.render(view('product'), {
    c, product, specs, crumbs,
    related: catalog.relatedProducts(product, 4),
    inCart: cart.items.find((i) => i.product_id === product.id)?.qty || 0,
    maxQty: Math.max(1, Math.min(product.stock, cartService.MAX_QTY_PER_ITEM)),
    perks: [c.product_perk1, c.product_perk2, c.product_perk3].filter(Boolean),
    meta: {
      title: `${product.title} — ${formatSum(product.price)} · ${res.locals.settings.site_name}`,
      description,
      image: product.image,
      type: 'product',
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'Product',
          name: product.title,
          description,
          image: product.images.length ? product.images.map(abs) : [abs(product.image)],
          sku: `SC-${product.id}`,
          category: product.category_title || undefined,
          brand: { '@type': 'Brand', name: res.locals.settings.site_name },
          offers: {
            '@type': 'Offer',
            url: abs(product.url),
            price: product.price,
            priceCurrency: config.payments.currency,
            availability: product.in_stock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
            itemCondition: 'https://schema.org/NewCondition',
          },
        },
        breadcrumbLd(crumbs),
      ],
    },
  });
});

// ─────────────────────────────── cart

const cartLimiter = limit({ windowMs: 60_000, max: 120, message: 'Слишком много действий с корзиной. Попробуйте через минуту.' });

/** Cart view → JSON for the progressive-enhancement script (numbers + ready formatted strings). */
function cartPayload(cart) {
  return {
    count: cart.count,
    subtotal: cart.subtotal,
    delivery_fee: cart.delivery_fee,
    total: cart.total,
    free_delivery_left: cart.free_delivery_left,
    has_unavailable: cart.has_unavailable,
    items: cart.items.map((i) => ({
      product_id: i.product_id, qty: i.qty, stock: i.stock, available: i.available,
      line_total: i.line_total, line_total_text: formatSum(i.line_total),
    })),
    text: {
      count: `${cart.count} ${plural(cart.count, ['товар', 'товара', 'товаров'])}`,
      subtotal: formatSum(cart.subtotal),
      delivery: cart.delivery_fee ? formatSum(cart.delivery_fee) : 'Бесплатно',
      total: formatSum(cart.total),
      free_delivery_left: cart.free_delivery_left ? formatSum(cart.free_delivery_left) : '',
    },
  };
}

/** Uniform answer of a cart mutation: JSON for fetch(), flash + redirect for plain forms. */
function cartResponse(req, res, { cart, message = '', fallback = '/cart' }) {
  if (wantsJson(req)) return res.json({ ok: true, message, cart: cartPayload(cart) });
  if (message) req.flash('success', message);
  return res.redirect(303, safeLocalPath(req.body?.redirect, fallback));
}

function cartError(req, res, next, err, fallback = '/cart') {
  if (!err?.expose || !err.code) return next(err);
  if (wantsJson(req)) return res.status(err.status || 400).json({ ok: false, error: err.code, message: err.message });
  req.flash('error', err.message);
  return res.redirect(303, safeLocalPath(req.body?.redirect, fallback));
}

router.get('/cart', (req, res) => {
  const c = pageContent('cart');
  const cart = cartService.getCart(cartService.siteCartRef(req, res));
  const freeFrom = Number.parseInt(res.locals.settings.free_delivery_from, 10) || 0;
  res.set('Cache-Control', 'no-store');
  res.render(view('cart'), {
    c, cart, freeFrom,
    maxQty: cartService.MAX_QTY_PER_ITEM,
    suggestions: cart.items.length ? [] : catalog.listProducts({ featured: true, inStockOnly: true, limit: 4 }).items,
    meta: { title: `${c.title || 'Корзина'} · ${res.locals.settings.site_name}`, noindex: true },
  });
});

router.post('/cart/add', cartLimiter, (req, res, next) => {
  try {
    const productId = Number.parseInt(req.body?.product_id, 10);
    const qty = Math.min(Math.max(Number.parseInt(req.body?.qty, 10) || 1, 1), cartService.MAX_QTY_PER_ITEM);
    const ref = cartService.siteCartRef(req, res, { create: true });
    const cart = cartService.addItem(ref, productId, qty);
    const product = catalog.getProduct(productId);
    analytics.trackEventFromReq(req, 'add_to_cart', { productId, value: product?.price || 0, meta: { qty } });
    return cartResponse(req, res, { cart, message: `«${product?.title || 'Товар'}» — в корзине`, fallback: '/cart' });
  } catch (err) {
    return cartError(req, res, next, err, '/catalog');
  }
});

router.post('/cart/update', cartLimiter, (req, res, next) => {
  try {
    const ref = cartService.siteCartRef(req, res);
    const cart = cartService.setQty(ref, Number.parseInt(req.body?.product_id, 10), Number.parseInt(req.body?.qty, 10) || 0);
    return cartResponse(req, res, { cart });
  } catch (err) {
    return cartError(req, res, next, err);
  }
});

router.post('/cart/remove', cartLimiter, (req, res, next) => {
  try {
    const ref = cartService.siteCartRef(req, res);
    const cart = cartService.removeItem(ref, Number.parseInt(req.body?.product_id, 10));
    return cartResponse(req, res, { cart, message: 'Товар убран из корзины' });
  } catch (err) {
    return cartError(req, res, next, err);
  }
});

router.post('/cart/clear', cartLimiter, (req, res, next) => {
  try {
    const cart = cartService.clearCart(cartService.siteCartRef(req, res));
    return cartResponse(req, res, { cart: { ...cart, items: [] }, message: 'Корзина очищена' });
  } catch (err) {
    return cartError(req, res, next, err);
  }
});

// ─────────────────────────────── checkout

const checkoutLimiter = limit({ windowMs: 10 * 60_000, max: 20, message: 'Слишком много попыток оформления. Попробуйте через несколько минут.' });

function checkoutValues(body = {}) {
  return {
    name: clean(body.name, 120),
    phone: clean(body.phone, 40),
    email: clean(body.email, 160),
    method: body.method === 'pickup' ? 'pickup' : 'courier',
    address: clean(body.address, 300),
    comment: clean(body.comment, 1000),
  };
}

function renderCheckout(req, res, { cart, values, errors = {}, status = 200 }) {
  const c = pageContent('checkout');
  res.set('Cache-Control', 'no-store');
  res.status(status).render(view('checkout'), {
    c, cart, values, errors,
    courierFee: cartService.calcDelivery(cart.subtotal, 'courier'),
    meta: { title: `${c.title || 'Оформление заказа'} · ${res.locals.settings.site_name}`, noindex: true },
  });
}

router.get('/checkout', (req, res) => {
  const cart = cartService.getCart(cartService.siteCartRef(req, res));
  if (!cart.items.length) return res.redirect('/cart');
  if (cart.has_unavailable) {
    req.flash('error', 'Часть товаров закончилась — проверьте количество в корзине.');
    return res.redirect('/cart');
  }
  analytics.trackEventFromReq(req, 'begin_checkout', { value: cart.subtotal, meta: { items: cart.count } });
  return renderCheckout(req, res, { cart, values: checkoutValues() });
});

router.post('/checkout', checkoutLimiter, (req, res, next) => {
  const ref = cartService.siteCartRef(req, res);
  const values = checkoutValues(req.body);
  try {
    const order = orders.createFromCart(ref, {
      customer: { name: values.name, phone: values.phone, email: values.email },
      delivery: { method: values.method, address: values.address },
      comment: values.comment,
      channel: 'site',
      sessionId: req.sessionId,
      source: req.traffic?.source,
    });
    // /pay/order/:token starts the payment with the active provider and redirects to its page.
    return res.redirect(303, order.pay_url);
  } catch (err) {
    if (err?.code === 'validation') {
      const cart = cartService.getCart(ref);
      if (!cart.items.length) return res.redirect('/cart');
      return renderCheckout(req, res, { cart, values, errors: err.details?.fields || { form: err.message }, status: 422 });
    }
    if (err?.code === 'empty_cart' || err?.code === 'out_of_stock') {
      req.flash('error', err.message);
      return res.redirect(303, '/cart');
    }
    return next(err);
  }
});

// ─────────────────────────────── order status (payment return URL)

/** Which copy / illustration the status page shows. */
function orderState(order) {
  if (order.status === 'cancelled') return 'cancelled';
  if (order.status === 'refunded') return 'refunded';
  if (order.is_paid) return ['processing', 'shipped', 'delivered'].includes(order.status) ? order.status : 'paid';
  if (order.payment_status === 'failed') return 'failed';
  return 'pending';
}

function orderSteps(order) {
  if (['cancelled', 'refunded'].includes(order.status)) return [];
  if (order.kind === 'subscription') {
    const done = order.is_paid ? 3 : 1;
    return ['Заявка принята', 'Оплата', 'Подписка активна'].map((label, i) => ({ label, done: i < done, current: i === done }));
  }
  const index = { new: 0, pending_payment: 0, paid: 1, processing: 2, shipped: 3, delivered: 4 }[order.status] ?? 0;
  const pickup = order.delivery_method === 'pickup';
  const labels = ['Оформлен', 'Оплата', 'Сборка', pickup ? 'Готов к выдаче' : 'В пути', pickup ? 'Получен' : 'Доставлен'];
  return labels.map((label, i) => ({ label, done: i <= index, current: i === index + 1 }));
}

router.get('/order/:token/status', (req, res, next) => {
  const order = orders.getOrderByToken(req.params.token);
  if (!order) return next();
  res.set('Cache-Control', 'no-store');
  return res.json({ ok: true, status: order.status, payment_status: order.payment_status, state: orderState(order) });
});

router.get('/order/:token', (req, res, next) => {
  const order = orders.getOrderByToken(req.params.token);
  if (!order) return next();
  const c = pageContent('order');
  const state = orderState(order);
  const subscription = order.kind === 'subscription' && order.is_paid && order.customer_id
    ? subscriptions.getCurrentForCustomer(order.customer_id)
    : null;
  let text = c[`${state}_text`] ?? '';
  if (state === 'paid' && order.kind === 'subscription' && c.subscription_paid_text) text = c.subscription_paid_text;
  res.set('Cache-Control', 'no-store');
  const { botUrl } = res.locals.appConfig;
  return res.render(view('order'), {
    c, order, state, subscription,
    title: c[`${state}_title`] || order.status_label,
    text,
    steps: orderSteps(order),
    tgOrderLink: botUrl ? `${botUrl}?start=order_${order.number.replace(/[^A-Za-z0-9_-]/g, '')}` : '',
    meta: { title: `Заказ ${order.number} · ${res.locals.settings.site_name}`, noindex: true },
  });
});

// ─────────────────────────────── subscriptions

router.get('/subscriptions', (req, res) => {
  const c = pageContent('subscriptions');
  const plans = subscriptions.listPlans();
  const faq = faqService.listFaq().filter((item) => /подписк/i.test(item.topic));
  res.render(view('subscriptions'), {
    c, plans, faq,
    steps: [1, 2, 3].map((n) => ({ title: c[`step${n}_title`], text: c[`step${n}_text`] })).filter((s) => s.title),
    meta: {
      title: c.seo_title,
      description: c.seo_description,
      image: c.image,
      jsonLd: plans.length ? [{
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        itemListElement: plans.map((p, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          item: {
            '@type': 'Product',
            name: `Подписка «${p.title}»`,
            description: p.description,
            image: abs(p.image),
            offers: { '@type': 'Offer', price: p.price, priceCurrency: config.payments.currency, url: abs(`/subscriptions/${p.slug}`), availability: 'https://schema.org/InStock' },
          },
        })),
      }] : [],
    },
  });
});

function loadPlan(req) {
  const plan = subscriptions.getPlanBySlug(req.params.slug);
  return plan && plan.active ? plan : null;
}

function renderSubscribe(req, res, { plan, values, errors = {}, status = 200 }) {
  const c = pageContent('subscriptions');
  res.set('Cache-Control', 'no-store');
  res.status(status).render(view('subscribe'), {
    c, plan, values, errors,
    agreement: pageContent('checkout').agreement,
    meta: { title: `${c.checkout_title || 'Оформление подписки'}: ${plan.title} · ${res.locals.settings.site_name}`, noindex: true },
  });
}

router.get('/subscriptions/:slug', (req, res, next) => {
  const plan = loadPlan(req);
  if (!plan) return next();
  analytics.trackEventFromReq(req, 'begin_checkout', { value: plan.price, meta: { kind: 'subscription', plan: plan.slug } });
  return renderSubscribe(req, res, { plan, values: checkoutValues() });
});

router.post('/subscriptions/:slug', checkoutLimiter, (req, res, next) => {
  const plan = loadPlan(req);
  if (!plan) return next();
  const values = checkoutValues({ ...req.body, method: 'courier' });
  try {
    const order = orders.createSubscriptionOrder({
      planId: plan.id,
      customer: { name: values.name, phone: values.phone, email: values.email },
      delivery: { method: 'courier', address: values.address },
      comment: values.comment,
      channel: 'site',
      sessionId: req.sessionId,
      source: req.traffic?.source,
    });
    return res.redirect(303, order.pay_url);
  } catch (err) {
    if (err?.code === 'validation') {
      return renderSubscribe(req, res, { plan, values, errors: err.details?.fields || { form: err.message }, status: 422 });
    }
    return next(err);
  }
});

// ─────────────────────────────── content pages

router.get('/about', (req, res) => {
  const c = pageContent('about');
  res.render(view('about'), {
    c,
    facts: [1, 2, 3].map((n) => ({ value: c[`fact${n}_value`], label: c[`fact${n}_label`] })).filter((f) => f.value),
    meta: { title: c.seo_title, description: c.seo_description, image: c.image },
  });
});

router.get('/delivery', (req, res) => {
  const c = pageContent('delivery');
  const { settings } = res.locals;
  const fee = Number.parseInt(settings.delivery_fee, 10) || 0;
  const freeFrom = Number.parseInt(settings.free_delivery_from, 10) || 0;
  res.render(view('delivery'), {
    c,
    pageFaq: pageContent('faq'),
    cards: [
      { icon: 'truck', label: c.card1_label, value: fee ? formatSum(fee) : 'Бесплатно', note: settings.delivery_note },
      freeFrom ? { icon: 'box', label: c.card2_label, value: formatSum(freeFrom), note: 'Доставим без доплаты в день заказа' } : null,
      { icon: 'pin', label: c.card3_label, value: c.card3_value || 'Бесплатно', note: settings.pickup_address },
    ].filter((card) => card && card.label),
    meta: { title: c.seo_title, description: c.seo_description, image: c.image },
  });
});

router.get('/faq', (req, res) => {
  const c = pageContent('faq');
  const groups = faqService.listFaqGrouped();
  const all = groups.flatMap((group) => group.items);
  res.render(view('faq'), {
    c, groups,
    meta: {
      title: c.seo_title,
      description: c.seo_description,
      jsonLd: all.length ? [{
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: all.map((item) => ({
          '@type': 'Question',
          name: item.question,
          acceptedAnswer: { '@type': 'Answer', text: metaText(item.answer, 1000) },
        })),
      }] : [],
    },
  });
});

// ─────────────────────────────── blog

router.get('/blog', (req, res) => {
  const c = pageContent('blog');
  const total = postsService.listPosts({ limit: 1 }).total;
  const pager = paginate(total, req.query.page, BLOG_PER_PAGE);
  const { items } = postsService.listPosts({ limit: BLOG_PER_PAGE, offset: pager.offset });
  res.render(view('blog'), {
    c, posts: items, pager,
    pageUrl: (page) => withQuery('/blog', { page }),
    meta: { title: c.seo_title, description: c.seo_description, canonical: abs(withQuery('/blog', { page: pager.page })) },
  });
});

router.get('/blog/:slug', (req, res, next) => {
  const post = postsService.getPostBySlug(req.params.slug);
  if (!post) return next();
  const c = pageContent('blog');
  const more = postsService.listPosts({ limit: 4 }).items.filter((p) => p.id !== post.id).slice(0, 3);
  const crumbs = [{ href: '/', label: 'Главная' }, { href: '/blog', label: c.title || 'Блог' }, { href: post.url, label: post.title }];
  const published = post.published_at || post.created_at;
  return res.render(view('post'), {
    c, post, more, crumbs, published,
    meta: {
      title: `${post.title} · ${res.locals.settings.site_name}`,
      description: metaText(post.excerpt || post.body_html),
      image: post.cover,
      type: 'article',
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'Article',
          headline: post.title,
          description: metaText(post.excerpt || post.body_html),
          image: [abs(post.cover)],
          datePublished: published,
          dateModified: post.updated_at || published,
          author: post.author ? { '@type': 'Person', name: post.author } : { '@type': 'Organization', name: res.locals.settings.site_name },
          publisher: { '@type': 'Organization', name: res.locals.settings.site_name, logo: { '@type': 'ImageObject', url: abs('/img/logo.svg') } },
          mainEntityOfPage: abs(post.url),
        },
        breadcrumbLd(crumbs),
      ],
    },
  });
});

// ─────────────────────────────── contacts + feedback form

const feedbackLimiter = limit({ windowMs: 10 * 60_000, max: 5, message: 'Вы отправили слишком много сообщений. Попробуйте через несколько минут или позвоните нам.' });

function renderContacts(req, res, { values = {}, errors = {}, status = 200 } = {}) {
  const c = pageContent('contacts');
  const { settings } = res.locals;
  const socials = [
    { name: 'Telegram', icon: 'telegram', url: settings.social_telegram },
    { name: 'Instagram', icon: 'instagram', url: settings.social_instagram },
    { name: 'Facebook', icon: 'facebook', url: settings.social_facebook },
    { name: 'YouTube', icon: 'youtube', url: settings.social_youtube },
  ].filter((s) => s.url);
  res.status(status).render(view('contacts'), {
    c, socials, errors,
    values: { name: '', contact: '', subject: '', message: '', ...values },
    meta: { title: c.seo_title, description: c.seo_description, image: c.image, jsonLd: [organizationLd(settings)] },
  });
}

router.get('/contacts', (req, res) => renderContacts(req, res));

router.post('/contacts', feedbackLimiter, async (req, res, next) => {
  try {
    const c = pageContent('contacts');
    const done = () => {
      req.flash('success', c.form_success || 'Спасибо! Сообщение отправлено.');
      return res.redirect(303, '/contacts#form');
    };
    // Honeypot: real visitors never see this field (and autofill ignores its name). Pretend success, store nothing.
    if (clean(req.body?.extra_info, 200)) return done();

    const values = {
      name: clean(req.body?.name, 120),
      contact: clean(req.body?.contact, 160),
      subject: clean(req.body?.subject, 200),
      message: clean(req.body?.message, feedback.MAX_MESSAGE_LENGTH),
    };
    const errors = {};
    if (values.name.length < 2) errors.name = 'Представьтесь, пожалуйста';
    const isContact = customers.isEmail(values.contact) || Boolean(customers.normalizePhone(values.contact)) || /^@[A-Za-z0-9_]{4,32}$/.test(values.contact);
    if (!isContact) errors.contact = 'Укажите телефон, e-mail или @username в Telegram';
    if (values.message.length < 5) errors.message = 'Напишите сообщение чуть подробнее';
    if (Object.keys(errors).length) return renderContacts(req, res, { values, errors, status: 422 });

    await feedback.createThread({
      channel: 'site', text: values.message, name: values.name, contact: values.contact, subject: values.subject, sessionId: req.sessionId,
    });
    return done();
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────── robots.txt + sitemap.xml

router.get('/robots.txt', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('text/plain').send([
    'User-agent: *',
    'Disallow: /admin',
    'Disallow: /api/',
    'Disallow: /pay/',
    'Disallow: /tma/',
    'Disallow: /cart',
    'Disallow: /checkout',
    'Disallow: /order/',
    'Disallow: /subscriptions/*',
    'Disallow: /*?q=',
    '',
    `Sitemap: ${config.baseUrl}/sitemap.xml`,
    '',
  ].join('\n'));
});

router.get('/sitemap.xml', (req, res) => {
  const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const day = (value) => (value ? String(value).slice(0, 10) : '');
  const urls = [
    { loc: '/', priority: '1.0', changefreq: 'daily' },
    { loc: '/catalog', priority: '0.9', changefreq: 'daily' },
    { loc: '/subscriptions', priority: '0.8', changefreq: 'weekly' },
    { loc: '/about', priority: '0.6', changefreq: 'monthly' },
    { loc: '/blog', priority: '0.7', changefreq: 'weekly' },
    { loc: '/delivery', priority: '0.6', changefreq: 'monthly' },
    { loc: '/faq', priority: '0.6', changefreq: 'monthly' },
    { loc: '/contacts', priority: '0.6', changefreq: 'monthly' },
    ...catalog.listCategories().filter((cat) => cat.product_count > 0)
      .map((cat) => ({ loc: withQuery('/catalog', { category: cat.slug }), priority: '0.7', changefreq: 'weekly' })),
    ...catalog.listProducts().items.map((p) => ({ loc: p.url, lastmod: day(p.updated_at), priority: '0.8', changefreq: 'weekly' })),
    ...postsService.listPosts({ limit: 500 }).items.map((p) => ({ loc: p.url, lastmod: day(p.updated_at || p.published_at), priority: '0.5', changefreq: 'monthly' })),
  ];
  const body = urls.map((u) => [
    '  <url>',
    `    <loc>${xml(abs(u.loc))}</loc>`,
    u.lastmod ? `    <lastmod>${xml(u.lastmod)}</lastmod>` : null,
    `    <changefreq>${u.changefreq}</changefreq>`,
    `    <priority>${u.priority}</priority>`,
    '  </url>',
  ].filter(Boolean).join('\n')).join('\n');
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`);
});

// ─────────────────────────────── 404 + errors

function renderNotFound(req, res) {
  const c = pageContent('notfound');
  res.status(404).render(view('404'), {
    c,
    suggestions: catalog.listProducts({ featured: true, inStockOnly: true, limit: 4 }).items,
    meta: { title: `${c.title || 'Страница не найдена'} · ${res.locals.settings.site_name}`, noindex: true },
  });
}

router.use((req, res, next) => {
  // API clients and other modules' paths get the JSON / plain fallbacks of app.js.
  if (wantsJson(req) || FOREIGN_PATH.test(req.path)) return next();
  return renderNotFound(req, res);
});

/**
 * Branded error page of the site. Mounted twice: at the end of this router, and by app.js as an
 * app-level handler for errors raised BEFORE the router is reached (e.g. a failed CSRF check).
 */
// eslint-disable-next-line no-unused-vars
export function siteErrorHandler(err, req, res, next) {
  if (res.headersSent || wantsJson(req) || FOREIGN_PATH.test(req.path)) return next(err);
  const status = Number(err.status || err.statusCode) || 500;
  try {
    applySiteLocals(req, res);
    res.set('Cache-Control', 'no-store');
    if (status === 404) return renderNotFound(req, res);
    if (status >= 500) console.error(`[site] ${req.method} ${req.originalUrl}`, err);
    const c = pageContent('notfound');
    const exposed = (Boolean(err.expose) || (status >= 400 && status < 500)) && err.message;
    return res.status(status).render(view('error'), {
      c, status,
      title: status >= 500 ? (c.error_title || 'Что-то пошло не так') : status === 429 ? 'Слишком часто' : 'Не получилось',
      text: exposed ? err.message : (c.error_text || 'Попробуйте обновить страницу через минуту.'),
      meta: { title: `Ошибка ${status} · ${res.locals.settings.site_name}`, noindex: true },
    });
  } catch (renderError) {
    console.error('[site] error page failed:', renderError);
    return next(err);
  }
}

router.use(siteErrorHandler);

export default router;
