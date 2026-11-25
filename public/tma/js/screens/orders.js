// My orders: list.
import { get } from '../api.js';
import { html, setHTML, formatSum, formatDate, rowsSkeleton, stateBlock, orderBadge, plural } from '../ui.js';

function card(order) {
  const thumbs = order.items.slice(0, 4);
  const rest = order.items.length - thumbs.length;
  const count = order.items.reduce((sum, item) => sum + item.qty, 0);
  return html`
    <a class="card ocard" href="#/orders/${order.id}">
      <div class="ocard__top">
        <div>
          <div class="ocard__num">${order.kind === 'subscription' ? 'Подписка' : 'Заказ'} ${order.number}</div>
          <div class="ocard__date">${formatDate(order.created_at)}</div>
        </div>
        ${orderBadge(order)}
      </div>
      <div class="ocard__foot">
        <div class="ocard__thumbs">${thumbs.map((item) => html`<img src="${item.image}" alt="" loading="lazy" width="88" height="88">`)}</div>
        <div class="ocard__items">${rest > 0 ? `+${rest} · ` : ''}${order.kind === 'subscription' ? order.items[0]?.title || '' : `${count} ${plural(count, ['товар', 'товара', 'товаров'])}`}</div>
        <div class="ocard__total">${formatSum(order.total)}</div>
      </div>
    </a>`;
}

export default {
  tab: 'orders',
  root: true,
  title: 'Заказы',

  async mount(ctx) {
    setHTML(ctx.el, html`<div class="screen"><h1 class="screen__title">Мои заказы</h1>${rowsSkeleton(3, 'sk--card')}</div>`);
    const { items } = await get('/orders');
    if (!ctx.alive) return;
    if (!items.length) {
      setHTML(ctx.el, html`<div class="screen">${stateBlock({
        iconName: 'receipt',
        title: 'Заказов пока нет',
        text: 'Здесь появятся ваши заказы и их статусы — от оплаты до доставки.',
        actions: html`<a class="btn btn--primary" href="#/">Выбрать кофе</a>`,
      })}</div>`);
      return;
    }
    setHTML(ctx.el, html`<div class="screen"><h1 class="screen__title">Мои заказы</h1>${items.map(card)}</div>`);
  },
};
