// Cart. ONE strategy for every channel:
//   site     → cart is addressed by a random token stored in the signed cookie "sc_cart"  → ref { token }
//   Mini App → cart is addressed by the Telegram user id                                  → ref { tgUserId }
// All functions take such a `ref` and return the same "cart view" object.
import crypto from 'node:crypto';
import { all, get, run, tx, now, parseJson } from '../db/index.js';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';
import * as settings from './settings.js';
import { PLACEHOLDER_IMAGE } from './catalog.js';

export const CART_COOKIE = 'sc_cart';
export const MAX_QTY_PER_ITEM = 20;

/** New random cart token. */
export function newToken() {
  return crypto.randomBytes(18).toString('base64url');
}

/**
 * Cart ref of a site request: reads the signed cookie; with create=true issues the cookie when missing.
 * Returns { token } or null (no cookie and create=false → treat as an empty cart).
 */
export function siteCartRef(req, res, { create = false } = {}) {
  let token = req.signedCookies?.[CART_COOKIE];
  if (!token || typeof token !== 'string' || token.length > 64) token = null;
  if (!token && create) {
    token = newToken();
    res.cookie(CART_COOKIE, token, {
      httpOnly: true, signed: true, sameSite: 'lax', secure: config.isHttps, path: '/', maxAge: 60 * 24 * 3600 * 1000,
    });
  }
  return token ? { token } : null;
}

function findCart(ref) {
  if (!ref) return null;
  if (ref.tgUserId) return get('SELECT * FROM carts WHERE tg_user_id = ?', Number(ref.tgUserId));
  if (ref.token) return get('SELECT * FROM carts WHERE token = ?', String(ref.token));
  return null;
}

function ensureCart(ref) {
  const existing = findCart(ref);
  if (existing) return existing;
  if (!ref || (!ref.tgUserId && !ref.token)) throw new AppError('validation', 'Корзина недоступна', 400);
  const { lastInsertRowid } = ref.tgUserId
    ? run('INSERT INTO carts (tg_user_id) VALUES (?)', Number(ref.tgUserId))
    : run('INSERT INTO carts (token) VALUES (?)', String(ref.token));
  return get('SELECT * FROM carts WHERE id = ?', Number(lastInsertRowid));
}

/**
 * Delivery fee for a subtotal: 0 for pickup, 0 when subtotal >= settings.free_delivery_from,
 * otherwise settings.delivery_fee.
 */
export function calcDelivery(subtotal, method = 'courier') {
  if (method === 'pickup' || subtotal <= 0) return 0;
  const freeFrom = settings.getInt('free_delivery_from', 0);
  if (freeFrom > 0 && subtotal >= freeFrom) return 0;
  return Math.max(0, settings.getInt('delivery_fee', 0));
}

const EMPTY = () => ({ id: null, items: [], count: 0, subtotal: 0, delivery_fee: 0, total: 0, free_delivery_left: 0, has_unavailable: false });

/**
 * Cart view:
 * {
 *   id, count (sum of qty), subtotal, delivery_fee (courier), total, free_delivery_left,
 *   has_unavailable (some item is inactive or exceeds stock),
 *   items: [{ product_id, slug, title, subtitle, image, price, old_price, qty, stock, line_total, available, url }]
 * }
 * Never throws for a missing cart — returns an empty view.
 */
export function getCart(ref) {
  const cart = findCart(ref);
  if (!cart) return EMPTY();
  const rows = all(
    `SELECT ci.product_id, ci.qty, p.slug, p.title, p.subtitle, p.images, p.price, p.old_price, p.stock, p.active, p.weight_g
       FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.cart_id = ? ORDER BY ci.added_at, ci.product_id`,
    cart.id,
  );
  const items = rows.map((r) => ({
    product_id: r.product_id,
    slug: r.slug,
    title: r.title,
    subtitle: r.subtitle,
    image: parseJson(r.images, [])[0] || PLACEHOLDER_IMAGE,
    price: r.price,
    old_price: r.old_price,
    weight_g: r.weight_g,
    qty: r.qty,
    stock: r.stock,
    line_total: r.price * r.qty,
    available: r.active === 1 && r.stock >= r.qty,
    url: `/catalog/${r.slug}`,
  }));
  const subtotal = items.reduce((s, i) => s + i.line_total, 0);
  const deliveryFee = calcDelivery(subtotal, 'courier');
  const freeFrom = settings.getInt('free_delivery_from', 0);
  return {
    id: cart.id,
    items,
    count: items.reduce((s, i) => s + i.qty, 0),
    subtotal,
    delivery_fee: deliveryFee,
    total: subtotal + deliveryFee,
    free_delivery_left: freeFrom > 0 && subtotal > 0 ? Math.max(0, freeFrom - subtotal) : 0,
    has_unavailable: items.some((i) => !i.available),
  };
}

/** Number of units in the cart (for the header badge). */
export function countItems(ref) {
  const cart = findCart(ref);
  if (!cart) return 0;
  return get('SELECT COALESCE(SUM(qty), 0) AS n FROM cart_items WHERE cart_id = ?', cart.id).n;
}

function loadProductForCart(productId) {
  const p = get('SELECT id, title, stock, active FROM products WHERE id = ?', Number(productId));
  if (!p || !p.active) throw new AppError('not_found', 'Товар не найден или снят с продажи', 404);
  return p;
}

/**
 * Add qty of a product (default 1). Quantity is clamped to stock and MAX_QTY_PER_ITEM.
 * Throws AppError('out_of_stock') when the product has no stock. Returns the cart view.
 */
export function addItem(ref, productId, qty = 1) {
  const add = Math.max(1, Number.parseInt(qty, 10) || 1);
  return tx(() => {
    const product = loadProductForCart(productId);
    if (product.stock <= 0) throw new AppError('out_of_stock', `«${product.title}» закончился`, 409);
    const cart = ensureCart(ref);
    const current = get('SELECT qty FROM cart_items WHERE cart_id = ? AND product_id = ?', cart.id, product.id)?.qty || 0;
    const next = Math.min(current + add, product.stock, MAX_QTY_PER_ITEM);
    run(
      `INSERT INTO cart_items (cart_id, product_id, qty) VALUES (?, ?, ?)
       ON CONFLICT(cart_id, product_id) DO UPDATE SET qty = excluded.qty`,
      cart.id, product.id, next,
    );
    run('UPDATE carts SET updated_at = ? WHERE id = ?', now(), cart.id);
    return getCart(ref);
  });
}

/** Set the exact quantity (0 or less removes the line). Clamped to stock. Returns the cart view. */
export function setQty(ref, productId, qty) {
  const wanted = Number.parseInt(qty, 10) || 0;
  return tx(() => {
    const cart = findCart(ref);
    if (!cart) return EMPTY();
    if (wanted <= 0) {
      run('DELETE FROM cart_items WHERE cart_id = ? AND product_id = ?', cart.id, Number(productId));
    } else {
      const product = loadProductForCart(productId);
      const next = Math.min(wanted, Math.max(product.stock, 1), MAX_QTY_PER_ITEM);
      run(
        `INSERT INTO cart_items (cart_id, product_id, qty) VALUES (?, ?, ?)
         ON CONFLICT(cart_id, product_id) DO UPDATE SET qty = excluded.qty`,
        cart.id, product.id, next,
      );
    }
    run('UPDATE carts SET updated_at = ? WHERE id = ?', now(), cart.id);
    return getCart(ref);
  });
}

/** Remove a line. Returns the cart view. */
export function removeItem(ref, productId) {
  return setQty(ref, productId, 0);
}

/** Remove all lines. */
export function clearCart(ref) {
  const cart = findCart(ref);
  if (cart) run('DELETE FROM cart_items WHERE cart_id = ?', cart.id);
  return EMPTY();
}
