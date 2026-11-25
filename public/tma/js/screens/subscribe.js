// Subscription checkout: plan summary + contact form → POST /subscribe → payment screen.
import { tg } from '../tg.js';
import { post } from '../api.js';
import { store, loadPlans } from '../store.js';
import { html, setHTML, icon, formatSum, sumHtml, rowsSkeleton, plural } from '../ui.js';
import { navigate } from '../router.js';
import { initialValues, field, contactFields, bindForm, showFieldErrors, rememberProfile, paymentCapabilities, paymentNote } from '../forms.js';

export const periodLabel = (days) => (days === 30 || days === 31 ? 'в месяц' : days === 7 ? 'в неделю' : days === 14 ? 'за 2 недели' : days === 90 ? 'за 3 месяца' : `за ${days} ${plural(days, ['день', 'дня', 'дней'])}`);

export default {
  tab: 'plans',
  focus: true,
  hideTitle: true, // the screen has its own heading
  title: 'Оформление подписки',
  parent: '/plans',

  async mount(ctx) {
    setHTML(ctx.el, html`<div class="screen">${rowsSkeleton(3, 'sk--card')}</div>`);
    const { items, subscription } = await loadPlans();
    if (!ctx.alive) return;
    const plan = items.find((p) => String(p.id) === ctx.params.id || p.slug === ctx.params.id);
    if (!plan) {
      navigate('/plans', { replace: true });
      return;
    }
    const renewing = subscription && subscription.plan_id === plan.id;
    const values = initialValues();
    let submitting = false;

    setHTML(ctx.el, html`
      <form class="screen" id="subscribe" novalidate>
        <h1 class="screen__title">${renewing ? 'Продление подписки' : 'Подписка'}</h1>

        <section class="card totals">
          <h2 class="card__title">Ваш план</h2>
          <div class="plan__head">
            <h3 class="plan__title">${plan.title}</h3>
            <div class="plan__price"><b>${sumHtml(plan.price)}</b><small>${periodLabel(plan.period_days)}</small></div>
          </div>
          ${plan.description ? html`<p class="plan__desc" style="margin-top:8px">${plan.description}</p>` : ''}
          ${renewing ? html`<p class="plan__desc" style="margin-top:8px">Оплаченный период добавится к текущему: +${plan.period_days} ${plural(plan.period_days, ['день', 'дня', 'дней'])}.</p>` : ''}
        </section>

        <section class="card">
          <h2 class="card__title">Получатель</h2>
          ${contactFields(values)}
          ${field({ name: 'address', label: 'Адрес доставки', value: values.address, textarea: true, placeholder: 'Улица, дом, квартира, ориентир', autocomplete: 'street-address', hint: 'Можно уточнить позже — менеджер свяжется перед первой доставкой' })}
        </section>

        <section class="card">
          <h2 class="card__title">Пожелания</h2>
          ${field({ name: 'comment', label: 'Помол, вкусы, удобные дни', value: values.comment, textarea: true, maxlength: 1000, placeholder: 'Например: под фильтр, люблю ягодные лоты' })}
        </section>

        ${paymentNote()}
        <div class="note">${icon('info')}<span>Автоматических списаний нет: когда период закончится, продлите подписку здесь в один тап.</span></div>
        <div class="alert alert--error" id="form-error" hidden></div>
      </form>`);

    const form = ctx.el.querySelector('#subscribe');
    const read = bindForm(form, () => ({ method: 'courier' }));
    const refresh = () => ctx.main({ text: `Оплатить · ${formatSum(plan.price)}`, enabled: !submitting, loading: submitting });

    const submit = async () => {
      if (submitting) return;
      const data = read();
      const errorBox = form.querySelector('#form-error');
      errorBox.hidden = true;
      submitting = true;
      refresh();
      try {
        const result = await post('/subscribe', {
          planId: plan.id,
          customer: { name: data.name, phone: data.phone },
          delivery: { method: 'courier', address: data.address },
          comment: data.comment,
          ...paymentCapabilities(),
        });
        rememberProfile({ ...data, method: store.boot.profile.delivery_method });
        store.payments.set(result.order.id, { invoiceLink: result.invoiceLink, redirectUrl: result.redirectUrl, error: result.paymentError });
        tg.haptic('success');
        navigate(`/pay/${result.order.id}`, { replace: true });
      } catch (err) {
        submitting = false;
        if (!ctx.alive) return;
        refresh();
        tg.haptic('error');
        if (err.code === 'validation' && showFieldErrors(form, err.fields)) return;
        errorBox.textContent = err.message;
        errorBox.hidden = false;
        errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    };

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submit();
    });

    tg.closingConfirmation(true);
    ctx.onCleanup(() => tg.closingConfirmation(false));
    ctx.main({ text: `Оплатить · ${formatSum(plan.price)}`, onClick: submit });
  },
};
