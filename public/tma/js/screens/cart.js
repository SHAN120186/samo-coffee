// Cart: lines with steppers, free-delivery progress, totals, MainButton "checkout".
import { tg } from '../tg.js';
import { store, loadCart, setCartQty } from '../store.js';
import { html, setHTML, icon, formatSum, formatNumber, sumHtml, weight, stepper, bindSteppers, rowsSkeleton, stateBlock, toastError, plural } from '../ui.js';
import { navigate } from '../router.js';

function line(item) {
  const max = Math.max(item.qty, Math.min(item.stock, store.boot.limits.maxQty));
  return html`
    <div class="line ${item.available ? '' : 'is-unavailable'}" data-line="${item.product_id}">
      <a class="line__media" href="#/product/${item.product_id}"><img src="${item.image}" alt="" loading="lazy" width="136" height="136"></a>
      <div style="min-width:0">
        <a class="line__title" href="#/product/${item.product_id}">${item.title}</a>
        <div class="line__sub">${[weight(item.weight_g), `${formatNumber(item.price)} сум`].filter(Boolean).join(' · ')}</div>
        ${item.available ? '' : html`<div class="line__warn">${item.stock > 0 ? `В наличии только ${item.stock} шт.` : 'Нет в наличии — уберите из корзины'}</div>`}
        <div class="line__foot">
          ${stepper(item.qty, { min: 0, max, id: item.product_id })}
          <span class="line__sum" data-sum>${formatSum(item.line_total)}</span>
        </div>
      </div>
    </div>`;
}

function shipping(cart) {
  const freeFrom = store.boot.settings.free_delivery_from;
  if (!freeFrom) return '';
  const left = cart.free_delivery_left;
  const percent = Math.max(4, Math.min(100, Math.round((cart.subtotal / freeFrom) * 100)));
  return html`
    <div class="card ship ${left ? '' : 'is-free'}">
      <div class="ship__text">${icon('truck')}<span>${left ? html`До бесплатной доставки — <b>${formatSum(left)}</b>` : html`<b>Доставка по Ташкенту бесплатно</b>`}</span></div>
      <div class="ship__bar"><i style="width:${percent}%"></i></div>
    </div>`;
}

function summary(cart) {
  return html`
    <div class="card totals">
      <dl class="kv">
        <div><dt>${cart.count} ${plural(cart.count, ['товар', 'товара', 'товаров'])}</dt><dd>${formatSum(cart.subtotal)}</dd></div>
        <div><dt>Доставка курьером</dt><dd>${cart.delivery_fee ? formatSum(cart.delivery_fee) : 'Бесплатно'}</dd></div>
      </dl>
      <div class="totals__sum"><span>Итого</span><b>${sumHtml(cart.total)}</b></div>
    </div>`;
}

export default {
  tab: 'cart',
  root: true,
  title: 'Корзина',

  async mount(ctx) {
    setHTML(ctx.el, html`<div class="screen"><h1 class="screen__title">Корзина</h1>${rowsSkeleton(3)}</div>`);
    let cart = await loadCart();
    if (!ctx.alive) return;

    const pending = new Map(); // productId → timer
    let busy = 0;

    const refreshMain = () => {
      if (!cart.items.length) return ctx.main(null);
      return ctx.main({
        text: `Оформить заказ · ${formatSum(cart.total)}`,
        enabled: !cart.has_unavailable && busy === 0,
        loading: false,
        onClick: () => {
          tg.haptic('light');
          navigate('/checkout');
        },
      });
    };

    const render = () => {
      if (!cart.items.length) {
        setHTML(ctx.el, html`<div class="screen">${stateBlock({
          iconName: 'bag',
          title: 'В корзине пока пусто',
          text: 'Выберите зерно или дрип-пакеты — обжарим и привезём свежими.',
          actions: html`<a class="btn btn--primary" href="#/">Перейти в каталог</a>`,
        })}</div>`);
        return refreshMain();
      }
      setHTML(ctx.el, html`
        <div class="screen">
          <h1 class="screen__title">Корзина</h1>
          ${cart.has_unavailable ? html`<div class="alert alert--warning">${icon('alert')}<span>Часть товаров закончилась. Уменьшите количество или уберите их, чтобы оформить заказ.</span></div>` : ''}
          <div class="card card--flush lines" id="lines">${cart.items.map(line)}</div>
          <div id="ship">${shipping(cart)}</div>
          <div id="summary">${summary(cart)}</div>
          ${store.boot.settings.delivery_note ? html`<div class="note">${icon('clock')}<span>${store.boot.settings.delivery_note}</span></div>` : ''}
        </div>`);
      return refreshMain();
    };

    /** Partial update after a quantity change: totals, per-line sums, removed lines. */
    const patch = () => {
      if (!cart.items.length || cart.has_unavailable || ctx.el.querySelector('.alert')) return render();
      const lines = ctx.el.querySelector('#lines');
      lines.querySelectorAll('[data-line]').forEach((node) => {
        const item = cart.items.find((i) => String(i.product_id) === node.dataset.line);
        if (!item) node.remove();
        else node.querySelector('[data-sum]').textContent = formatSum(item.line_total);
      });
      setHTML(ctx.el.querySelector('#ship'), shipping(cart));
      setHTML(ctx.el.querySelector('#summary'), summary(cart));
      return refreshMain();
    };

    const commit = async (productId, qty) => {
      busy += 1;
      refreshMain();
      try {
        cart = await setCartQty(productId, qty);
        if (qty === 0) tg.haptic('medium');
      } catch (err) {
        toastError(err);
        try {
          cart = await loadCart();
        } catch { /* keep the old view */ }
        busy -= 1;
        if (ctx.alive) render();
        return;
      }
      busy -= 1;
      if (ctx.alive && !pending.size) patch();
    };

    ctx.onCleanup(bindSteppers(ctx.el, (id, qty, box) => {
      const productId = Number(id);
      // Optimistic line total, then one request with the final quantity (taps are coalesced).
      const item = cart.items.find((i) => i.product_id === productId);
      const sum = box.closest('[data-line]').querySelector('[data-sum]');
      if (item && sum) sum.textContent = formatSum(item.price * qty);
      clearTimeout(pending.get(productId));
      pending.set(productId, setTimeout(() => {
        pending.delete(productId);
        commit(productId, qty);
      }, qty === 0 ? 0 : 320));
    }));

    ctx.onCleanup(() => {
      // Flush quantity changes that were still waiting for the debounce.
      for (const [productId, timer] of pending) {
        clearTimeout(timer);
        const box = ctx.el.querySelector(`[data-stepper="${productId}"] output`);
        if (box) setCartQty(productId, Number(box.textContent)).catch(() => {});
      }
      pending.clear();
    });

    render();
  },
};
