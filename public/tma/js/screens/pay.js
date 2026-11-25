// Payment: opens the Telegram invoice (WebApp.openInvoice) or the hosted payment page,
// then follows the order status until the server confirms the payment.
import { tg } from '../tg.js';
import { get, post } from '../api.js';
import { store } from '../store.js';
import { html, setHTML, formatSum, stateBlock, toastError } from '../ui.js';
import { navigate } from '../router.js';

const POLL_MS = 2500;
const POLL_LIMIT_MS = 10 * 60 * 1000;

export default {
  tab: 'orders',
  focus: true,
  title: 'Оплата',
  parent: '/orders',
  strictParent: true,

  async mount(ctx) {
    const orderId = ctx.params.id;
    setHTML(ctx.el, html`<div class="screen">${stateBlock({ iconName: 'lock', ring: true, title: 'Готовим оплату', text: 'Секунду…' })}</div>`);

    let { order } = await get(`/orders/${encodeURIComponent(orderId)}`);
    if (!ctx.alive) return;

    let timer = null;
    let pollStarted = 0;
    let lastPayment = null; // { invoiceLink?, redirectUrl? } of the latest attempt
    let busy = false;
    let mainVisible = false;

    let pollRun = 0; // invalidates in-flight ticks when polling stops
    const stopPolling = () => {
      pollRun += 1;
      clearTimeout(timer);
      timer = null;
    };
    ctx.onCleanup(stopPolling);

    const isSubscription = order.kind === 'subscription';
    const meta = () => `Заказ ${order.number} · ${formatSum(order.total)}`;

    const show = (view) => {
      if (!ctx.alive) return;
      setHTML(ctx.el, html`<div class="screen">${stateBlock(view)}</div>`);
      ctx.el.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', () => actions[btn.dataset.act]()));
    };

    const showSuccess = () => {
      stopPolling();
      tg.haptic('success');
      if (isSubscription && store.boot) store.plans = null; // refresh the subscription card next time
      show({
        iconName: 'check',
        tone: 'success',
        pop: true,
        title: isSubscription ? 'Подписка оформлена' : 'Спасибо! Заказ оплачен',
        text: isSubscription
          ? 'Мы свяжемся, чтобы согласовать первую доставку. Статус подписки — во вкладке «Подписка».'
          : 'Уже передали обжарщику. О каждом шаге сообщим в чате с ботом.',
        meta: meta(),
        actions: html`<button class="btn btn--ghost" type="button" data-act="home">В каталог</button>`,
      });
      ctx.main({
        text: isSubscription ? 'Моя подписка' : 'Открыть заказ',
        enabled: true,
        loading: false,
        onClick: () => navigate(isSubscription ? '/plans' : `/orders/${order.id}`, { replace: true }),
      });
      mainVisible = true;
    };

    const showWaiting = (mode) => {
      show({
        iconName: 'lock',
        ring: true,
        title: mode === 'confirm' ? 'Подтверждаем оплату' : 'Ждём оплату',
        text: mode === 'confirm'
          ? 'Платёж принят — обновим статус через несколько секунд.'
          : mode === 'external'
            ? 'Страница оплаты открылась в браузере. После оплаты вернитесь сюда — статус обновится сам.'
            : 'Завершите оплату в окне Telegram.',
        meta: meta(),
        actions: html`
          ${mode === 'confirm' ? '' : html`<button class="btn btn--soft" type="button" data-act="reopen">Открыть оплату ещё раз</button>`}
          <button class="btn btn--quiet" type="button" data-act="later">Оплачу позже</button>`,
      });
      ctx.main(null);
      mainVisible = false;
    };

    const showUnpaid = (reason) => {
      stopPolling();
      const failed = reason === 'failed' || order.payment_status === 'failed';
      show({
        iconName: failed ? 'x' : 'clock',
        tone: failed ? 'danger' : 'accent',
        title: failed ? 'Оплата не прошла' : 'Заказ ждёт оплаты',
        text: failed
          ? 'Банк отклонил платёж или он был прерван. Деньги не списаны — попробуйте ещё раз.'
          : 'Мы сохранили заказ. Оплатите его сейчас или позже из раздела «Заказы».',
        meta: meta(),
        actions: html`<button class="btn btn--quiet" type="button" data-act="later">Оплачу позже</button>`,
      });
      ctx.main({ text: `${failed ? 'Попробовать снова' : 'Оплатить'} · ${formatSum(order.total)}`, enabled: true, loading: false, onClick: actions.retry });
      mainVisible = true;
    };

    const showClosed = () => {
      stopPolling();
      show({
        iconName: 'x',
        tone: 'muted',
        title: order.status === 'refunded' ? 'Оплата возвращена' : 'Заказ отменён',
        text: 'Этот заказ больше нельзя оплатить. Соберите новый в каталоге.',
        meta: `Заказ ${order.number}`,
        actions: html`<button class="btn btn--primary" type="button" data-act="home">В каталог</button>`,
      });
      ctx.main(null);
      mainVisible = false;
    };

    /** Decide which state matches the order. Returns true when the flow is finished. */
    const settle = () => {
      if (order.is_paid) return showSuccess() || true;
      if (!order.can_pay) return showClosed() || true;
      return false;
    };

    const refresh = async () => {
      const data = await get(`/orders/${encodeURIComponent(orderId)}`);
      order = data.order;
      return order;
    };

    const poll = () => {
      stopPolling();
      const run = pollRun;
      if (!pollStarted) pollStarted = Date.now();
      const tick = async () => {
        if (!ctx.alive || run !== pollRun) return;
        try {
          await refresh();
        } catch { /* offline for a moment — keep trying */ }
        if (!ctx.alive || run !== pollRun) return;
        if (settle()) return;
        if (order.payment_status === 'failed') return showUnpaid('failed');
        if (Date.now() - pollStarted > POLL_LIMIT_MS) return showUnpaid();
        timer = setTimeout(tick, POLL_MS);
      };
      timer = setTimeout(tick, POLL_MS);
    };

    const launch = async (payment) => {
      lastPayment = payment;
      pollStarted = 0;
      if (payment.invoiceLink && tg.canInvoice) {
        showWaiting('invoice');
        poll();
        const status = await tg.openInvoice(payment.invoiceLink);
        if (!ctx.alive || order.is_paid) return; // the poll may have confirmed the payment already
        if (status === 'paid') {
          // Telegram charged the card; the bot confirms it to the server a moment later.
          tg.haptic('success');
          showWaiting('confirm');
          poll();
        } else if (status === 'failed') {
          await refresh().catch(() => {});
          if (!settle()) showUnpaid('failed');
        } else if (status === 'cancelled') {
          await refresh().catch(() => {});
          if (!settle()) showUnpaid();
        } else if (status === 'unsupported') {
          tg.openTelegramLink(payment.invoiceLink);
          showWaiting('external');
          poll();
        }
        return;
      }
      const url = payment.redirectUrl || payment.invoiceLink;
      if (!url) return showUnpaid();
      if (tg.inTelegram) {
        // Hosted checkout opens in the browser; the Mini App stays open and watches the status.
        if (payment.redirectUrl) tg.openLink(url);
        else tg.openTelegramLink(url);
        showWaiting('external');
        poll();
      } else {
        // Browser preview: the hosted page returns to /tma/#/pay/<id>.
        showWaiting('external');
        location.href = url;
      }
      return null;
    };

    const actions = {
      home: () => navigate('/', { replace: true }),
      later: () => navigate(`/orders/${order.id}`, { replace: true }),
      reopen: () => (lastPayment ? launch(lastPayment) : actions.retry()),
      retry: async () => {
        if (busy) return;
        busy = true;
        if (mainVisible) ctx.main({ loading: true });
        try {
          const result = await post(`/orders/${order.id}/pay`, { invoice: tg.canInvoice, returnToApp: !tg.inTelegram });
          order = result.order;
          if (!ctx.alive) return;
          await launch({ invoiceLink: result.invoiceLink, redirectUrl: result.redirectUrl });
        } catch (err) {
          if (!ctx.alive) return;
          toastError(err);
          await refresh().catch(() => {});
          if (!settle()) showUnpaid();
        } finally {
          busy = false;
        }
      },
    };

    // Returning to the app (from the browser with the hosted page) → check right away.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && timer) {
        refresh().then(() => {
          if (ctx.alive && !settle() && order.payment_status === 'failed') showUnpaid('failed');
        }).catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    ctx.onCleanup(() => document.removeEventListener('visibilitychange', onVisible));

    if (settle()) return;
    const started = store.payments.get(order.id);
    store.payments.delete(order.id);
    if (started && (started.invoiceLink || started.redirectUrl)) {
      await launch(started);
    } else {
      if (started && started.error) toastError(started.error);
      showUnpaid();
    }
  },
};
