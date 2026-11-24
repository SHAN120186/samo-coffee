// Samo Coffee — progressive enhancement for the public site.
// Every feature here has a working no-JS fallback (plain links and form posts).
(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const csrfToken = () => $('meta[name="csrf-token"]')?.content || '';
  const formatSum = (n) => `${String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} сум`;

  // ── toasts ───────────────────────────────────────────────
  function toast(message, { type = 'info', link = null } = {}) {
    const host = $('[data-toasts]');
    if (!host || !message) return;
    const el = document.createElement('div');
    el.className = `toast${type === 'error' ? ' toast--error' : ''}`;
    const text = document.createElement('span');
    text.textContent = message;
    el.append(text);
    if (link) {
      const a = document.createElement('a');
      a.href = link.href;
      a.textContent = link.label;
      el.append(a);
    }
    host.append(el);
    while (host.children.length > 3) host.firstElementChild.remove();
    setTimeout(() => {
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), 320);
    }, 4200);
  }

  /** POST a form with fetch and expect the JSON contract { ok, message?, cart? }. */
  async function postForm(form) {
    const response = await fetch(form.getAttribute('action'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': csrfToken() },
      body: new URLSearchParams(new FormData(form)),
    });
    let data = null;
    try {
      data = await response.json();
    } catch { /* not JSON */ }
    if (!response.ok || !data || !data.ok) {
      const fallback = response.status === 403 ? 'Страница устарела — обновите её и попробуйте ещё раз.' : 'Не получилось. Попробуйте ещё раз.';
      throw new Error((data && data.message) || fallback);
    }
    return data;
  }

  // ── header ───────────────────────────────────────────────
  const header = $('[data-header]');
  if (header) {
    const onScroll = () => header.classList.toggle('is-stuck', window.scrollY > 8);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  const mnav = $('[data-mnav]');
  if (mnav) {
    const summary = $('summary', mnav);
    const close = () => {
      mnav.open = false;
    };
    mnav.addEventListener('toggle', () => summary.setAttribute('aria-expanded', String(mnav.open)));
    summary.setAttribute('aria-expanded', 'false');
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && mnav.open) {
        close();
        summary.focus();
      }
    });
    document.addEventListener('click', (event) => {
      if (mnav.open && !mnav.contains(event.target)) close();
    });
    window.matchMedia('(min-width: 64.01rem)').addEventListener('change', (event) => {
      if (event.matches) close();
    });
  }

  function setCartCount(count) {
    $$('[data-cart-count]').forEach((el) => {
      el.textContent = String(count);
      el.hidden = !count;
      el.classList.remove('is-bump');
      void el.offsetWidth; // restart the animation
      el.classList.add('is-bump');
    });
    $$('[data-cart-link]').forEach((a) => a.setAttribute('aria-label', `Корзина, товаров: ${count}`));
  }

  // ── quantity steppers ────────────────────────────────────
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-qty-dec], [data-qty-inc]');
    if (!button) return;
    const input = $('input', button.closest('[data-qty]'));
    if (!input) return;
    const min = Number(input.min || 1);
    const max = Number(input.max || 99);
    const current = Number.parseInt(input.value, 10) || min;
    const next = Math.min(max, Math.max(min, current + (button.hasAttribute('data-qty-inc') ? 1 : -1)));
    if (next === current && String(current) === input.value) {
      if (next === max && button.hasAttribute('data-qty-inc')) toast(`Больше нет в наличии: максимум ${max} шт.`);
      return;
    }
    input.value = String(next);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  document.addEventListener('change', (event) => {
    const input = event.target.closest('[data-qty] input');
    if (!input) return;
    const min = Number(input.min || 1);
    const max = Number(input.max || 99);
    const value = Number.parseInt(input.value, 10);
    input.value = String(Math.min(max, Math.max(min, Number.isFinite(value) ? value : min)));
  });

  // ── add to cart ──────────────────────────────────────────
  document.addEventListener('submit', async (event) => {
    const form = event.target.closest('form[data-cart-add]');
    if (!form) return;
    event.preventDefault();
    const button = $('button[type="submit"]', form);
    if (button.classList.contains('is-loading')) return;
    button.classList.add('is-loading');
    try {
      const data = await postForm(form);
      setCartCount(data.cart.count);
      toast(data.message, { link: { href: '/cart', label: 'Открыть корзину' } });
      const label = $('[data-cart-add-text]', form);
      const original = label ? label.textContent : '';
      if (label) label.textContent = 'Добавлено';
      button.classList.add('is-added');
      setTimeout(() => {
        button.classList.remove('is-added');
        if (label) label.textContent = original;
      }, 1800);
    } catch (error) {
      toast(error.message, { type: 'error' });
    } finally {
      button.classList.remove('is-loading');
    }
  });

  // ── cart page ────────────────────────────────────────────
  const cartRoot = $('[data-cart]');
  if (cartRoot) {
    const applyCart = (cart) => {
      setCartCount(cart.count);
      if (!cart.count) {
        window.location.reload();
        return;
      }
      const byId = new Map(cart.items.map((item) => [String(item.product_id), item]));
      $$('[data-cart-line]', cartRoot).forEach((line) => {
        const item = byId.get(line.dataset.cartLine);
        if (!item) {
          line.remove();
          return;
        }
        const input = $('[data-qty] input', line);
        if (input && document.activeElement !== input) input.value = String(item.qty);
        const total = $('[data-line-total]', line);
        if (total) total.textContent = item.line_total_text;
        const warn = $('[data-line-warn]', line);
        if (warn) {
          warn.hidden = item.available;
          if (!item.available) warn.textContent = item.stock > 0 ? `В наличии только ${item.stock} шт.` : 'Товар закончился';
        }
        line.classList.toggle('cart-line--unavailable', !item.available);
      });
      $$('[data-cart-text]').forEach((el) => {
        const value = cart.text[el.dataset.cartText];
        if (value !== undefined) el.textContent = value;
      });
      const freebar = $('[data-freebar]');
      if (freebar) {
        const freeFrom = Number(freebar.dataset.freeFrom) || 0;
        const text = $('[data-freebar-text]', freebar);
        text.textContent = '';
        const strong = document.createElement('strong');
        if (cart.free_delivery_left > 0) {
          text.append('До бесплатной доставки — ');
          strong.textContent = cart.text.free_delivery_left;
        } else {
          strong.textContent = 'Доставка по Ташкенту — бесплатно';
        }
        text.append(strong);
        $('[data-freebar-fill]', freebar).style.width = `${freeFrom ? Math.min(100, Math.round((cart.subtotal / freeFrom) * 100)) : 100}%`;
      }
      const alert = $('[data-cart-unavailable]');
      if (alert) alert.hidden = !cart.has_unavailable;
      const link = $('[data-checkout-link]');
      if (link) {
        if (cart.has_unavailable) link.setAttribute('aria-disabled', 'true');
        else link.removeAttribute('aria-disabled');
      }
    };

    const send = async (form) => {
      const line = form.closest('[data-cart-line]');
      if (line) line.classList.add('is-loading');
      try {
        const data = await postForm(form);
        applyCart(data.cart);
        if (data.message) toast(data.message);
      } catch (error) {
        toast(error.message, { type: 'error' });
      } finally {
        if (line) line.classList.remove('is-loading');
      }
    };

    const timers = new WeakMap();
    cartRoot.addEventListener('change', (event) => {
      const form = event.target.closest('form[data-cart-update]');
      if (!form) return;
      clearTimeout(timers.get(form));
      timers.set(form, setTimeout(() => send(form), 280));
    });
    cartRoot.addEventListener('submit', (event) => {
      const form = event.target.closest('form[data-cart-update], form[data-cart-remove]');
      if (!form) return;
      event.preventDefault();
      clearTimeout(timers.get(form));
      send(form);
    });
  }

  // ── checkout ─────────────────────────────────────────────
  const checkout = $('[data-checkout]');
  if (checkout) {
    const courierFee = Number(checkout.dataset.courierFee) || 0;
    const subtotal = Number(checkout.dataset.subtotal) || 0;
    const addressWrap = $('[data-address-wrap]', checkout);
    const sync = () => {
      const pickup = $('input[name="method"]:checked', checkout)?.value === 'pickup';
      if (addressWrap) {
        addressWrap.removeAttribute('data-hidden-initial');
        addressWrap.hidden = pickup;
      }
      const delivery = pickup ? 0 : courierFee;
      $$('[data-delivery]').forEach((el) => {
        el.textContent = delivery ? formatSum(delivery) : 'Бесплатно';
      });
      $$('[data-total]').forEach((el) => {
        el.textContent = formatSum(subtotal + delivery);
      });
    };
    checkout.addEventListener('change', (event) => {
      if (event.target.matches('[data-method]')) sync();
    });
    sync();
  }

  // Guard against double submits of order forms (and recover after bfcache restores).
  $$('.checkout__form').forEach((form) => {
    form.addEventListener('submit', () => {
      const button = $('button[type="submit"]', form);
      if (button) setTimeout(() => button.classList.add('is-loading'), 0);
    });
  });
  window.addEventListener('pageshow', () => $$('.checkout__form .is-loading').forEach((el) => el.classList.remove('is-loading')));

  // ── catalog toolbar ──────────────────────────────────────
  $$('form[data-autosubmit]').forEach((form) => {
    form.addEventListener('change', (event) => {
      if (event.target.matches('[data-autosubmit-on="change"]')) form.requestSubmit();
    });
  });

  // ── product gallery ──────────────────────────────────────
  $$('[data-gallery]').forEach((gallery) => {
    const main = $('[data-gallery-main]', gallery);
    gallery.addEventListener('click', (event) => {
      const thumb = event.target.closest('[data-gallery-thumb]');
      if (!thumb || !main) return;
      event.preventDefault();
      main.src = thumb.getAttribute('href');
      $$('[data-gallery-thumb]', gallery).forEach((el) => el.classList.toggle('is-active', el === thumb));
    });
  });

  // ── order status: refresh when the payment result arrives ─
  const poll = $('[data-order-poll]');
  if (poll) {
    const initial = poll.dataset.orderState;
    let attempts = 0;
    const tick = async () => {
      attempts += 1;
      try {
        const response = await fetch(poll.dataset.orderPoll, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
        const data = await response.json();
        if (data.ok && `${data.status}:${data.payment_status}` !== initial) {
          window.location.reload();
          return;
        }
      } catch { /* try again */ }
      if (attempts < 45) setTimeout(tick, 4000);
    };
    setTimeout(tick, 4000);
  }

  // ── reveal on scroll ─────────────────────────────────────
  const revealItems = $$('[data-reveal]');
  if (revealItems.length && 'IntersectionObserver' in window && !reducedMotion) {
    const viewport = window.innerHeight;
    // Whatever is already on screen stays as it is: no flash, no layout shift.
    revealItems.forEach((el) => {
      if (el.getBoundingClientRect().top < viewport * 0.92) el.classList.add('is-in');
    });
    document.documentElement.classList.add('reveal-ready');
    const observer = new IntersectionObserver((entries) => {
      let order = 0;
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.style.setProperty('--reveal-delay', `${Math.min(order, 4) * 80}ms`);
        entry.target.classList.add('is-in');
        observer.unobserve(entry.target);
        order += 1;
      });
    }, { rootMargin: '0px 0px -6% 0px' });
    revealItems.forEach((el) => {
      if (!el.classList.contains('is-in')) observer.observe(el);
    });
  }
})();
