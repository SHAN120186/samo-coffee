// Checkout: contact + delivery form → POST /checkout → payment screen.
import { tg } from '../tg.js';
import { post } from '../api.js';
import { store, loadCart, setCart, track } from '../store.js';
import { html, setHTML, icon, formatSum, sumHtml, rowsSkeleton, toastError } from '../ui.js';
import { navigate } from '../router.js';
import { initialValues, field, contactFields, bindForm, showFieldErrors, rememberProfile, paymentCapabilities, paymentNote } from '../forms.js';

export default {
  tab: 'cart',
  focus: true,
  hideTitle: true, // the screen has its own heading
  title: 'Оформление',
  parent: '/cart',

  async mount(ctx) {
    setHTML(ctx.el, html`<div class="screen">${rowsSkeleton(3, 'sk--card')}</div>`);
    const cart = await loadCart();
    if (!ctx.alive) return;
    if (!cart.items.length || cart.has_unavailable) {
      navigate('/cart', { replace: true });
      return;
    }
    track('begin_checkout');

    const { settings } = store.boot;
    const values = initialValues();
    let method = values.method === 'pickup' ? 'pickup' : 'courier';
    let submitting = false;

    const fee = () => (method === 'pickup' ? 0 : cart.delivery_fee);
    const total = () => cart.subtotal + fee();

    setHTML(ctx.el, html`
      <form class="screen" id="checkout" novalidate>
        <h1 class="screen__title">Оформление</h1>

        <section class="card">
          <h2 class="card__title">Получатель</h2>
          ${contactFields(values)}
        </section>

        <section class="card">
          <h2 class="card__title">Доставка</h2>
          <div class="segmented" role="tablist">
            <button type="button" role="tab" data-method="courier" class="${method === 'courier' ? 'is-active' : ''}">Курьером</button>
            <button type="button" role="tab" data-method="pickup" class="${method === 'pickup' ? 'is-active' : ''}">Самовывоз</button>
          </div>
          <div id="courier" style="margin-top:12px" ${method === 'courier' ? '' : 'hidden'}>
            ${field({ name: 'address', label: 'Адрес', value: values.address, textarea: true, placeholder: 'Улица, дом, квартира, ориентир', autocomplete: 'street-address', hint: settings.delivery_note })}
          </div>
          <div class="pickup" id="pickup" ${method === 'pickup' ? '' : 'hidden'}>
            ${icon('pin')}<span><b>Заберите сами</b><br>${settings.pickup_address || settings.address}<br><span class="muted">${settings.work_hours}</span></span>
          </div>
        </section>

        <section class="card">
          <h2 class="card__title">Комментарий</h2>
          ${field({ name: 'comment', label: 'Пожелания к заказу', value: values.comment, textarea: true, maxlength: 1000, placeholder: 'Помол, удобное время, код домофона' })}
        </section>

        <section class="card totals">
          <h2 class="card__title">Ваш заказ</h2>
          <dl class="kv">
            ${cart.items.map((i) => html`<div><dt style="flex:1;min-width:0">${i.title} <span class="muted" style="white-space:nowrap">× ${i.qty}</span></dt><dd>${formatSum(i.line_total)}</dd></div>`)}
            <div><dt>Доставка</dt><dd id="fee"></dd></div>
          </dl>
          <div class="totals__sum"><span>К оплате</span><b id="total"></b></div>
        </section>

        ${paymentNote()}
        <div class="alert alert--error" id="form-error" hidden></div>
      </form>`);

    const form = ctx.el.querySelector('#checkout');
    const read = bindForm(form, () => ({ method }));

    const refresh = () => {
      form.querySelector('#fee').textContent = method === 'pickup' ? 'Самовывоз' : fee() ? formatSum(fee()) : 'Бесплатно';
      setHTML(form.querySelector('#total'), sumHtml(total()));
      ctx.main({ text: `Оплатить · ${formatSum(total())}`, enabled: !submitting, loading: submitting });
    };

    form.querySelector('.segmented').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-method]');
      if (!btn || btn.dataset.method === method) return;
      method = btn.dataset.method;
      tg.haptic('select');
      form.querySelectorAll('[data-method]').forEach((b) => b.classList.toggle('is-active', b === btn));
      form.querySelector('#courier').hidden = method !== 'courier';
      form.querySelector('#pickup').hidden = method !== 'pickup';
      refresh();
    });

    const submit = async () => {
      if (submitting) return;
      const data = read();
      const errorBox = form.querySelector('#form-error');
      errorBox.hidden = true;
      submitting = true;
      refresh();
      try {
        const result = await post('/checkout', {
          customer: { name: data.name, phone: data.phone },
          delivery: { method, address: data.address },
          comment: data.comment,
          ...paymentCapabilities(),
        });
        rememberProfile({ ...data, method });
        setCart({ count: 0, subtotal: 0, items: [], total: 0, delivery_fee: 0, free_delivery_left: 0, has_unavailable: false });
        store.payments.set(result.order.id, { invoiceLink: result.invoiceLink, redirectUrl: result.redirectUrl, error: result.paymentError });
        tg.haptic('success');
        navigate(`/pay/${result.order.id}`, { replace: true });
      } catch (err) {
        submitting = false;
        if (!ctx.alive) return;
        refresh();
        if (err.code === 'validation' && showFieldErrors(form, err.fields)) {
          tg.haptic('error');
          return;
        }
        if (err.code === 'empty_cart' || err.code === 'out_of_stock') {
          toastError(err);
          navigate('/cart', { replace: true });
          return;
        }
        tg.haptic('error');
        errorBox.textContent = err.message;
        errorBox.hidden = false;
        errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    };

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submit();
    });

    // Leaving the Mini App with a half-filled form asks for confirmation.
    tg.closingConfirmation(true);
    ctx.onCleanup(() => tg.closingConfirmation(false));

    ctx.main({ text: `Оплатить · ${formatSum(total())}`, onClick: submit });
    refresh();
  },
};
