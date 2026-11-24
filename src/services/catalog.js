// Catalog: categories + products. Money is whole UZS sums.
import { all, get, run, tx, now, parseJson } from '../db/index.js';
import { slugify, uniqueSlug } from '../lib/slugify.js';
import { sanitizeRichText } from '../lib/sanitize.js';
import { discountPercent } from '../lib/money.js';
import { AppError, notFound } from '../lib/errors.js';

export const PRODUCT_SORTS = {
  popular: 'Сначала популярные',
  new: 'Сначала новинки',
  price_asc: 'Сначала дешевле',
  price_desc: 'Сначала дороже',
  title: 'По названию',
};
export const PLACEHOLDER_IMAGE = '/img/placeholder.svg';

const toInt = (v, def = 0) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};
const flag = (v) => (v === true || v === 1 || v === '1' || v === 'on' || v === 'true' ? 1 : 0);
const lc = (s) => String(s ?? '').toLocaleLowerCase('ru');

// ─────────────────────────────── categories

/**
 * Categories ordered by sort. Each row gets `product_count` (active products).
 * @param {{ activeOnly?: boolean }} [options] default activeOnly=true
 */
export function listCategories({ activeOnly = true } = {}) {
  return all(
    `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.active = 1) AS product_count
       FROM categories c ${activeOnly ? 'WHERE c.active = 1' : ''} ORDER BY c.sort, c.id`,
  );
}

export function getCategory(id) {
  return get('SELECT * FROM categories WHERE id = ?', id);
}

export function getCategoryBySlug(slug) {
  return get('SELECT * FROM categories WHERE slug = ?', String(slug));
}

function categoryFields(data, current = {}) {
  const title = String(data.title ?? current.title ?? '').trim();
  if (!title) throw new AppError('validation', 'Укажите название категории', 422);
  return {
    title,
    description: String(data.description ?? current.description ?? '').trim(),
    image: String(data.image ?? current.image ?? '').trim(),
    sort: toInt(data.sort ?? current.sort, 0),
    active: data.active === undefined ? (current.active ?? 1) : flag(data.active),
  };
}

export function createCategory(data) {
  const f = categoryFields(data);
  const slug = uniqueSlug(data.slug || f.title, (s) => Boolean(getCategoryBySlug(s)));
  const { lastInsertRowid } = run(
    'INSERT INTO categories (slug, title, description, image, sort, active) VALUES (?, ?, ?, ?, ?, ?)',
    slug, f.title, f.description, f.image, f.sort, f.active,
  );
  return getCategory(Number(lastInsertRowid));
}

export function updateCategory(id, data) {
  const current = getCategory(id);
  if (!current) throw notFound('Категория');
  const f = categoryFields(data, current);
  let slug = current.slug;
  if (data.slug && slugify(data.slug) !== current.slug) {
    slug = uniqueSlug(data.slug, (s) => Boolean(get('SELECT 1 AS x FROM categories WHERE slug = ? AND id <> ?', s, id)));
  }
  run('UPDATE categories SET slug = ?, title = ?, description = ?, image = ?, sort = ?, active = ? WHERE id = ?',
    slug, f.title, f.description, f.image, f.sort, f.active, id);
  return getCategory(id);
}

/** Delete a category; its products stay and become uncategorized. */
export function deleteCategory(id) {
  return run('DELETE FROM categories WHERE id = ?', id).changes > 0;
}

// ─────────────────────────────── products

const PRODUCT_SELECT = `
  SELECT p.*, c.title AS category_title, c.slug AS category_slug,
         COALESCE((SELECT SUM(oi.qty) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                    WHERE oi.product_id = p.id AND o.payment_status = 'paid'), 0) AS sold
    FROM products p LEFT JOIN categories c ON c.id = p.category_id`;

/**
 * Turn a DB row into the product object used everywhere:
 * adds images[] (parsed), image (cover), attributes{} (parsed), in_stock, discount_percent, url.
 */
export function hydrateProduct(row) {
  if (!row) return null;
  const images = parseJson(row.images, []).filter((x) => typeof x === 'string' && x);
  return {
    ...row,
    images,
    image: images[0] || PLACEHOLDER_IMAGE,
    attributes: parseJson(row.attributes, {}),
    in_stock: row.stock > 0,
    discount_percent: discountPercent(row.price, row.old_price),
    url: `/catalog/${row.slug}`,
  };
}

/**
 * List products.
 * @param {object} [f]
 * @param {number} [f.categoryId]
 * @param {string} [f.categorySlug]
 * @param {string} [f.search] case-insensitive (Cyrillic-aware) match on title/subtitle/description/origin
 * @param {'popular'|'new'|'price_asc'|'price_desc'|'title'} [f.sort] default: manual sort order
 * @param {boolean} [f.featured] only featured
 * @param {boolean} [f.activeOnly] default true (pass false in the admin)
 * @param {boolean} [f.inStockOnly]
 * @param {number} [f.limit] default: all
 * @param {number} [f.offset]
 * @returns {{ items: object[], total: number }}
 */
export function listProducts(f = {}) {
  const where = [];
  const params = [];
  if (f.activeOnly !== false) where.push('p.active = 1');
  if (f.categoryId) { where.push('p.category_id = ?'); params.push(Number(f.categoryId)); }
  if (f.categorySlug) { where.push('c.slug = ?'); params.push(String(f.categorySlug)); }
  if (f.featured) where.push('p.featured = 1');
  if (f.inStockOnly) where.push('p.stock > 0');
  let rows = all(`${PRODUCT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.sort, p.id`, ...params);

  const search = lc(f.search).trim();
  if (search) {
    const words = search.split(/\s+/).filter(Boolean);
    rows = rows.filter((r) => {
      const hay = lc(`${r.title} ${r.subtitle} ${r.description} ${r.origin} ${r.category_title || ''}`);
      return words.every((w) => hay.includes(w));
    });
  }
  const sorters = {
    popular: (a, b) => b.sold - a.sold || b.featured - a.featured || a.sort - b.sort,
    new: (a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id),
    price_asc: (a, b) => a.price - b.price,
    price_desc: (a, b) => b.price - a.price,
    title: (a, b) => a.title.localeCompare(b.title, 'ru'),
  };
  if (sorters[f.sort]) rows.sort(sorters[f.sort]);

  const total = rows.length;
  const offset = Math.max(0, toInt(f.offset, 0));
  const limit = f.limit ? Math.max(1, toInt(f.limit, total)) : total;
  return { items: rows.slice(offset, offset + limit).map(hydrateProduct), total };
}

/** Product by id (any active state) or null. */
export function getProduct(id) {
  return hydrateProduct(get(`${PRODUCT_SELECT} WHERE p.id = ?`, Number(id)));
}

/** Product by slug or null. activeOnly defaults to true (public pages). */
export function getProductBySlug(slug, { activeOnly = true } = {}) {
  return hydrateProduct(get(`${PRODUCT_SELECT} WHERE p.slug = ? ${activeOnly ? 'AND p.active = 1' : ''}`, String(slug)));
}

/** Other active products, same category first. */
export function relatedProducts(product, limit = 4) {
  const { items } = listProducts({ sort: 'popular' });
  const others = items.filter((p) => p.id !== product.id);
  const same = others.filter((p) => p.category_id === product.category_id);
  const rest = others.filter((p) => p.category_id !== product.category_id);
  return [...same, ...rest].slice(0, limit);
}

function productFields(data, current = null) {
  const pick = (k, def) => (data[k] !== undefined ? data[k] : current ? current[k] : def);
  const title = String(pick('title', '')).trim();
  if (!title) throw new AppError('validation', 'Укажите название товара', 422);
  const price = toInt(pick('price', NaN), NaN);
  if (!Number.isFinite(price) || price < 0) throw new AppError('validation', 'Укажите корректную цену', 422);
  const oldRaw = pick('old_price', null);
  const oldPrice = oldRaw === null || oldRaw === '' ? null : toInt(oldRaw, null);

  let images = pick('images', []);
  if (typeof images === 'string') {
    const parsed = parseJson(images, null);
    images = Array.isArray(parsed) ? parsed : images.split(/[\n,]+/);
  }
  images = (Array.isArray(images) ? images : []).map((x) => String(x).trim()).filter((x) => /^(\/(?!\/)|https?:\/\/)/.test(x)).slice(0, 12);

  let attributes = pick('attributes', {});
  if (typeof attributes === 'string') attributes = parseJson(attributes, {});
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) attributes = {};

  const categoryId = pick('category_id', null);
  const weight = pick('weight_g', null);
  return {
    category_id: categoryId === null || categoryId === '' ? null : toInt(categoryId, null),
    title,
    subtitle: String(pick('subtitle', '')).trim(),
    description: String(pick('description', '')).trim(),
    details_html: data.details_html !== undefined ? sanitizeRichText(data.details_html) : (current?.details_html ?? ''),
    price,
    old_price: oldPrice && oldPrice > price ? oldPrice : null,
    images: JSON.stringify(images),
    stock: Math.max(0, toInt(pick('stock', 0), 0)),
    weight_g: weight === null || weight === '' ? null : toInt(weight, null),
    roast: String(pick('roast', '')).trim(),
    origin: String(pick('origin', '')).trim(),
    process: String(pick('process', '')).trim(),
    attributes: JSON.stringify(attributes),
    active: data.active === undefined ? (current?.active ?? 1) : flag(data.active),
    featured: data.featured === undefined ? (current?.featured ?? 0) : flag(data.featured),
    sort: toInt(pick('sort', 0), 0),
  };
}

const slugTaken = (slug, exceptId = 0) => Boolean(get('SELECT 1 AS x FROM products WHERE slug = ? AND id <> ?', slug, exceptId));

/**
 * Create a product. data: { title*, price*, category_id, slug, subtitle, description, details_html,
 * old_price, images (array | JSON | newline-separated), stock, weight_g, roast, origin, process,
 * attributes (object | JSON), active, featured, sort }. Rich text is sanitized here.
 */
export function createProduct(data) {
  const f = productFields(data);
  const slug = uniqueSlug(data.slug || f.title, (s) => slugTaken(s));
  const ts = now();
  const { lastInsertRowid } = run(
    `INSERT INTO products (category_id, slug, title, subtitle, description, details_html, price, old_price, images,
       stock, weight_g, roast, origin, process, attributes, active, featured, sort, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    f.category_id, slug, f.title, f.subtitle, f.description, f.details_html, f.price, f.old_price, f.images,
    f.stock, f.weight_g, f.roast, f.origin, f.process, f.attributes, f.active, f.featured, f.sort, ts, ts,
  );
  return getProduct(Number(lastInsertRowid));
}

/** Partial update: only the fields present in `data` change. */
export function updateProduct(id, data) {
  const row = get('SELECT * FROM products WHERE id = ?', Number(id));
  if (!row) throw notFound('Товар');
  const f = productFields(data, row);
  let slug = row.slug;
  if (data.slug && slugify(data.slug) !== row.slug) slug = uniqueSlug(data.slug, (s) => slugTaken(s, row.id));
  run(
    `UPDATE products SET category_id = ?, slug = ?, title = ?, subtitle = ?, description = ?, details_html = ?,
       price = ?, old_price = ?, images = ?, stock = ?, weight_g = ?, roast = ?, origin = ?, process = ?,
       attributes = ?, active = ?, featured = ?, sort = ?, updated_at = ? WHERE id = ?`,
    f.category_id, slug, f.title, f.subtitle, f.description, f.details_html, f.price, f.old_price, f.images,
    f.stock, f.weight_g, f.roast, f.origin, f.process, f.attributes, f.active, f.featured, f.sort, now(), row.id,
  );
  return getProduct(row.id);
}

/** Delete a product (order history keeps title/price snapshots). */
export function deleteProduct(id) {
  return run('DELETE FROM products WHERE id = ?', Number(id)).changes > 0;
}

/** Atomically change stock by delta (negative = sell). Never goes below 0. Returns new stock. */
export function adjustStock(productId, delta) {
  return tx(() => {
    run('UPDATE products SET stock = MAX(0, stock + ?), updated_at = ? WHERE id = ?', toInt(delta, 0), now(), Number(productId));
    return get('SELECT stock FROM products WHERE id = ?', Number(productId))?.stock ?? 0;
  });
}

/** Products with stock <= threshold (admin dashboard widget). */
export function lowStock(threshold = 5, limit = 10) {
  return all(`${PRODUCT_SELECT} WHERE p.active = 1 AND p.stock <= ? ORDER BY p.stock, p.title LIMIT ?`, threshold, limit).map(hydrateProduct);
}
