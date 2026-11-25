// Product: artwork, facts, quantity stepper, MainButton "add to cart".
import { tg } from '../tg.js';
import { get } from '../api.js';
import { addToCart, track } from '../store.js';
import { html, raw, setHTML, formatSum, formatNumber, sumHtml, weight, stepper, bindSteppers, productCard, toast, toastError, plural } from '../ui.js';
import { navigate } from '../router.js';
import { quickAdd } from '../actions.js';

function skeleton() {
  return html`
    <div class="screen" aria-hidden="true">
      <span class="sk sk--media" style="border-radius:26px;aspect-ratio:1/0.92"></span>
      <div><span class="sk sk--line" style="width:30%"></span><span class="sk sk--title" style="margin-top:10px;height:28px;width:80%"></span><span class="sk sk--line" style="width:65%"></span></div>
      <span class="sk" style="height:44px;border-radius:14px"></span>
      <div class="facts"><span class="sk" style="height:56px;border-radius:16px"></span><span class="sk" style="height:56px;border-radius:16px"></span></div>
    </div>`;
}

export default {
  tab: 'home',
  focus: true,
  title: 'Товар',
  parent: '/',

  async mount(ctx) {
    setHTML(ctx.el, skeleton());
    const { product: p, related, inCart } = await get(`/products/${encodeURIComponent(ctx.params.id)}`);
    if (!ctx.alive) return;
    track('view_product', { productId: p.id });

    const max = Math.max(1, p.max_qty);
    let qty = 1;
    let added = inCart > 0 ? 'had' : '';

    const facts = [
      ['Обжарка', p.roast],
      ['Регион', p.origin],
      ['Обработка', p.process],
      ['Вес', weight(p.weight_g)],
    ].filter(([, value]) => value);
    const attributes = Object.entries(p.attributes || {}).filter(([k, v]) => k && v !== '' && v !== null);

    setHTML(ctx.el, html`
      <div class="screen screen--product">
        <div class="pmedia">
          <img src="${p.image}" alt="${p.title}" width="800" height="736" decoding="async">
          <div class="pmedia__badges">
            ${p.discount_percent ? html`<span class="badge badge--sale">−${p.discount_percent}%</span>` : ''}
            ${p.featured ? html`<span class="badge">Выбор обжарщика</span>` : ''}
          </div>
        </div>

        <header class="phead">
          <div class="phead__cat">${p.category_title}</div>
          <h1 class="phead__title">${p.title}</h1>
          ${p.subtitle ? html`<p class="phead__sub">${p.subtitle}</p>` : ''}
        </header>

        <div class="pbuy">
          <div class="pbuy__price">
            ${p.old_price ? html`<s>${formatNumber(p.old_price)} сум</s>` : ''}
            <b>${sumHtml(p.price)}</b>
          </div>
          ${p.in_stock ? stepper(qty, { min: 1, max, large: true, id: 'qty' }) : html`<span class="badge">Нет в наличии</span>`}
        </div>
        ${p.in_stock && p.low_stock ? html`<div class="pbuy__note pbuy__note--warn">Осталось всего ${p.max_qty} ${plural(p.max_qty, ['штука', 'штуки', 'штук'])}</div>` : ''}
        <div class="pbuy__note" id="in-cart" ${inCart ? '' : 'hidden'}>${inCart ? `В корзине уже ${inCart} шт.` : ''}</div>

        ${facts.length ? html`<div class="facts">${facts.map(([label, value]) => html`<div class="fact"><span>${label}</span><b title="${value}">${value}</b></div>`)}</div>` : ''}

        ${p.description ? html`<p class="pdesc">${p.description}</p>` : ''}

        ${attributes.length ? html`
          <section class="card">
            <h2 class="card__title">Характеристики</h2>
            <dl class="kv">${attributes.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>
          </section>` : ''}

        ${p.details_html ? html`<section class="prose">${raw(p.details_html)}</section>` : ''}

        ${related.length ? html`
          <section>
            <div class="section-head"><h2>Вам может понравиться</h2></div>
            <div class="grid2">${related.slice(0, 4).map(productCard)}</div>
          </section>` : ''}
      </div>`);

    const mainText = () => {
      if (!p.in_stock) return 'Нет в наличии';
      if (added === 'now') return 'Перейти в корзину';
      return `${added === 'had' ? 'Добавить ещё' : 'В корзину'} · ${formatSum(p.price * qty)}`;
    };
    const refreshMain = (extra = {}) => ctx.main({ text: mainText(), enabled: p.in_stock, loading: false, ...extra });

    const onMain = async () => {
      if (added === 'now') return navigate('/cart');
      refreshMain({ loading: true });
      try {
        const result = await addToCart(p.id, qty);
        if (!ctx.alive) return null;
        const line = result.cart.items.find((i) => i.product_id === p.id);
        const note = ctx.el.querySelector('#in-cart');
        if (line && note) {
          note.hidden = false;
          note.textContent = `В корзине ${line.qty} шт.`;
        }
        if (result.added) {
          tg.haptic('success');
          added = 'now';
          toast(result.added < qty ? `Добавили ${result.added} шт. — больше нет в наличии` : 'Добавили в корзину', { type: 'success' });
        } else {
          tg.haptic('warning');
          toast('В корзине уже максимум этого товара', { type: 'info' });
          added = 'now';
        }
      } catch (err) {
        toastError(err);
      }
      return refreshMain();
    };

    ctx.onCleanup(bindSteppers(ctx.el, (id, value) => {
      if (id !== 'qty') return;
      qty = value;
      if (added === 'now') added = 'had';
      refreshMain();
    }));

    ctx.el.querySelector('.screen').addEventListener('click', (e) => {
      const add = e.target.closest('[data-add]');
      if (!add) return;
      e.preventDefault();
      quickAdd(add);
    });

    ctx.main({ text: mainText(), onClick: onMain, enabled: p.in_stock });
  },
};
