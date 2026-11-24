// Catalog management: products (with image gallery and attributes) and categories.
import { Router } from 'express';
import * as catalog from '../../services/catalog.js';
import { notFound } from '../../lib/errors.js';
import { clean } from '../../lib/escape.js';
import { view, intParam, flag, list, isUserError, flatQuery, paginate, backUrl } from '../lib.js';

const router = Router();
const PER_PAGE = 20;

// ─────────────────────────────── products

const STOCK_FILTERS = { in: 'В наличии', low: 'Заканчиваются (≤ 5)', out: 'Нет в наличии' };
const STATE_FILTERS = { active: 'Опубликованные', hidden: 'Скрытые', featured: 'Рекомендуемые' };

router.get('/products', (req, res) => {
  const q = flatQuery(req.query);
  const categories = catalog.listCategories({ activeOnly: false });
  let { items } = catalog.listProducts({
    activeOnly: false,
    search: q.search,
    categoryId: intParam(q.category) || undefined,
    sort: catalog.PRODUCT_SORTS[q.sort] ? q.sort : undefined,
  });
  if (q.state === 'active') items = items.filter((p) => p.active);
  if (q.state === 'hidden') items = items.filter((p) => !p.active);
  if (q.state === 'featured') items = items.filter((p) => p.featured);
  if (q.stock === 'in') items = items.filter((p) => p.stock > 0);
  if (q.stock === 'low') items = items.filter((p) => p.stock > 0 && p.stock <= 5);
  if (q.stock === 'out') items = items.filter((p) => p.stock <= 0);
  const pager = paginate(req, items.length, PER_PAGE);
  res.render(view('products/index'), {
    title: 'Товары',
    section: 'products',
    products: items.slice(pager.offset, pager.offset + PER_PAGE),
    pager,
    categories,
    filters: q,
    hasFilters: Boolean(q.search || q.category || q.state || q.stock),
    sorts: catalog.PRODUCT_SORTS,
    stockFilters: STOCK_FILTERS,
    stateFilters: STATE_FILTERS,
  });
});

/** Form body → data for catalog.createProduct / updateProduct. */
function productInput(body) {
  const values = Array.isArray(body.attr_value) ? body.attr_value : body.attr_value === undefined ? [] : [body.attr_value];
  const attributes = {};
  const rawKeys = Array.isArray(body.attr_key) ? body.attr_key : body.attr_key === undefined ? [] : [body.attr_key];
  rawKeys.slice(0, 30).forEach((k, i) => {
    const key = clean(k, 60);
    const value = clean(values[i], 200);
    if (key && value) attributes[key] = value;
  });
  return {
    title: clean(body.title, 160),
    slug: clean(body.slug, 120),
    category_id: intParam(body.category_id) ?? '',
    subtitle: clean(body.subtitle, 200),
    description: clean(body.description, 2000),
    details_html: typeof body.details_html === 'string' ? body.details_html : '',
    price: clean(body.price, 12).replace(/\s/g, ''),
    old_price: clean(body.old_price, 12).replace(/\s/g, ''),
    stock: clean(body.stock, 8) || '0',
    weight_g: clean(body.weight_g, 8),
    roast: clean(body.roast, 60),
    origin: clean(body.origin, 120),
    process: clean(body.process, 120),
    sort: clean(body.sort, 6) || '0',
    images: list(body.images, 12),
    attributes,
    active: flag(body.active),
    featured: flag(body.featured),
  };
}

function validateProduct(data) {
  const fields = {};
  if (!data.title) fields.title = 'Укажите название товара';
  if (!/^\d+$/.test(data.price)) fields.price = 'Цена — целое число сумов, например 129000';
  if (data.old_price && !/^\d+$/.test(data.old_price)) fields.old_price = 'Старая цена — целое число';
  else if (data.old_price && /^\d+$/.test(data.price) && Number(data.old_price) <= Number(data.price)) fields.old_price = 'Старая цена должна быть больше текущей';
  if (!/^\d+$/.test(data.stock)) fields.stock = 'Остаток — целое неотрицательное число';
  if (data.weight_g && !/^\d+$/.test(data.weight_g)) fields.weight_g = 'Вес — целое число граммов';
  if (data.slug && !/^[a-z0-9-]+$/i.test(data.slug)) fields.slug = 'Только латинские буквы, цифры и дефис';
  return fields;
}

function renderProductForm(req, res, { product, isNew, status = 200, error = null, fields = {} }) {
  res.status(status).render(view('products/form'), {
    title: isNew ? 'Новый товар' : product.title || 'Товар',
    section: 'products',
    product,
    isNew,
    categories: catalog.listCategories({ activeOnly: false }),
    error,
    fields,
  });
}

const BLANK_PRODUCT = {
  title: '', slug: '', category_id: null, subtitle: '', description: '', details_html: '', price: '', old_price: '',
  stock: 10, weight_g: 250, roast: '', origin: '', process: '', sort: 0, images: [], attributes: {}, active: 1, featured: 0,
};

router.get('/products/new', (req, res) => {
  renderProductForm(req, res, { product: { ...BLANK_PRODUCT, category_id: intParam(req.query.category) }, isNew: true });
});

router.post('/products', (req, res, next) => {
  const data = productInput(req.body);
  const fields = validateProduct(data);
  if (Object.keys(fields).length) {
    return renderProductForm(req, res, { product: data, isNew: true, status: 422, error: 'Проверьте отмеченные поля', fields });
  }
  try {
    const product = catalog.createProduct(data);
    req.flash('success', `Товар «${product.title}» создан`);
    return res.redirect(`/admin/products/${product.id}`);
  } catch (err) {
    if (isUserError(err)) return renderProductForm(req, res, { product: data, isNew: true, status: 422, error: err.message });
    return next(err);
  }
});

function loadProduct(req) {
  const id = intParam(req.params.id);
  const product = id ? catalog.getProduct(id) : null;
  if (!product) throw notFound('Товар');
  return product;
}

router.get('/products/:id', (req, res) => {
  renderProductForm(req, res, { product: loadProduct(req), isNew: false });
});

router.post('/products/:id', (req, res, next) => {
  const current = loadProduct(req);
  const data = productInput(req.body);
  const fields = validateProduct(data);
  if (Object.keys(fields).length) {
    return renderProductForm(req, res, { product: { ...current, ...data }, isNew: false, status: 422, error: 'Проверьте отмеченные поля', fields });
  }
  try {
    const product = catalog.updateProduct(current.id, data);
    req.flash('success', `Товар «${product.title}» сохранён`);
    return res.redirect(`/admin/products/${product.id}`);
  } catch (err) {
    if (isUserError(err)) return renderProductForm(req, res, { product: { ...current, ...data }, isNew: false, status: 422, error: err.message });
    return next(err);
  }
});

/** Quick switches in the list: active / featured. */
router.post('/products/:id/toggle', (req, res) => {
  const product = loadProduct(req);
  const field = req.body.field === 'featured' ? 'featured' : 'active';
  const updated = catalog.updateProduct(product.id, { [field]: product[field] ? 0 : 1 });
  const text = field === 'active'
    ? (updated.active ? 'опубликован на сайте' : 'скрыт с сайта')
    : (updated.featured ? 'добавлен в рекомендуемые' : 'убран из рекомендуемых');
  req.flash('success', `Товар «${updated.title}» ${text}`);
  res.redirect(backUrl(req, '/admin/products'));
});

router.post('/products/:id/stock', (req, res) => {
  const product = loadProduct(req);
  const stock = clean(req.body.stock, 8);
  if (!/^\d+$/.test(stock)) {
    req.flash('error', 'Остаток — целое неотрицательное число');
  } else {
    catalog.updateProduct(product.id, { stock });
    req.flash('success', `Остаток «${product.title}» обновлён: ${Number(stock)} шт.`);
  }
  res.redirect(backUrl(req, '/admin/products'));
});

router.post('/products/:id/delete', (req, res) => {
  const product = loadProduct(req);
  catalog.deleteProduct(product.id);
  req.flash('success', `Товар «${product.title}» удалён. В истории заказов он сохранится.`);
  res.redirect('/admin/products');
});

// ─────────────────────────────── categories

router.get('/categories', (req, res) => {
  const categories = catalog.listCategories({ activeOnly: false }).map((c) => ({
    ...c,
    total_products: catalog.listProducts({ activeOnly: false, categoryId: c.id }).total,
  }));
  res.render(view('categories/index'), { title: 'Категории', section: 'categories', categories });
});

function categoryInput(body) {
  return {
    title: clean(body.title, 120),
    slug: clean(body.slug, 120),
    description: clean(body.description, 1000),
    image: clean(body.image, 1000),
    sort: clean(body.sort, 6) || '0',
    active: flag(body.active),
  };
}

function validateCategory(data) {
  const fields = {};
  if (!data.title) fields.title = 'Укажите название категории';
  if (data.slug && !/^[a-z0-9-]+$/i.test(data.slug)) fields.slug = 'Только латинские буквы, цифры и дефис';
  if (data.image && !/^(\/(?!\/)|https?:\/\/)/.test(data.image)) fields.image = 'Ссылка должна начинаться с «/» или «https://»';
  return fields;
}

function renderCategoryForm(req, res, { category, isNew, status = 200, error = null, fields = {} }) {
  res.status(status).render(view('categories/form'), {
    title: isNew ? 'Новая категория' : category.title || 'Категория',
    section: 'categories',
    category,
    isNew,
    error,
    fields,
  });
}

router.get('/categories/new', (req, res) => {
  renderCategoryForm(req, res, { category: { title: '', slug: '', description: '', image: '', sort: 0, active: 1 }, isNew: true });
});

router.post('/categories', (req, res, next) => {
  const data = categoryInput(req.body);
  const fields = validateCategory(data);
  if (Object.keys(fields).length) return renderCategoryForm(req, res, { category: data, isNew: true, status: 422, error: 'Проверьте отмеченные поля', fields });
  try {
    const category = catalog.createCategory(data);
    req.flash('success', `Категория «${category.title}» создана`);
    return res.redirect('/admin/categories');
  } catch (err) {
    if (isUserError(err)) return renderCategoryForm(req, res, { category: data, isNew: true, status: 422, error: err.message });
    return next(err);
  }
});

function loadCategory(req) {
  const id = intParam(req.params.id);
  const category = id ? catalog.getCategory(id) : null;
  if (!category) throw notFound('Категория');
  return category;
}

router.post('/categories/reorder', (req, res) => {
  const ids = list(req.body.ids, 200).map(intParam).filter(Boolean);
  ids.forEach((id, index) => {
    if (catalog.getCategory(id)) catalog.updateCategory(id, { sort: index + 1 });
  });
  if (req.xhr || req.accepts(['html', 'json']) === 'json') return res.json({ ok: true });
  req.flash('success', 'Порядок категорий сохранён');
  return res.redirect('/admin/categories');
});

router.get('/categories/:id', (req, res) => {
  renderCategoryForm(req, res, { category: loadCategory(req), isNew: false });
});

router.post('/categories/:id', (req, res, next) => {
  const current = loadCategory(req);
  const data = categoryInput(req.body);
  const fields = validateCategory(data);
  if (Object.keys(fields).length) return renderCategoryForm(req, res, { category: { ...current, ...data }, isNew: false, status: 422, error: 'Проверьте отмеченные поля', fields });
  try {
    const category = catalog.updateCategory(current.id, data);
    req.flash('success', `Категория «${category.title}» сохранена`);
    return res.redirect('/admin/categories');
  } catch (err) {
    if (isUserError(err)) return renderCategoryForm(req, res, { category: { ...current, ...data }, isNew: false, status: 422, error: err.message });
    return next(err);
  }
});

router.post('/categories/:id/delete', (req, res) => {
  const category = loadCategory(req);
  catalog.deleteCategory(category.id);
  req.flash('success', `Категория «${category.title}» удалена. Её товары остались в каталоге без категории.`);
  res.redirect('/admin/categories');
});

export default router;
