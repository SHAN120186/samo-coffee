import './helpers/env.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/http.js';
import * as catalog from '../src/services/catalog.js';
import * as subscriptions from '../src/services/subscriptions.js';
import * as posts from '../src/services/posts.js';
import * as faq from '../src/services/faq.js';
import { login, postPairs } from './admin.helpers.js';

let t;
let c;
before(async () => {
  t = await startTestApp();
  c = t.client;
  await login(c);
});
after(async () => {
  await t.close();
});

test('products: empty state, validation errors keep the typed values', async () => {
  const empty = await c.get('/admin/products');
  assert.equal(empty.status, 200);
  assert.match(empty.text, /В каталоге пока нет товаров/);

  const form = await c.get('/admin/products/new');
  assert.equal(form.status, 200);
  const bad = await postPairs(c, '/admin/products', [['title', ''], ['price', 'сто тысяч'], ['stock', '-3'], ['subtitle', 'Сохранённый подзаголовок']]);
  assert.equal(bad.status, 422);
  assert.match(bad.text, /Укажите название товара/);
  assert.match(bad.text, /Цена — целое число сумов/);
  assert.match(bad.text, /Остаток — целое неотрицательное число/);
  assert.match(bad.text, /Сохранённый подзаголовок/, 'the form is re-rendered with the entered values');
  assert.equal(catalog.listProducts({ activeOnly: false }).total, 0);

  const oldPrice = await postPairs(c, '/admin/products', [['title', 'Товар'], ['price', '100000'], ['old_price', '90000'], ['stock', '1']]);
  assert.equal(oldPrice.status, 422);
  assert.match(oldPrice.text, /Старая цена должна быть больше текущей/);
});

let productId;

test('products: create with gallery, attributes and sanitized rich text', async () => {
  const category = catalog.createCategory({ title: 'Для фильтра' });
  await c.get('/admin/products/new');
  const res = await postPairs(c, '/admin/products', [
    ['title', 'Эфиопия Гуджи'], ['subtitle', 'Персик, жасмин'], ['description', 'Светлая обжарка'],
    ['details_html', '<h2>О лоте</h2><p onclick="steal()">Ягодный <strong>лот</strong></p><script>alert(1)</script><img src="/uploads/a.png" onerror="x()">'],
    ['price', '149 000'], ['old_price', '169000'], ['stock', '12'], ['weight_g', '250'], ['category_id', category.id],
    ['origin', 'Эфиопия'], ['process', 'Мытая'], ['roast', 'Светлая'], ['sort', '3'],
    ['images[]', '/img/products/ethiopia-yirgacheffe.svg'], ['images[]', '/uploads/second.png'], ['images[]', 'javascript:alert(1)'],
    ['attr_key[]', 'Высота'], ['attr_value[]', '2000 м'], ['attr_key[]', ''], ['attr_value[]', 'без названия'], ['attr_key[]', 'Сорт'], ['attr_value[]', 'Эйрлум'],
    ['active', '1'], ['featured', '1'],
  ]);
  assert.equal(res.status, 302);
  const m = /^\/admin\/products\/(\d+)$/.exec(res.location);
  assert.ok(m, res.location);
  productId = Number(m[1]);

  const p = catalog.getProduct(productId);
  assert.equal(p.title, 'Эфиопия Гуджи');
  assert.equal(p.price, 149000, 'spaces in the price are ignored');
  assert.equal(p.old_price, 169000);
  assert.equal(p.stock, 12);
  assert.equal(p.weight_g, 250);
  assert.equal(p.category_id, category.id);
  assert.equal(p.active, 1);
  assert.equal(p.featured, 1);
  assert.deepEqual(p.images, ['/img/products/ethiopia-yirgacheffe.svg', '/uploads/second.png'], 'order kept, unsafe URL dropped');
  assert.deepEqual(p.attributes, { Высота: '2000 м', Сорт: 'Эйрлум' });
  assert.ok(!/script|onclick|onerror|steal/.test(p.details_html), p.details_html);
  assert.match(p.details_html, /<h2>О лоте<\/h2>/);
  assert.match(p.details_html, /<img src="\/uploads\/a\.png"/);
  assert.ok(p.slug.length > 0);

  const page = await c.get(res.location);
  assert.equal(page.status, 200);
  assert.match(page.text, /Товар «Эфиопия Гуджи» создан/, 'flash message');
  assert.match(page.text, /value="Эфиопия Гуджи"/);
  assert.match(page.text, /name="images\[\]" value="\/uploads\/second\.png"/);
});

test('products: list, search and filters', async () => {
  catalog.createProduct({ title: 'Скрытый чайник', price: 540000, stock: 0, active: 0 });
  const list = await c.get('/admin/products');
  assert.match(list.text, /Эфиопия Гуджи/);
  assert.match(list.text, /Скрытый чайник/, 'inactive products are listed in the admin');
  const found = await c.get(`/admin/products?search=${encodeURIComponent('гуджи')}`);
  assert.match(found.text, /Эфиопия Гуджи/);
  assert.ok(!found.text.includes('Скрытый чайник'));
  const hidden = await c.get('/admin/products?state=hidden');
  assert.ok(!hidden.text.includes('Эфиопия Гуджи'));
  assert.match(hidden.text, /Скрытый чайник/);
  const out = await c.get('/admin/products?stock=out');
  assert.match(out.text, /Скрытый чайник/);
  const none = await c.get('/admin/products?search=zzzzzz');
  assert.match(none.text, /Ничего не найдено/);
});

test('products: update, quick toggles, stock, delete', async () => {
  await c.get(`/admin/products/${productId}`);
  const res = await postPairs(c, `/admin/products/${productId}`, [
    ['title', 'Эфиопия Гуджи, натуральная'], ['price', '155000'], ['old_price', ''], ['stock', '7'], ['weight_g', ''],
    ['images[]', '/uploads/second.png'], ['slug', 'ethiopia-guji'],
    // no "active"/"featured" → unchecked switches
  ]);
  assert.equal(res.status, 302);
  let p = catalog.getProduct(productId);
  assert.equal(p.title, 'Эфиопия Гуджи, натуральная');
  assert.equal(p.price, 155000);
  assert.equal(p.old_price, null);
  assert.equal(p.stock, 7);
  assert.equal(p.weight_g, null);
  assert.equal(p.slug, 'ethiopia-guji');
  assert.equal(p.active, 0, 'unchecked switch hides the product');
  assert.equal(p.featured, 0);
  assert.deepEqual(p.images, ['/uploads/second.png']);
  assert.deepEqual(p.attributes, {}, 'removed attribute rows are deleted');

  const invalid = await postPairs(c, `/admin/products/${productId}`, [['title', 'x'], ['price', '-5'], ['stock', '1']]);
  assert.equal(invalid.status, 422);
  assert.equal(catalog.getProduct(productId).price, 155000);

  await c.get('/admin/products');
  assert.equal((await c.postForm(`/admin/products/${productId}/toggle`, { field: 'active', _back: '/admin/products?state=hidden' })).location, '/admin/products?state=hidden');
  assert.equal((await c.postForm(`/admin/products/${productId}/toggle`, { field: 'featured' })).status, 302);
  p = catalog.getProduct(productId);
  assert.equal(p.active, 1);
  assert.equal(p.featured, 1);
  const evilBack = await c.postForm(`/admin/products/${productId}/toggle`, { field: 'featured', _back: 'https://evil.example/' });
  assert.equal(evilBack.location, '/admin/products', 'open redirects are not possible through _back');

  await c.postForm(`/admin/products/${productId}/stock`, { stock: '40' });
  assert.equal(catalog.getProduct(productId).stock, 40);
  await c.postForm(`/admin/products/${productId}/stock`, { stock: 'много' });
  assert.equal(catalog.getProduct(productId).stock, 40);

  const del = await c.postForm(`/admin/products/${productId}/delete`, {});
  assert.equal(del.status, 302);
  assert.equal(del.location, '/admin/products');
  assert.equal(catalog.getProduct(productId), null);
  assert.equal((await c.get(`/admin/products/${productId}`)).status, 404);
  assert.equal((await c.postForm(`/admin/products/${productId}/delete`, {})).status, 404);
});

test('categories: create, edit, reorder, delete', async () => {
  await c.get('/admin/categories/new');
  const bad = await c.postForm('/admin/categories', { title: '', image: 'ftp://x/y.png' });
  assert.equal(bad.status, 422);
  const created = await c.postForm('/admin/categories', { title: 'Дрип-пакеты', description: 'В дорогу', image: '/img/categories/drip.svg', active: '1' });
  assert.equal(created.status, 302);
  const all = catalog.listCategories({ activeOnly: false });
  const drip = all.find((x) => x.title === 'Дрип-пакеты');
  assert.ok(drip);
  assert.equal(drip.image, '/img/categories/drip.svg');

  await c.get(`/admin/categories/${drip.id}`);
  await c.postForm(`/admin/categories/${drip.id}`, { title: 'Дрипы', description: '', image: '' });
  assert.equal(catalog.getCategory(drip.id).title, 'Дрипы');
  assert.equal(catalog.getCategory(drip.id).active, 0);

  const ids = catalog.listCategories({ activeOnly: false }).map((x) => x.id).reverse();
  const reorder = await c.postJson('/admin/categories/reorder', { ids });
  assert.equal(reorder.status, 200);
  assert.deepEqual(catalog.listCategories({ activeOnly: false }).map((x) => x.id), ids);

  const list = await c.get('/admin/categories');
  assert.match(list.text, /Дрипы/);
  await c.postForm(`/admin/categories/${drip.id}/delete`, {});
  assert.equal(catalog.getCategory(drip.id), undefined);
});

test('plans: create with perks, edit, delete / deactivate', async () => {
  await c.get('/admin/plans/new');
  const bad = await c.postForm('/admin/plans', { title: 'План', price: 'дорого', period_days: '0' });
  assert.equal(bad.status, 422);
  assert.match(bad.text, /Период — от 1 до 366 дней/);

  const created = await c.postForm('/admin/plans', {
    title: 'Для двоих', price: '379000', period_days: '30', perks: 'Четыре пачки\r\n\r\nБесплатная доставка\n  Скидка 10 %  ', badge: 'Хит', active: '1',
  });
  assert.equal(created.status, 302);
  const plan = subscriptions.listPlans({ activeOnly: false }).find((p) => p.title === 'Для двоих');
  assert.deepEqual(plan.perks, ['Четыре пачки', 'Бесплатная доставка', 'Скидка 10 %']);
  assert.equal(plan.price, 379000);
  assert.equal(plan.badge, 'Хит');

  await c.get(`/admin/plans/${plan.id}`);
  await c.postForm(`/admin/plans/${plan.id}`, { title: 'Для двоих', price: '399000', period_days: '30', perks: 'Одна строка', active: '1' });
  assert.equal(subscriptions.getPlan(plan.id).price, 399000);
  assert.deepEqual(subscriptions.getPlan(plan.id).perks, ['Одна строка']);
  assert.match((await c.get('/admin/plans')).text, /Для двоих/);

  await c.postForm(`/admin/plans/${plan.id}/delete`, {});
  assert.equal(subscriptions.getPlan(plan.id), null);
});

test('blog: draft → publish → edit → delete, body is sanitized', async () => {
  assert.match((await c.get('/admin/posts')).text, /В блоге пока нет статей/);
  await c.get('/admin/posts/new');
  assert.equal((await c.postForm('/admin/posts', { title: '' })).status, 422);
  const created = await c.postForm('/admin/posts', {
    title: 'Как заварить V60', body_html: '<h1>Рецепт</h1><p>Воды <b>250 мл</b></p><iframe src="https://evil"></iframe><a href="javascript:x()">клик</a>', author: 'Тимур',
  });
  assert.equal(created.status, 302);
  const id = Number(/\/admin\/posts\/(\d+)$/.exec(created.location)[1]);
  let post = posts.getPost(id);
  assert.equal(post.published, 0, 'saved as a draft by default');
  assert.ok(!/iframe|javascript/.test(post.body_html), post.body_html);
  assert.match(post.body_html, /<h2>Рецепт<\/h2>/);
  assert.equal(posts.getPostBySlug(post.slug), null, 'drafts are not public');

  await c.get(`/admin/posts/${id}`);
  await c.postForm(`/admin/posts/${id}`, { title: 'Как заварить V60 дома', body_html: '<p>Новый текст</p>', published: '1', published_date: '2026-11-01', cover: '/img/blog/cover-2.svg' });
  post = posts.getPost(id);
  assert.equal(post.published, 1);
  assert.equal(post.title, 'Как заварить V60 дома');
  assert.equal(post.cover, '/img/blog/cover-2.svg');
  assert.ok(post.published_at.startsWith('2026-11-01'));
  assert.ok(posts.getPostBySlug(post.slug));

  await c.get('/admin/posts');
  await c.postForm(`/admin/posts/${id}/toggle`, {});
  assert.equal(posts.getPost(id).published, 0);
  await c.postForm(`/admin/posts/${id}/delete`, {});
  assert.equal(posts.getPost(id), null);
});

test('FAQ: create, order (move + reorder), hide, delete', async () => {
  await c.get('/admin/faq/new');
  assert.equal((await c.postForm('/admin/faq', { question: '' })).status, 422);
  for (const question of ['Первый?', 'Второй?', 'Третий?']) {
    const res = await c.postForm('/admin/faq', { question, answer: `<p>Ответ на «${question}»</p><script>x</script>`, topic: 'Доставка', active: '1' });
    assert.equal(res.status, 302);
  }
  let items = faq.listFaq({ activeOnly: false });
  assert.deepEqual(items.map((f) => f.question), ['Первый?', 'Второй?', 'Третий?'], 'new questions go to the end');
  assert.ok(!items[0].answer.includes('script'));

  await c.get('/admin/faq');
  await c.postForm(`/admin/faq/${items[2].id}/move`, { dir: 'up' });
  assert.deepEqual(faq.listFaq({ activeOnly: false }).map((f) => f.question), ['Первый?', 'Третий?', 'Второй?']);

  const order = [items[1].id, items[0].id, items[2].id];
  const reorder = await c.postJson('/admin/faq/reorder', { ids: order });
  assert.deepEqual(reorder.json(), { ok: true });
  assert.deepEqual(faq.listFaq({ activeOnly: false }).map((f) => f.id), order);

  await c.postForm(`/admin/faq/${items[0].id}/toggle`, {});
  assert.equal(faq.getFaq(items[0].id).active, 0);
  assert.equal(faq.listFaq().length, 2, 'hidden question is not public');

  await c.get(`/admin/faq/${items[1].id}`);
  await c.postForm(`/admin/faq/${items[1].id}`, { question: 'Второй, уточнённый?', answer: '<p>Да</p>', topic: 'Оплата', active: '1' });
  items = faq.listFaq({ activeOnly: false });
  assert.equal(items[0].question, 'Второй, уточнённый?', 'position is kept when the sort field is empty');

  await c.postForm(`/admin/faq/${items[0].id}/delete`, {});
  assert.equal(faq.getFaq(items[0].id), undefined);
});
