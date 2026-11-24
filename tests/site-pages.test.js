import './helpers/env.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/http.js';
import { seed } from '../src/db/seed.js';
import { get, all } from '../src/db/index.js';
import * as content from '../src/services/content.js';
import * as settings from '../src/services/settings.js';
import * as catalog from '../src/services/catalog.js';
import * as postsService from '../src/services/posts.js';
import { SITE_BLOCKS, ensureSiteBlocks, pageContent } from '../src/site/blocks.js';
import { accentTitle, paginate, safeLocalPath, withQuery, tastingNotes, periodLabel } from '../src/site/helpers.js';

let t;
before(async () => {
  seed({ quiet: true });
  t = await startTestApp();
});
after(async () => {
  await t.close();
});

const count = (sql, ...params) => get(sql, ...params).n;
const jsonLd = (html) => [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

test('every public page renders with the shared layout', async () => {
  const product = catalog.listProducts({ limit: 1 }).items[0];
  const post = postsService.listPosts({ limit: 1 }).items[0];
  const pages = [
    ['/', content.get('home', 'featured_title')],
    ['/catalog', product.title],
    [product.url, product.title],
    ['/subscriptions', 'Для двоих'],
    ['/subscriptions/duo', 'Перейти к оплате'],
    ['/about', content.get('about', 'quote_author')],
    ['/blog', post.title],
    [post.url, post.title],
    ['/delivery', content.get('delivery', 'title')],
    ['/faq', 'Насколько свежий кофе вы привозите?'],
    ['/contacts', content.get('contacts', 'form_title')],
    ['/cart', content.get('cart', 'empty_title')],
  ];
  for (const [path, expected] of pages) {
    const res = await t.client.get(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), /text\/html/, path);
    assert.ok(res.text.includes(expected.replace(/&/g, '&amp;')), `${path} shows «${expected}»`);
    assert.match(res.text, /<html lang="ru">/, path);
    assert.match(res.text, /<header class="header"/, `${path}: header`);
    assert.match(res.text, /<footer class="footer"/, `${path}: footer`);
    assert.match(res.text, /data-cart-count/, `${path}: cart counter`);
    assert.match(res.text, /<main id="main">/, `${path}: main landmark`);
    assert.equal((res.text.match(/<h1[\s>]/g) || []).length, 1, `${path}: exactly one h1`);
    assert.ok(!/<script(?![^>]*\b(nonce|src)=)[^>]*>/.test(res.text), `${path}: no inline script without a nonce`);
    assert.ok(!res.text.includes('undefined'), `${path}: no "undefined" in the markup`);
  }
});

test('texts and images come from content blocks and settings', async () => {
  content.setBlock('home', 'hero_title', 'Тестовый заголовок <b>героя</b>');
  content.setBlock('home', 'hero_image', '/img/story.svg');
  content.setBlock('global', 'announcement', 'Только сегодня: дегустация');
  settings.set('phone', '+998 71 000 11 22');
  try {
    const home = await t.client.get('/');
    assert.ok(home.text.includes('Тестовый заголовок &lt;b&gt;'), 'block text is escaped');
    assert.ok(!home.text.includes('<b>героя</b>'));
    assert.match(home.text, /class="hero__img" src="\/img\/story\.svg"/);
    assert.ok(home.text.includes('Только сегодня: дегустация'));
    assert.ok(home.text.includes('+998 71 000 11 22'));
    assert.ok(home.text.includes('href="tel:+998710001122"'));

    content.setBlock('global', 'announcement', '');
    assert.ok(!(await t.client.get('/')).text.includes('class="announce"'), 'an emptied block hides its element');
  } finally {
    content.setBlock('home', 'hero_title', 'Кофе, который обжарили для вас на этой неделе');
    content.setBlock('home', 'hero_image', '/img/hero.svg');
    content.setBlock('global', 'announcement', 'Бесплатная доставка по Ташкенту при заказе от 300 000 сум');
    settings.set('phone', '+998 71 200 45 45');
  }
});

test('site content blocks are registered additively and are editable', async () => {
  ensureSiteBlocks();
  const keys = new Set(content.listBlocks('home').map((b) => b.key));
  for (const key of ['review1_text', 'review2_author', 'hero_badge_text', 'blog_cta_text']) assert.ok(keys.has(key), key);
  assert.equal(count('SELECT COUNT(*) AS n FROM content_blocks WHERE sort >= 1000'), SITE_BLOCKS.length);
  assert.equal(ensureSiteBlocks(), 0, 'second call inserts nothing');

  content.setBlock('home', 'review1_text', 'Отредактированный отзыв');
  ensureSiteBlocks();
  assert.equal(pageContent('home').review1_text, 'Отредактированный отзыв', 'edited values are never overwritten');
  assert.ok((await t.client.get('/')).text.includes('Отредактированный отзыв'));

  // every block key is unique per page and does not shadow a foundation default
  const defaults = new Set(content.DEFAULT_BLOCKS.map((b) => `${b.page}.${b.key}`));
  const seen = new Set();
  for (const b of SITE_BLOCKS) {
    const id = `${b.page}.${b.key}`;
    assert.ok(!defaults.has(id), `${id} duplicates a foundation block`);
    assert.ok(!seen.has(id), `${id} is declared twice`);
    assert.ok(content.PAGE_TITLES[b.page], `${id}: page has a title in the admin`);
    seen.add(id);
  }
});

test('SEO: meta tags, Open Graph, canonical, JSON-LD', async () => {
  const product = catalog.getProductBySlug('ethiopia-yirgacheffe');
  const page = await t.client.get(product.url);
  assert.match(page.text, /<title>Эфиопия Иргачефф — 149 000 сум · Samo Coffee<\/title>/);
  assert.match(page.text, /<meta name="description" content="[^"]{40,}">/);
  assert.match(page.text, /<link rel="canonical" href="http:\/\/localhost:3000\/catalog\/ethiopia-yirgacheffe">/);
  assert.match(page.text, /<meta property="og:type" content="product">/);
  assert.match(page.text, /<meta property="og:image" content="http:\/\/localhost:3000\/img\/products\/ethiopia-yirgacheffe\.svg">/);
  const ld = jsonLd(page.text);
  const productLd = ld.find((x) => x['@type'] === 'Product');
  assert.equal(productLd.name, product.title);
  assert.equal(productLd.offers.price, 149000);
  assert.equal(productLd.offers.priceCurrency, 'UZS');
  assert.equal(productLd.offers.availability, 'https://schema.org/InStock');
  assert.equal(ld.find((x) => x['@type'] === 'BreadcrumbList').itemListElement.length, 4);

  const out = jsonLd((await t.client.get('/catalog/rwanda-nyamasheke')).text).find((x) => x['@type'] === 'Product');
  assert.equal(out.offers.availability, 'https://schema.org/OutOfStock');

  const home = await t.client.get('/');
  assert.ok(jsonLd(home.text).some((x) => x['@type'] === 'Store' && x.telephone));
  assert.match(home.text, /<link rel="canonical" href="http:\/\/localhost:3000">/);

  const post = postsService.listPosts({ limit: 1 }).items[0];
  const article = jsonLd((await t.client.get(post.url)).text).find((x) => x['@type'] === 'Article');
  assert.equal(article.headline, post.title);
  assert.ok(jsonLd((await t.client.get('/faq')).text).find((x) => x['@type'] === 'FAQPage').mainEntity.length >= 5);

  for (const path of ['/cart', '/subscriptions/duo', '/catalog?q=кофе']) {
    assert.match((await t.client.get(path)).text, /<meta name="robots" content="noindex, nofollow">/, path);
  }
});

test('robots.txt and sitemap.xml', async () => {
  const robots = await t.client.get('/robots.txt');
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get('content-type'), /text\/plain/);
  assert.match(robots.text, /Disallow: \/admin/);
  assert.match(robots.text, /Sitemap: http:\/\/localhost:3000\/sitemap\.xml/);

  const sitemap = await t.client.get('/sitemap.xml');
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.headers.get('content-type'), /xml/);
  const locs = [...sitemap.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  for (const path of ['', '/catalog', '/subscriptions', '/about', '/blog', '/delivery', '/faq', '/contacts', '/catalog/kenya-nyeri', '/blog/kold-bryu-doma']) {
    assert.ok(locs.includes(`http://localhost:3000${path}`) || (path === '' && locs.includes('http://localhost:3000/')), `sitemap has ${path || '/'}`);
  }
  assert.ok(locs.includes('http://localhost:3000/catalog?category=filter'));
  assert.ok(!locs.some((l) => /\/(cart|checkout|order|admin)/.test(l)));
  assert.equal(new Set(locs).size, locs.length, 'no duplicates');
});

test('catalog: category filter, search, sort, pagination', async () => {
  const cards = (html) => [...html.matchAll(/class="pcard__link" href="\/catalog\/([^"]+)"/g)].map((m) => m[1]);

  const all12 = await t.client.get('/catalog');
  assert.equal(cards(all12.text).length, 12);
  assert.ok(!all12.text.includes('class="pager"'), 'one page → no pagination');

  const filter = await t.client.get('/catalog?category=drip');
  assert.deepEqual(cards(filter.text).sort(), ['drip-assorted', 'drip-ethiopia']);
  assert.match(filter.text, /<h1 class="page-hero__title">Дрип-пакеты<\/h1>/);

  const search = await t.client.get(`/catalog?q=${encodeURIComponent('ЭФИОПИЯ')}`);
  const found = cards(search.text);
  assert.ok(found.includes('ethiopia-yirgacheffe') && found.includes('drip-ethiopia'), 'case-insensitive Cyrillic search');
  assert.ok(!found.includes('brazil-cerrado'));

  const nothing = await t.client.get('/catalog?q=zzzzzz');
  assert.equal(cards(nothing.text).length, 0);
  assert.ok(nothing.text.includes(content.get('catalog', 'empty_text')));

  const asc = cards((await t.client.get('/catalog?sort=price_asc')).text).map((slug) => catalog.getProductBySlug(slug).price);
  assert.deepEqual(asc, [...asc].sort((a, b) => a - b));
  const desc = cards((await t.client.get('/catalog?sort=price_desc&category=filter')).text).map((slug) => catalog.getProductBySlug(slug).price);
  assert.deepEqual(desc, [...desc].sort((a, b) => b - a));

  const unknown = await t.client.get('/catalog?category=nope');
  assert.equal(unknown.status, 302);
  assert.equal(unknown.location, '/catalog');

  // XSS: the query is reflected escaped
  const xss = await t.client.get(`/catalog?q=${encodeURIComponent('"><script>alert(1)</script>')}`);
  assert.ok(!xss.text.includes('<script>alert(1)</script>'));

  // 5 more products → 17 → two pages
  const category = catalog.listCategories()[0];
  const extra = Array.from({ length: 5 }, (_, i) => catalog.createProduct({ title: `Пагинация ${i + 1}`, price: 50000 + i, stock: 3, category_id: category.id, sort: 100 + i }));
  try {
    const first = await t.client.get('/catalog');
    assert.equal(cards(first.text).length, 12);
    assert.match(first.text, /class="pager"/);
    assert.match(first.text, /href="\/catalog\?page=2"/);
    const second = await t.client.get('/catalog?page=2&sort=');
    assert.equal(cards(second.text).length, 5);
    assert.match(second.text, /<link rel="canonical" href="http:\/\/localhost:3000\/catalog\?page=2">/);
    assert.equal(cards((await t.client.get('/catalog?page=99')).text).length, 5, 'out-of-range page is clamped');
  } finally {
    extra.forEach((p) => catalog.deleteProduct(p.id));
  }
});

test('product page: tracking, stock states, hidden products', async () => {
  const product = catalog.getProductBySlug('kenya-nyeri');
  const c = t.newClient();
  const before = count(`SELECT COUNT(*) AS n FROM events WHERE name = 'view_product' AND product_id = ?`, product.id);
  const page = await c.get(product.url);
  assert.equal(page.status, 200);
  assert.equal(count(`SELECT COUNT(*) AS n FROM events WHERE name = 'view_product' AND product_id = ?`, product.id), before + 1);
  assert.match(page.text, /data-testid="add-to-cart"/);
  assert.ok(page.text.includes(`Осталось ${product.stock} шт.`), 'low stock warning');
  assert.ok(page.text.includes(`max="${product.stock}"`), 'quantity is limited by stock');
  for (const value of Object.values(product.attributes)) assert.ok(page.text.includes(value), `attribute ${value}`);

  await c.get(product.url, { headers: { 'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' } });
  assert.equal(count(`SELECT COUNT(*) AS n FROM events WHERE name = 'view_product' AND product_id = ?`, product.id), before + 1, 'crawlers are not tracked');

  const out = await c.get('/catalog/rwanda-nyamasheke');
  assert.equal(out.status, 200);
  assert.ok(!out.text.includes('data-testid="add-to-cart"'));
  assert.ok(out.text.includes('Нет в наличии'));

  catalog.updateProduct(product.id, { active: 0 });
  try {
    assert.equal((await c.get(product.url)).status, 404);
    assert.ok(!(await c.get('/catalog')).text.includes(product.title));
  } finally {
    catalog.updateProduct(product.id, { active: 1 });
  }
  assert.equal((await c.get('/catalog/no-such-product')).status, 404);
  assert.equal((await c.get('/blog/no-such-post')).status, 404);
  assert.equal((await c.get('/subscriptions/no-such-plan')).status, 404);
});

test('404 page is branded; API paths keep their JSON answers', async () => {
  const page = await t.client.get('/no-such-page');
  assert.equal(page.status, 404);
  assert.ok(page.text.includes(content.get('notfound', 'title')));
  assert.match(page.text, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(page.text, /<header class="header"/);

  const api = await t.client.get('/api/tma/nope');
  assert.equal(api.status, 404);
  assert.equal(api.json().error, 'not_found');
  const json = await t.client.get('/no-such-page', { headers: { accept: 'application/json' } });
  assert.equal(json.status, 404);
  assert.equal(json.json().ok, false);
  const views = count(`SELECT COUNT(*) AS n FROM page_views WHERE path = '/no-such-page'`);
  assert.equal(views, 0, '404s are not counted as page views');
});

test('routing hygiene: trailing slashes, cache headers, branded error pages', async () => {
  const slash = await t.client.get('/catalog/?category=drip');
  assert.equal(slash.status, 301);
  assert.equal(slash.location, '/catalog?category=drip');
  assert.equal((await t.client.get('/about/')).location, '/about');
  assert.notEqual((await t.client.get('/tma/')).status, 301, 'other modules are left alone');

  assert.equal((await t.client.get('/')).headers.get('cache-control'), 'private, no-cache');
  assert.match((await t.client.get('/sitemap.xml')).headers.get('cache-control'), /public/);

  // a stale / missing CSRF token → 403 with a human explanation (JSON for fetch)
  const c = t.newClient();
  const stale = await c.request('POST', '/cart/add', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'product_id=1' });
  assert.equal(stale.status, 403);
  assert.ok(stale.text.includes('Сессия формы устарела'));
  const staleJson = await c.request('POST', '/cart/add', { headers: { 'content-type': 'application/json', accept: 'application/json' }, body: '{"product_id":1}' });
  assert.equal(staleJson.status, 403);
  assert.equal(staleJson.json().ok, false);
});

test('"Open in Telegram" is hidden while BOT_USERNAME is not configured', async () => {
  for (const path of ['/', '/contacts']) {
    const page = await t.client.get(path);
    assert.ok(!page.text.includes('data-testid="open-telegram"'), path);
    assert.ok(!page.text.includes('?start=site'), path);
  }
});

test('contacts form: CSRF, validation, honeypot, feedback thread, rate limit', async () => {
  const c = t.newClient();
  const threads = () => count(`SELECT COUNT(*) AS n FROM feedback_threads WHERE channel = 'site'`);
  const start = threads();

  const noToken = await c.request('POST', '/contacts', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=A&contact=b&message=hello' });
  assert.equal(noToken.status, 403);

  await c.get('/contacts');
  const invalid = await c.postForm('/contacts', { name: 'Я', contact: 'не контакт', message: 'эй' });
  assert.equal(invalid.status, 422);
  assert.ok(invalid.text.includes('Представьтесь, пожалуйста'));
  assert.ok(invalid.text.includes('Укажите телефон, e-mail или @username в Telegram'));
  assert.ok(invalid.text.includes('Напишите сообщение чуть подробнее'));
  assert.ok(invalid.text.includes('value="не контакт"'), 'entered values are kept');
  assert.equal(threads(), start);

  const bot = await c.postForm('/contacts', { name: 'Spam Bot', contact: 'spam@example.com', message: 'Buy cheap coffee now', extra_info: 'http://spam.example' });
  assert.equal(bot.status, 303);
  assert.equal(threads(), start, 'honeypot submissions are dropped silently');
  await c.get('/contacts'); // consume the flash

  const ok = await c.postForm('/contacts', { name: 'Дильноза', contact: '+998 90 111 22 33', subject: 'Опт', message: 'Здравствуйте! Нужно 10 кг эспрессо-смеси в месяц.' });
  assert.equal(ok.status, 303);
  assert.equal(ok.location, '/contacts#form');
  assert.equal(threads(), start + 1);
  const thread = get(`SELECT * FROM feedback_threads WHERE channel = 'site' ORDER BY id DESC LIMIT 1`);
  assert.equal(thread.name, 'Дильноза');
  assert.equal(thread.contact, '+998 90 111 22 33');
  assert.equal(thread.subject, 'Опт');
  assert.equal(thread.status, 'open');
  const message = get('SELECT * FROM feedback_messages WHERE thread_id = ?', thread.id);
  assert.equal(message.direction, 'in');
  assert.match(message.text, /10 кг эспрессо-смеси/);
  assert.equal(count(`SELECT COUNT(*) AS n FROM events WHERE name = 'feedback' AND session_id = ?`, c.jar.get('sc_sid')), 1, 'feedback event is tied to the visitor session');

  const after = await c.get('/contacts');
  assert.ok(after.text.includes(content.get('contacts', 'form_success')), 'success flash is shown once');
  assert.ok(!(await c.get('/contacts')).text.includes(content.get('contacts', 'form_success')));

  // 5 posts per 10 minutes per IP: three were used above (CSRF failures do not count)
  const statuses = [];
  let last = null;
  for (let i = 0; i < 4; i += 1) {
    last = await c.postForm('/contacts', { name: 'Повтор', contact: 'repeat@example.com', message: `Сообщение номер ${i}` });
    statuses.push(last.status);
  }
  assert.deepEqual(statuses, [303, 303, 429, 429]);
  assert.ok(last.text.includes('Вы отправили слишком много сообщений'), 'the limit is explained on a branded page');
  assert.match(last.text, /<header class="header"/);
  assert.ok(Number(last.headers.get('retry-after')) > 0);
  assert.equal(threads(), start + 3);
  assert.equal(all(`SELECT id FROM feedback_threads WHERE name = 'Повтор'`).length, 2);
});

test('view helpers', () => {
  assert.equal(accentTitle('Кофе, который обжарили для вас на этой неделе'), 'Кофе, который обжарили для вас на <em>этой неделе</em>');
  assert.equal(accentTitle('Свежий *кофе* <сегодня>'), 'Свежий <em>кофе</em> &lt;сегодня&gt;');
  assert.equal(accentTitle('Два слова'), 'Два слова');
  assert.deepEqual(paginate(100, 5, 12).items, [1, null, 4, 5, 6, null, 9]);
  assert.equal(paginate(0, 3, 12).page, 1);
  assert.equal(paginate(30, 'abc', 12).offset, 0);
  assert.equal(withQuery('/catalog', { category: 'filter', sort: '', q: undefined, page: 1 }), '/catalog?category=filter');
  assert.equal(withQuery('/catalog', { page: 3, q: 'кофе' }), '/catalog?page=3&q=%D0%BA%D0%BE%D1%84%D0%B5');
  assert.equal(safeLocalPath('/cart?x=1'), '/cart?x=1');
  for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', '', null, '/a\r\nSet-Cookie: x=1']) {
    assert.equal(safeLocalPath(bad, '/fallback'), '/fallback', String(bad));
  }
  assert.deepEqual(tastingNotes([{ roast: 'Светлая', subtitle: 'Жасмин, Бергамот' }, { roast: '', subtitle: 'Сталь, 38 мм' }, { roast: 'Средняя', subtitle: '10 порций · жасмин' }, { roast: 'Средняя', subtitle: 'жасмин, какао' }]), ['жасмин', 'бергамот', 'какао']);
  assert.equal(periodLabel(30), 'в месяц');
  assert.equal(periodLabel(14), 'за 14 дн.');
});
