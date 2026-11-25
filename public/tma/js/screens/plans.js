// Subscription tab: the current subscription (status, renewal, pause) + plans.
import { tg } from '../tg.js';
import { post } from '../api.js';
import { store, loadPlans } from '../store.js';
import { html, setHTML, icon, sumHtml, formatDate, rowsSkeleton, toast, toastError, confirmAction, plural } from '../ui.js';
import { periodLabel } from './subscribe.js';

function subscriptionCard(sub) {
  const period = Math.max(1, sub.plan_period_days || 30);
  const percent = Math.max(4, Math.min(100, Math.round((sub.days_left / period) * 100)));
  const paused = sub.status === 'paused';
  return html`
    <section class="subcard" id="subcard">
      <div class="subcard__top">
        <span class="subcard__label">Ваша подписка</span>
        <span class="badge ${paused ? 'badge--warning' : 'badge--success'}">${sub.status_label}</span>
      </div>
      <h2 class="subcard__title">${sub.plan_title}</h2>
      <div class="subcard__meta">${paused ? 'Доставки приостановлены' : `Оплачено до ${formatDate(sub.current_period_end)}`} · ${sub.days_left} ${plural(sub.days_left, ['день', 'дня', 'дней'])}</div>
      <div class="subcard__bar"><i style="width:${percent}%"></i></div>
      <div class="subcard__actions">
        <a class="btn btn--primary btn--sm" href="#/subscribe/${sub.plan_id}">Продлить</a>
        <button class="btn btn--sm" type="button" data-sub="${paused ? 'resume' : 'pause'}">${paused ? 'Возобновить' : 'Пауза'}</button>
        <button class="btn btn--sm" type="button" data-sub="cancel">Отменить</button>
      </div>
    </section>`;
}

function planCard(plan, sub) {
  const current = sub && sub.plan_id === plan.id;
  return html`
    <article class="card plan ${current ? 'is-current' : ''}">
      <div class="plan__media">
        <img src="${plan.image}" alt="" loading="lazy" decoding="async" width="800" height="410">
        ${plan.badge ? html`<span class="badge plan__badge">${plan.badge}</span>` : ''}
      </div>
      <div class="plan__body">
        <div class="plan__head">
          <h2 class="plan__title">${plan.title}</h2>
          <div class="plan__price"><b>${sumHtml(plan.price)}</b><small>${periodLabel(plan.period_days)}</small></div>
        </div>
        ${plan.description ? html`<p class="plan__desc">${plan.description}</p>` : ''}
        ${plan.perks.length ? html`<ul class="perks">${plan.perks.map((perk) => html`<li>${icon('check', { size: 18, stroke: 2.2 })}<span>${perk}</span></li>`)}</ul>` : ''}
        <a class="btn ${current ? 'btn--soft' : 'btn--primary'} btn--block" href="#/subscribe/${plan.id}" style="margin-top:4px">${current ? 'Продлить этот план' : 'Оформить'}</a>
      </div>
    </article>`;
}

const CONFIRMS = {
  pause: { title: 'Поставить подписку на паузу?', text: 'Доставки остановятся, пока вы не возобновите подписку.', okText: 'Поставить на паузу', done: 'Подписка на паузе' },
  resume: { title: 'Возобновить подписку?', text: 'Доставки продолжатся по вашему плану.', okText: 'Возобновить', done: 'Подписка снова активна' },
  cancel: { title: 'Отменить подписку?', text: 'Доставки прекратятся. Оформить подписку заново можно в любой момент.', okText: 'Отменить подписку', destructive: true, done: 'Подписка отменена' },
};

export default {
  tab: 'plans',
  root: true,
  title: 'Подписка',

  async mount(ctx) {
    const texts = store.boot.texts || {};
    setHTML(ctx.el, html`<div class="screen"><h1 class="screen__title">Подписка на кофе</h1>${rowsSkeleton(2, 'sk--card')}</div>`);
    const { items } = await loadPlans({ fresh: true });
    if (!ctx.alive) return;

    const render = () => {
      const sub = store.boot.subscription;
      setHTML(ctx.el, html`
        <div class="screen">
          <h1 class="screen__title">Подписка на кофе</h1>
          ${sub ? subscriptionCard(sub) : html`<p class="screen__lead">${texts.subscription_empty || 'Свежий кофе будет приезжать сам — выберите план.'}</p>`}
          ${sub ? html`<div class="section-head" style="margin:6px 0 -8px"><h2>Все планы</h2></div>` : ''}
          ${items.length ? items.map((plan) => planCard(plan, sub)) : html`<div class="empty"><b>Планы скоро появятся</b>Мы обновляем подписку — загляните чуть позже.</div>`}
          <div class="note">${icon('info')}<span>Оплата за один период. Автоматических списаний нет — продлить можно в один тап.</span></div>
        </div>`);
    };

    ctx.el.addEventListener('click', onAction);
    ctx.onCleanup(() => ctx.el.removeEventListener('click', onAction));

    async function onAction(e) {
      const btn = e.target.closest('[data-sub]');
      if (!btn || btn.classList.contains('is-loading')) return;
      const action = btn.dataset.sub;
      const copy = CONFIRMS[action];
      if (!copy) return;
      tg.haptic('light');
      if (!(await confirmAction(copy))) return;
      btn.classList.add('is-loading');
      try {
        const data = await post(`/subscription/${action}`);
        store.boot.subscription = data.subscription;
        tg.haptic('success');
        toast(copy.done, { type: 'success' });
        if (ctx.alive) render();
      } catch (err) {
        btn.classList.remove('is-loading');
        toastError(err);
      }
    }

    render();
  },
};
