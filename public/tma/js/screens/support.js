// Support: the user's conversation with the team (feedback thread, channel "tma") + composer.
import { tg } from '../tg.js';
import { get, post } from '../api.js';
import { store } from '../store.js';
import { html, setHTML, icon, formatTime, dayLabel, rowsSkeleton, toastError, safeUrl } from '../ui.js';

const REFRESH_MS = 15000;

function bubbles(messages, freshFrom = Infinity) {
  let lastDay = '';
  return html`${messages.map((m) => {
    const day = dayLabel(m.created_at);
    const divider = day !== lastDay ? html`<div class="chat__day">${day}</div>` : '';
    lastDay = day;
    return html`${divider}
      <div class="bubble bubble--${m.direction === 'in' ? 'in' : 'out'} ${m.id >= freshFrom ? 'is-new' : ''}">${m.direction === 'out' ? html`<span class="bubble__who">Samo Coffee</span>` : ''}${m.text}<time>${m.pending ? 'Отправляем…' : formatTime(m.created_at)}</time></div>`;
  })}`;
}

export default {
  tab: 'support',
  root: true,
  title: 'Поддержка',

  async mount(ctx) {
    const { settings, texts, limits } = store.boot;
    setHTML(ctx.el, html`<div class="screen"><h1 class="screen__title">Поддержка</h1>${rowsSkeleton(2)}</div>`);
    let { messages } = await get('/feedback');
    if (!ctx.alive) return;

    const phoneHref = `tel:${String(settings.phone || '').replace(/[^\d+]/g, '')}`;
    setHTML(ctx.el, html`
      <div class="screen screen--support">
        <h1 class="screen__title">Поддержка</h1>
        <p class="screen__lead">${texts.support_intro || 'Напишите вопрос — ответим в чате с ботом.'}</p>
        <div class="contacts">
          ${settings.phone ? html`<a href="${phoneHref}">${icon('phone')}<span>${settings.phone}</span></a>` : ''}
          ${safeUrl(settings.social_telegram) ? html`<a href="${safeUrl(settings.social_telegram)}" target="_blank" rel="noopener" data-tg-link>${icon('telegram')}<span>Мы в Telegram</span></a>` : ''}
        </div>
        ${settings.work_hours ? html`<div class="note">${icon('clock')}<span>${settings.work_hours}. Ответ придёт сюда и в чат с ботом.</span></div>` : ''}
        <div class="chat" id="chat" aria-live="polite"></div>
      </div>
      <form class="composer" id="composer">
        <div class="composer__box">
          <textarea id="message" rows="1" maxlength="${limits.maxMessageLength}" placeholder="Ваш вопрос или пожелание" aria-label="Сообщение"></textarea>
          <button class="composer__send" type="submit" aria-label="Отправить" disabled>${icon('send', { stroke: 2 })}</button>
        </div>
      </form>`);

    const chat = ctx.el.querySelector('#chat');
    const form = ctx.el.querySelector('#composer');
    const input = ctx.el.querySelector('#message');
    const send = form.querySelector('.composer__send');
    let sending = false;

    const renderChat = (freshFrom) => {
      if (!messages.length) {
        setHTML(chat, html`<div class="empty"><b>Чем помочь?</b>Подскажем с выбором зерна, помолом, доставкой и подпиской.</div>`);
        return;
      }
      setHTML(chat, bubbles(messages, freshFrom));
    };
    const toBottom = (smooth = true) => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });

    const resize = () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(120, input.scrollHeight)}px`;
      send.disabled = sending || input.value.trim().length < 2;
    };
    input.addEventListener('input', resize);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) form.requestSubmit();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (sending || text.length < 2) return;
      sending = true;
      const optimistic = { id: Number.MAX_SAFE_INTEGER, direction: 'in', text, created_at: new Date().toISOString(), pending: true };
      const previous = messages;
      messages = [...messages, optimistic];
      renderChat(optimistic.id);
      input.value = '';
      resize();
      toBottom();
      tg.haptic('light');
      try {
        const data = await post('/feedback', { text });
        messages = data.messages;
        tg.haptic('success');
        if (ctx.alive) renderChat();
      } catch (err) {
        messages = previous;
        if (ctx.alive) {
          renderChat();
          input.value = text;
        }
        toastError(err);
      } finally {
        sending = false;
        if (ctx.alive) resize();
      }
    });

    // Telegram links open in Telegram itself, not in the in-app browser.
    ctx.el.querySelectorAll('[data-tg-link]').forEach((link) => link.addEventListener('click', (e) => {
      if (!tg.inTelegram) return;
      e.preventDefault();
      tg.openTelegramLink(link.href);
    }));

    // New answers appear without reopening the screen.
    const timer = setInterval(async () => {
      if (document.visibilityState !== 'visible' || sending) return;
      try {
        const data = await get('/feedback');
        if (!ctx.alive || sending) return;
        const lastId = messages.length ? messages[messages.length - 1].id : 0;
        const incoming = data.messages.filter((m) => m.id > lastId);
        if (incoming.length || data.messages.length !== messages.length) {
          messages = data.messages;
          renderChat(incoming.length ? incoming[0].id : undefined);
          if (incoming.some((m) => m.direction === 'out')) {
            tg.haptic('success');
            toBottom();
          }
        }
      } catch { /* try again on the next tick */ }
    }, REFRESH_MS);
    ctx.onCleanup(() => clearInterval(timer));

    renderChat();
    if (messages.length) requestAnimationFrame(() => toBottom(false));
  },
};
