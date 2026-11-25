// Samo Coffee Mini App — entry point: Telegram bridge, app chrome (tab bar, back button), routing.
import { tg } from './tg.js';
import { get, ApiError } from './api.js';
import { store, setCart, track } from './store.js';
import { addRoute, setFallback, start, navigate, back, reload } from './router.js';
import { html, setHTML, icon, errorState, stateBlock, clearToasts, safeUrl } from './ui.js';

import home from './screens/home.js';
import product from './screens/product.js';
import cart from './screens/cart.js';
import checkout from './screens/checkout.js';
import pay from './screens/pay.js';
import plans from './screens/plans.js';
import subscribe from './screens/subscribe.js';
import orders from './screens/orders.js';
import order from './screens/order.js';
import support from './screens/support.js';

const TABS = [
  { id: 'home', path: '/', label: 'Каталог', icon: 'bean' },
  { id: 'plans', path: '/plans', label: 'Подписка', icon: 'repeat' },
  { id: 'cart', path: '/cart', label: 'Корзина', icon: 'bag' },
  { id: 'orders', path: '/orders', label: 'Заказы', icon: 'receipt' },
  { id: 'support', path: '/support', label: 'Помощь', icon: 'chat' },
];

const view = document.getElementById('view');
const tabbar = document.getElementById('tabbar');
const topbar = document.getElementById('topbar');

// ─────────────────────────────── chrome

let lastScreen = null;

function renderTabbar() {
  setHTML(tabbar, html`${TABS.map((t) => html`
    <button class="tab" type="button" data-tab="${t.id}" data-path="${t.path}" aria-label="${t.label}">
      ${icon(t.icon)}<span>${t.label}</span>
      ${t.id === 'cart' ? html`<span class="tab__badge" id="cart-badge" hidden></span>` : ''}
    </button>`)}`);
  tabbar.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    tg.haptic('select');
    if (tab.classList.contains('is-active')) window.scrollTo({ top: 0, behavior: 'smooth' });
    navigate(tab.dataset.path);
  });
}

function updateBadge({ count, previous }) {
  const badge = document.getElementById('cart-badge');
  if (!badge) return;
  badge.hidden = !count;
  badge.textContent = count > 99 ? '99+' : String(count);
  if (count > (previous ?? 0)) {
    badge.classList.remove('is-bump');
    void badge.offsetWidth; // restart the animation
    badge.classList.add('is-bump');
  }
}

/** Runs before every screen: tab bar, back button, top bar. */
function applyChrome(screen) {
  const isRoot = Boolean(screen.root);
  if (screen !== lastScreen) clearToasts();
  lastScreen = screen;
  document.body.classList.toggle('no-tabs', Boolean(screen.focus));
  tabbar.hidden = Boolean(screen.focus);
  tabbar.querySelectorAll('.tab').forEach((tab) => {
    const active = tab.dataset.tab === screen.tab;
    tab.classList.toggle('is-active', active);
    if (active) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });

  // Telegram: native BackButton. Browser preview / old clients: in-page top bar.
  tg.setBack(!isRoot, back);
  const showTopbar = !isRoot && !tg.hasNativeBack;
  topbar.hidden = !showTopbar;
  document.body.classList.toggle('has-topbar', showTopbar);
  document.getElementById('topbar-title').textContent = screen.hideTitle ? '' : screen.title || '';
}

// ─────────────────────────────── boot

function deepLink() {
  // 1) Telegram start parameter (t.me/bot/app?startapp=…), 2) ?screen=… in the Mini App URL.
  let value = tg.startParam || '';
  if (!value) {
    try {
      value = new URLSearchParams(location.search).get('screen') || '';
    } catch { /* ignore */ }
  }
  value = String(value).slice(0, 80);
  let m;
  if ((m = /^(?:product|p)[_-]([a-z0-9-]{1,70})$/i.exec(value))) return `/product/${m[1].toLowerCase()}`;
  if ((m = /^order[_-](\d{1,12})$/i.exec(value))) return `/orders/${m[1]}`;
  if (/^(plans|subscription|subscribe)$/i.test(value)) return '/plans';
  if (/^(cart|orders|support)$/i.test(value)) return `/${value.toLowerCase()}`;
  return '/';
}

function renderGate(err) {
  tabbar.hidden = true;
  const unauthorized = err instanceof ApiError && err.status === 401;
  const botUrl = unauthorized && err.details ? safeUrl(err.details.botUrl) : '';
  setHTML(view, html`<div class="screen">${stateBlock(unauthorized ? {
    iconName: 'telegram',
    title: 'Откройте в Telegram',
    text: err.message || 'Мини-приложение Samo Coffee работает внутри Telegram.',
    actions: html`${botUrl ? html`<a class="btn btn--primary" href="${botUrl}" target="_blank" rel="noopener">Перейти к боту</a>` : ''}<a class="btn btn--ghost" href="/">Открыть сайт</a>`,
  } : {
    iconName: 'alert',
    tone: 'muted',
    title: 'Не получилось открыть магазин',
    text: err && err.message ? err.message : 'Проверьте соединение и попробуйте ещё раз.',
    actions: html`<button class="btn btn--primary" type="button" id="boot-retry">Повторить</button>`,
  })}</div>`);
  const retry = document.getElementById('boot-retry');
  if (retry) retry.addEventListener('click', () => location.reload());
}

async function boot() {
  tg.init();
  renderTabbar();
  document.getElementById('topbar-back').addEventListener('click', () => back());
  // Broken product images fall back to the neutral placeholder.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img && img.tagName === 'IMG' && !img.dataset.fallback) {
      img.dataset.fallback = '1';
      img.src = '/img/placeholder.svg';
    }
  }, true);

  try {
    store.boot = await get('/bootstrap');
  } catch (err) {
    renderGate(err);
    return;
  }
  store.on('cart', updateBadge);
  setCart(store.boot.cart);
  track('tma_open', { platform: tg.platform, version: tg.version });

  addRoute('/', home);
  addRoute('/product/:id', product);
  addRoute('/cart', cart);
  addRoute('/checkout', checkout);
  addRoute('/pay/:id', pay);
  addRoute('/plans', plans);
  addRoute('/subscribe/:id', subscribe);
  addRoute('/orders', orders);
  addRoute('/orders/:id', order);
  addRoute('/support', support);
  setFallback({
    title: 'Не найдено',
    mount(ctx) {
      setHTML(ctx.el, errorState({ status: 404, message: 'Такого экрана нет. Вернитесь в каталог.' }));
    },
  });

  tabbar.hidden = false;
  await start({
    initial: deepLink(),
    before: applyChrome,
    error(err, ctx, retry) {
      console.error(err);
      setHTML(ctx.el, errorState(err));
      const btn = ctx.el.querySelector('[data-retry]');
      if (btn) btn.addEventListener('click', retry);
    },
  });
}

// Android hardware "back" inside Telegram closes the app when there is no history — nothing to do here;
// the BackButton handler above covers in-app navigation.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) reload(); // restored from the back/forward cache (returning from a payment page)
});

boot();
