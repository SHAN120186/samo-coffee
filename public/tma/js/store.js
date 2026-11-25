// App state shared by the screens: bootstrap data, cart summary, small caches.
import { get, post, put, del } from './api.js';

const listeners = new Map();

export const store = {
  /** GET /bootstrap response */
  boot: null,
  /** { count, subtotal } — drives the tab badge */
  cart: { count: 0, subtotal: 0 },
  /** last full cart view from the API (or null) */
  cartView: null,
  /** product list cache: key → { items, total } */
  lists: new Map(),
  /** plans cache */
  plans: null,
  /** payments started in this session: orderId → { invoiceLink?, redirectUrl? } */
  payments: new Map(),

  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  },
  emit(event, payload) {
    (listeners.get(event) || []).forEach((fn) => {
      try {
        fn(payload);
      } catch (err) {
        console.error(err);
      }
    });
  },
};

export function setCart(view) {
  if (!view) return;
  const previous = store.cart.count;
  if (Array.isArray(view.items)) store.cartView = view;
  store.cart = { count: view.count || 0, subtotal: view.subtotal || 0 };
  store.emit('cart', { ...store.cart, previous });
}

export async function loadCart() {
  const { cart } = await get('/cart');
  setCart(cart);
  return cart;
}

export async function addToCart(productId, qty = 1) {
  const result = await post('/cart/items', { productId, qty });
  setCart(result.cart);
  return result;
}

export async function setCartQty(productId, qty) {
  const { cart } = qty > 0 ? await put(`/cart/items/${productId}`, { qty }) : await del(`/cart/items/${productId}`);
  setCart(cart);
  return cart;
}

/** Product list with a tiny in-memory cache (chips and back navigation feel instant). */
export async function loadProducts(params = {}) {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== '' && v !== undefined && v !== null && v !== false) query.set(k, v === true ? '1' : String(v));
  const key = query.toString();
  if (store.lists.has(key)) return store.lists.get(key);
  const data = await get(`/products${key ? `?${key}` : ''}`);
  if (store.lists.size > 40) store.lists.clear();
  store.lists.set(key, { items: data.items, total: data.total });
  return store.lists.get(key);
}

export const peekProducts = (params = {}) => {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== '' && v !== undefined && v !== null && v !== false) query.set(k, v === true ? '1' : String(v));
  return store.lists.get(query.toString()) || null;
};

export async function loadPlans({ fresh = false } = {}) {
  if (!store.plans || fresh) {
    const data = await get('/plans');
    store.plans = data.items;
    if (store.boot) store.boot.subscription = data.subscription;
  }
  return { items: store.plans, subscription: store.boot ? store.boot.subscription : null };
}

/** Fire-and-forget analytics event (tma_open, view_product, begin_checkout). */
export function track(name, data = {}) {
  post('/events', { name, ...data }).catch(() => {});
}
