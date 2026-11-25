// Catalog browsing: categories → products of a category (paged) → product card with a photo.
import * as catalog from '../../services/catalog.js';
import * as analytics from '../../services/analytics.js';
import { formatSum } from '../../lib/money.js';
import { truncate } from '../../lib/escape.js';
import { cb, inline, shopButton, urlButton, siteUrl } from '../keyboards.js';
import { sendCard } from '../photos.js';
import { ack, show } from '../ui.js';
import * as texts from '../texts.js';

export const PAGE_SIZE = 6;

/** "☕ Каталог": the list of categories that have products. */
export async function showCategories(ctx) {
  const categories = catalog.listCategories().filter((c) => c.product_count > 0);
  const rows = [];
  for (let i = 0; i < categories.length; i += 2) {
    rows.push(categories.slice(i, i + 2).map((c) => cb(`${truncate(c.title, 24)} · ${c.product_count}`, `cat:${c.id}:0`)));
  }
  rows.push([shopButton()]);
  await ack(ctx);
  await show(ctx, texts.categoriesText(categories), inline(rows));
}

/** Products of one category, PAGE_SIZE per page. */
export async function showCategory(ctx, categoryId, page = 0) {
  const category = catalog.getCategory(Number(categoryId));
  if (!category || !category.active) {
    await ack(ctx, 'Этот раздел больше не доступен');
    return showCategories(ctx);
  }
  const { total } = catalog.listProducts({ categoryId: category.id, limit: 1 });
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  const { items } = catalog.listProducts({ categoryId: category.id, sort: 'popular', limit: PAGE_SIZE, offset: current * PAGE_SIZE });

  const rows = items.map((p) => [cb(texts.productButtonLabel(p), `p:${p.id}`)]);
  if (pages > 1) {
    rows.push([
      current > 0 ? cb('‹ Назад', `cat:${category.id}:${current - 1}`) : cb('·', 'noop'),
      cb(`${current + 1} / ${pages}`, 'noop'),
      current < pages - 1 ? cb('Дальше ›', `cat:${category.id}:${current + 1}`) : cb('·', 'noop'),
    ]);
  }
  rows.push([cb('← Все разделы', 'cats')]);
  await ack(ctx);
  await show(ctx, texts.categoryText(category, items, { page: current, pages, total }), inline(rows));
}

/** Find an active product by id or slug (deep links use slugs). */
export function findProduct(idOrSlug) {
  const key = String(idOrSlug ?? '').trim();
  const product = /^\d+$/.test(key) ? catalog.getProduct(Number(key)) : catalog.getProductBySlug(key);
  return product && product.active ? product : null;
}

/** Product card: photo + caption + "Купить". */
export async function showProduct(ctx, idOrSlug) {
  const product = findProduct(idOrSlug);
  if (!product) {
    await ack(ctx, 'Этот товар больше не продаётся', { alert: true });
    if (!ctx.callbackQuery) await showCategories(ctx);
    return;
  }
  await ack(ctx);
  analytics.trackEvent('view_product', { channel: 'bot', tgUserId: ctx.from.id, productId: product.id });
  const rows = [
    [product.in_stock ? cb(`🛒 Купить · ${formatSum(product.price)}`, `buy:${product.id}`) : cb('⛔️ Нет в наличии', 'noop')],
    [urlButton('Подробнее на сайте', siteUrl(product.url))],
    [product.category_id ? cb(`← ${truncate(product.category_title || 'Каталог', 28)}`, `cat:${product.category_id}:0`) : cb('← Каталог', 'cats')],
  ];
  await sendCard(ctx.api, ctx.chat.id, product.image, texts.productCard(product), { reply_markup: inline(rows) });
}
