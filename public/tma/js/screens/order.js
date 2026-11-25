// Order detail: status, items, totals, delivery; pay / cancel / repeat.
import { tg } from '../tg.js';
import { get, post } from '../api.js';
import { store, setCart } from '../store.js';
import { html, setHTML, icon, formatSum, formatNumber, sumHtml, formatDateTime, formatPhone, rowsSkeleton, orderBadge, toast, toastError, confirmAction } from '../ui.js';
import { navigate } from '../router.js';

const STEPS = {
  product: ['Оформлен', 'Оплачен', 'Собираем', 'В пути', 'Доставлен'],
  subscription: ['Оформлена', 'Оплачена', 'Активна'],
};
const PRODUCT_PROGRESS = { new: 1, pending_payment: 1, paid: 2, processing: 3, shipped: 4, delivered: 5 };

function describe(order) {
  const sub = order.kind === 'subscription';
  if (order.status === 'cancelled') return { title: sub ? 'Заявка отменена' : 'Заказ отменён', text: 'Если это ошибка — напишите нам, поможем оформить заново.' };
  if (order.status === 'refunded') return { title: 'Оплата возвращена', text: 'Деньги вернутся на карту в течение нескольких дней — срок зависит от банка.' };
  if (!order.is_paid) {
    if (order.payment_status === 'failed') return { title: 'Оплата не прошла', text: 'Деньги не списаны. Попробуйте оплатить ещё раз.' };
    return { title: 'Ждёт оплаты', text: sub ? 'Оплатите — и подписка начнёт действовать сразу.' : 'Оплатите заказ — и мы сразу начнём его собирать.' };
  }
  if (sub) return { title: 'Подписка оплачена', text: 'Период подписки уже идёт. Детали — во вкладке «Подписка».' };
  return {
    paid: { title: 'Заказ оплачен', text: 'Передали обжарщику. Сообщим в Telegram, когда отдадим курьеру.' },
    processing: { title: 'Собираем заказ', text: 'Фасуем и упаковываем — скоро передадим в доставку.' },
    shipped: { title: 'Заказ в пути', text: 'Курьер уже едет. Он позвонит перед приездом.' },
    delivered: { title: 'Заказ доставлен', text: 'Приятного кофе! Будем рады видеть вас снова.' },
  }[order.status] || { title: order.status_label, text: '' };
}

function steps(order) {
  if (['cancelled', 'refunded'].includes(order.status)) return '';
  const labels = STEPS[order.kind] || STEPS.product;
  const done = order.kind === 'subscription' ? (order.is_paid ? 3 : 1) : PRODUCT_PROGRESS[order.status] || 1;
  return html`
    <div class="steps" role="img" aria-label="Шаг ${done} из ${labels.length}">${labels.map((_, i) => html`<i class="${i < done ? 'is-done' : i === done ? 'is-now' : ''}"></i>`)}</div>
    <div class="steps__labels"><span>${labels[0]}</span><span>${labels[labels.length - 1]}</span></div>`;
}

export default {
  tab: 'orders',
  title: 'Заказ',
  parent: '/orders',
  strictParent: true,

  async mount(ctx) {
    setHTML(ctx.el, html`<div class="screen">${rowsSkeleton(3, 'sk--card')}</div>`);
    let { order } = await get(`/orders/${encodeURIComponent(ctx.params.id)}`);
    if (!ctx.alive) return;
    let busy = false;

    const render = () => {
      const d = describe(order);
      const address = order.delivery_method === 'pickup' ? store.boot.settings.pickup_address : order.delivery_address;
      setHTML(ctx.el, html`
        <div class="screen">
          <section class="card ostatus">
            <div class="ostatus__head">
              <div>
                <div class="muted" style="font-size:13px">${order.kind === 'subscription' ? 'Подписка' : 'Заказ'} ${order.number} · ${formatDateTime(order.created_at)}</div>
                <h1 class="ostatus__title" style="margin-top:4px">${d.title}</h1>
              </div>
              ${orderBadge(order)}
            </div>
            ${d.text ? html`<p class="ostatus__text">${d.text}</p>` : ''}
            ${steps(order)}
          </section>

          <section class="card card--flush lines">
            ${order.items.map((item) => html`
              <div class="line line--static">
                <span class="line__media"><img src="${item.image}" alt="" loading="lazy" width="96" height="96"></span>
                <div style="min-width:0">
                  <div class="line__title">${item.title}</div>
                  <div class="line__sub">${item.qty} × ${formatNumber(item.price)} сум</div>
                </div>
                <span class="line__sum">${formatSum(item.total)}</span>
              </div>`)}
          </section>

          <section class="card totals">
            <dl class="kv">
              <div><dt>Товары</dt><dd>${formatSum(order.subtotal)}</dd></div>
              ${order.kind === 'product' ? html`<div><dt>Доставка</dt><dd>${order.delivery_fee ? formatSum(order.delivery_fee) : order.delivery_method === 'pickup' ? 'Самовывоз' : 'Бесплатно'}</dd></div>` : ''}
              ${order.discount ? html`<div><dt>Скидка</dt><dd>−${formatSum(order.discount)}</dd></div>` : ''}
            </dl>
            <div class="totals__sum"><span>${order.is_paid ? 'Оплачено' : 'К оплате'}</span><b>${sumHtml(order.total)}</b></div>
          </section>

          <section class="card">
            <h2 class="card__title">Получение</h2>
            <dl class="kv">
              <div><dt>Способ</dt><dd>${order.delivery_method_label}</dd></div>
              ${address ? html`<div><dt>Адрес</dt><dd>${address}</dd></div>` : ''}
              <div><dt>Получатель</dt><dd>${order.customer_name}</dd></div>
              <div><dt>Телефон</dt><dd>${formatPhone(order.customer_phone)}</dd></div>
              ${order.comment ? html`<div><dt>Комментарий</dt><dd>${order.comment}</dd></div>` : ''}
            </dl>
          </section>

          <div style="display:grid;gap:8px">
            ${order.kind === 'product' ? html`<button class="btn btn--soft" type="button" data-act="repeat">${icon('repeat')}Повторить заказ</button>` : ''}
            <a class="btn btn--ghost" href="#/support">${icon('chat')}Написать в поддержку</a>
            ${order.can_cancel ? html`<button class="btn btn--danger-quiet" type="button" data-act="cancel">Отменить заказ</button>` : ''}
          </div>
        </div>`);

      if (order.can_pay) {
        ctx.main({ text: `Оплатить · ${formatSum(order.total)}`, enabled: true, loading: false, onClick: actions.pay });
      } else {
        ctx.main(null);
      }
    };

    const actions = {
      async pay() {
        if (busy) return;
        busy = true;
        ctx.main({ loading: true });
        try {
          const result = await post(`/orders/${order.id}/pay`, { invoice: tg.canInvoice, returnToApp: !tg.inTelegram });
          store.payments.set(result.order.id, { invoiceLink: result.invoiceLink, redirectUrl: result.redirectUrl });
          navigate(`/pay/${result.order.id}`);
        } catch (err) {
          toastError(err);
          try {
            ({ order } = await get(`/orders/${order.id}`));
          } catch { /* keep the current view */ }
          if (ctx.alive) render();
        } finally {
          busy = false;
        }
      },
      async cancel() {
        const sure = await confirmAction({ title: 'Отменить заказ?', text: `Заказ ${order.number} будет отменён. Это действие нельзя вернуть.`, okText: 'Отменить заказ', cancelText: 'Оставить', destructive: true });
        if (!sure || busy) return;
        busy = true;
        try {
          ({ order } = await post(`/orders/${order.id}/cancel`));
          tg.haptic('success');
          toast('Заказ отменён', { type: 'success' });
          if (ctx.alive) render();
        } catch (err) {
          toastError(err);
        } finally {
          busy = false;
        }
      },
      async repeat() {
        if (busy) return;
        busy = true;
        try {
          const result = await post(`/orders/${order.id}/repeat`);
          setCart(result.cart);
          tg.haptic('success');
          if (result.skipped.length) toast(`Добавили не всё: нет в наличии — ${result.skipped.join(', ')}`, { type: 'info', duration: 4000 });
          navigate('/cart');
        } catch (err) {
          toastError(err);
        } finally {
          busy = false;
        }
      },
    };

    const onClick = (e) => {
      const btn = e.target.closest('[data-act]');
      if (btn && actions[btn.dataset.act]) actions[btn.dataset.act]();
    };
    ctx.el.addEventListener('click', onClick);
    ctx.onCleanup(() => ctx.el.removeEventListener('click', onClick));

    // Coming back to the app refreshes the status (the order may have been paid or shipped meanwhile).
    const onVisible = async () => {
      if (document.visibilityState !== 'visible' || busy) return;
      try {
        const fresh = (await get(`/orders/${order.id}`)).order;
        if (ctx.alive && (fresh.status !== order.status || fresh.payment_status !== order.payment_status)) {
          order = fresh;
          render();
        }
      } catch { /* ignore */ }
    };
    document.addEventListener('visibilitychange', onVisible);
    ctx.onCleanup(() => document.removeEventListener('visibilitychange', onVisible));

    render();
  },
};
