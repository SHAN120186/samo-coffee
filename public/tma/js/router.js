// Hash router with history-aware back navigation.
//   routes:   '/', '/product/:id', …   (location.hash = '#/product/3')
//   screens:  { tab?, root?, focus?, title?, parent?, mount(ctx) }
// A screen receives ctx = { params, query, el, alive, onCleanup(fn), main(options), path }.
import { tg } from './tg.js';

const routes = [];
let current = null;
let index = 0;
let fallback = null;
let hooks = { before() {}, after() {}, error() {} };
const scrolls = new Map();
/** history index → path, to know where "back" would land */
const trail = new Map();

export function addRoute(pattern, screen) {
  const keys = [];
  const source = pattern.replace(/:[a-z]+/gi, (m) => {
    keys.push(m.slice(1));
    return '([^/]+)';
  });
  routes.push({ regex: new RegExp(`^${source}$`), keys, screen });
}

export function setFallback(screen) {
  fallback = screen;
}

function parseHash() {
  const hash = location.hash || '';
  if (!hash.startsWith('#/')) return { path: '/', query: new URLSearchParams() };
  const [path, qs = ''] = hash.slice(1).split('?');
  return { path: path.length > 1 ? path.replace(/\/+$/, '') : '/', query: new URLSearchParams(qs) };
}

function match(path) {
  for (const route of routes) {
    const m = route.regex.exec(path);
    if (m) {
      const params = {};
      route.keys.forEach((key, i) => {
        try {
          params[key] = decodeURIComponent(m[i + 1]);
        } catch {
          params[key] = m[i + 1];
        }
      });
      return { screen: route.screen, params };
    }
  }
  return fallback ? { screen: fallback, params: {} } : null;
}

async function render(direction) {
  const { path, query } = parseHash();
  const found = match(path);
  if (!found) return;

  if (current) {
    scrolls.set(current.index, window.scrollY);
    current.ctx.alive = false;
    for (const fn of current.ctx.cleanups.splice(0)) {
      try {
        fn();
      } catch (err) {
        console.error(err);
      }
    }
  }
  tg.setMain(null);

  const el = document.getElementById('view');
  const ctx = {
    path,
    params: found.params,
    query,
    el,
    alive: true,
    cleanups: [],
    onCleanup(fn) {
      this.cleanups.push(fn);
    },
    /** Set / update the primary action (Telegram MainButton or the in-page fallback). null hides it. */
    main(options) {
      if (this.alive) tg.setMain(options);
    },
  };
  current = { ctx, screen: found.screen, index, path };
  trail.set(index, path);

  hooks.before(found.screen, ctx);
  el.dataset.dir = direction;
  el.innerHTML = '';
  if (direction !== 'back') window.scrollTo(0, 0);

  try {
    await found.screen.mount(ctx);
    if (ctx.alive && direction === 'back' && scrolls.has(index)) window.scrollTo(0, scrolls.get(index));
  } catch (err) {
    if (ctx.alive) hooks.error(err, ctx, () => render('none'));
  }
  if (ctx.alive) hooks.after(found.screen, ctx);
}

/** Go to a route. replace=true swaps the current history entry (payment flow, redirects). */
export function navigate(path, { replace = false } = {}) {
  const target = `#${path}`;
  if (!replace && current && location.hash === target) return render('none');
  if (replace) {
    history.replaceState({ index }, '', target);
  } else {
    index += 1;
    history.pushState({ index }, '', target);
  }
  return render(replace ? 'none' : 'forward');
}

/** Back: one history step when we have one, otherwise to the screen's parent route. */
export function back() {
  const parent = (current && current.screen.parent) || '/';
  const previous = index > 0 ? trail.get(index - 1) : null;
  // Screens reached through a redirect (payment flow) must not step back into the finished checkout.
  if (current && current.screen.strictParent && previous !== parent) return navigate(parent, { replace: true });
  if (index > 0) return history.back();
  return navigate(parent, { replace: true });
}

export const currentPath = () => (current ? current.path : '/');
export const canGoBack = () => index > 0;

/** Re-run the current screen (after an error or a pull to refresh). */
export const reload = () => render('none');

/**
 * Start routing.
 * @param {{ initial?: string, before?: Function, after?: Function, error?: Function }} options
 *   initial — route to open when the URL has no "#/…" hash (deep links from start params)
 */
export function start({ initial = '/', before, after, error } = {}) {
  hooks = { before: before || hooks.before, after: after || hooks.after, error: error || hooks.error };
  index = history.state && Number.isInteger(history.state.index) ? history.state.index : 0;
  // Telegram passes launch params in the hash (#tgWebAppData=…); the bridge has already read them.
  const hasRoute = (location.hash || '').startsWith('#/');
  history.replaceState({ index }, '', hasRoute ? location.hash : `#${initial}`);

  window.addEventListener('popstate', (e) => {
    const next = e.state && Number.isInteger(e.state.index) ? e.state.index : 0;
    const direction = next < index ? 'back' : 'forward';
    index = next;
    render(direction);
  });

  // In-app links: <a href="#/cart">
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey) return;
    const link = e.target.closest('a[href^="#/"]');
    if (!link) return;
    e.preventDefault();
    navigate(link.getAttribute('href').slice(1), { replace: link.dataset.replace !== undefined });
  });

  return render('none');
}
