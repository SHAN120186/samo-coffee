// Rendering helpers: escaped templates, icons, formatters, toasts, sheets, shared components.
import { tg } from './tg.js';

// ─────────────────────────────── templates

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

class Raw {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

/** Mark a string as trusted HTML (icons, server-sanitized rich text). */
export const raw = (value) => new Raw(String(value ?? ''));

function renderValue(value) {
  if (value instanceof Raw) return value.value;
  if (Array.isArray(value)) return value.map(renderValue).join('');
  if (value === null || value === undefined || value === false || value === true) return '';
  return esc(value);
}

/** Tagged template: every interpolation is HTML-escaped unless it is raw() / another html``. */
export function html(strings, ...values) {
  let out = '';
  for (let i = 0; i < strings.length; i += 1) {
    out += strings[i];
    if (i < values.length) out += renderValue(values[i]);
  }
  return new Raw(out);
}

export function setHTML(element, template) {
  element.innerHTML = String(template);
  return element;
}

// ─────────────────────────────── formatters

export const formatNumber = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
export const formatSum = (n) => `${formatNumber(n)} сум`;
/** "119 000 <small>сум</small>" */
export const sumHtml = (n) => html`${formatNumber(n)}<span class="cur">сум</span>`;

export function plural(n, forms) {
  const a = Math.abs(Number(n)) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

const fmt = (options) => new Intl.DateTimeFormat('ru-RU', options);
const DATE = fmt({ day: 'numeric', month: 'long' });
const DATE_YEAR = fmt({ day: 'numeric', month: 'long', year: 'numeric' });
const TIME = fmt({ hour: '2-digit', minute: '2-digit' });

export function formatDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.getFullYear() === new Date().getFullYear() ? DATE.format(d) : DATE_YEAR.format(d).replace(' г.', '');
}
export function formatTime(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : TIME.format(d);
}
export const formatDateTime = (value) => `${formatDate(value)}, ${formatTime(value)}`;

export function dayLabel(value) {
  const d = new Date(value);
  const today = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400000);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Вчера';
  return formatDate(value);
}

/** "+998901234567" → "+998 90 123 45 67" (other formats are returned as is). */
export function formatPhone(phone) {
  const m = /^\+998(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(String(phone || ''));
  return m ? `+998 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : String(phone || '');
}

/** Only http(s) links may come from settings into href attributes. */
export const safeUrl = (url) => (/^https?:\/\//i.test(String(url || '')) ? String(url) : '');

export const weight = (g) => (g ? (g >= 1000 ? `${String(g / 1000).replace('.', ',')} кг` : `${g} г`) : '');

// ─────────────────────────────── icons (24px stroke set)

const PATHS = {
  home: '<path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/>',
  bean: '<path d="M12 3c4.4 0 8 3.6 8 9s-3.6 9-8 9-8-3.6-8-9 3.6-9 8-9z"/><path d="M14.5 3.6c-3 2.6-.6 5.6-2.5 8.4s-4.6 3.1-4.3 8.2"/>',
  repeat: '<path d="M4 11V9.5A3.5 3.5 0 0 1 7.5 6H18"/><path d="m15.5 3 2.8 3-2.8 3"/><path d="M20 13v1.5A3.5 3.5 0 0 1 16.5 18H6"/><path d="m8.5 21-2.8-3 2.8-3"/>',
  bag: '<path d="M5.5 8h13l1 11.2a1.6 1.6 0 0 1-1.6 1.8H6.1a1.6 1.6 0 0 1-1.6-1.8z"/><path d="M8.8 10.5V7.2a3.2 3.2 0 0 1 6.4 0v3.3"/>',
  receipt: '<path d="M6 3.5h12v17l-2.4-1.6-2.4 1.6-2.4-1.6-2.4 1.6L6 20.5z"/><path d="M9.5 8.5h5M9.5 12h5"/>',
  chat: '<path d="M20 11.5a7.5 7.5 0 0 1-11.3 6.5L4 19.5l1.4-4.2A7.5 7.5 0 1 1 20 11.5z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  minus: '<path d="M5.5 12h13"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>',
  trash: '<path d="M5 7h14M10 7V4.8h4V7M7 7l.8 12.2h8.4L17 7"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  truck: '<path d="M3 6.5h10.5v9.5H3zM13.5 10h4l3 3v3h-7z"/><circle cx="7.5" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
  pin: '<path d="M12 21s6.5-5.6 6.5-11A6.5 6.5 0 0 0 5.5 10c0 5.4 6.5 11 6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  phone: '<path d="M6.5 3.5h3l1.5 4.2-2 1.5a11 11 0 0 0 5.8 5.8l1.5-2 4.2 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2z"/>',
  send: '<path d="M4.5 12 20 4.5 15.5 20l-3.2-6.3z"/><path d="m12.3 13.7 3.2-3.2"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.2"/>',
  alert: '<path d="M12 4 21 19.5H3z"/><path d="M12 10v4.5M12 17v.2"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  cup: '<path d="M5 9h11v5a5.5 5.5 0 0 1-11 0z"/><path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H15.5"/><path d="M8 3.5c0 1.2 1 1.3 1 2.5M11.5 3.5c0 1.2 1 1.3 1 2.5"/><path d="M4 20.5h13"/>',
  telegram: '<path d="M20.5 4.5 3.5 11l5 2 2 6 3-3.8 4.5 3.3z"/><path d="m8.5 13 8-5.5"/>',
  user: '<circle cx="12" cy="8.5" r="3.7"/><path d="M4.8 20a7.3 7.3 0 0 1 14.4 0"/>',
};

/** Inline SVG icon. */
export function icon(name, { size = 24, stroke = 1.8 } = {}) {
  return raw(`<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`);
}

// ─────────────────────────────── toasts

let toastTimer = null;

/** @param {string} text @param {{ type?: 'success'|'error'|'info', action?: { label: string, onClick: Function }, duration?: number }} [options] */
export function toast(text, { type = 'info', action = null, duration = 2600 } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return;
  host.innerHTML = '';
  clearTimeout(toastTimer);
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  setHTML(el, html`${type === 'success' ? icon('check', { stroke: 2.4 }) : type === 'error' ? icon('alert') : ''}<span class="toast__text">${text}</span>${action ? html`<button class="toast__action" type="button">${action.label}</button>` : ''}`);
  const dismiss = () => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 220);
  };
  if (action) {
    el.querySelector('.toast__action').addEventListener('click', () => {
      dismiss();
      action.onClick();
    });
  }
  el.addEventListener('click', (e) => {
    if (!e.target.closest('.toast__action')) dismiss();
  });
  host.append(el);
  toastTimer = setTimeout(dismiss, action ? Math.max(duration, 4000) : duration);
}

/** Remove visible toasts (called on navigation so a toast never covers the next screen's title). */
export function clearToasts() {
  clearTimeout(toastTimer);
  const host = document.getElementById('toasts');
  if (host) host.innerHTML = '';
}

export function toastError(err) {
  tg.haptic('error');
  toast(err && err.message ? err.message : 'Что-то пошло не так. Попробуйте ещё раз.', { type: 'error', duration: 3600 });
}

// ─────────────────────────────── confirm (native popup in Telegram, sheet in the browser)

/** @returns {Promise<boolean>} */
export function confirmAction({ title, text = '', okText = 'Да', cancelText = 'Отмена', destructive = false }) {
  if (tg.hasNativePopup) return tg.nativeConfirm({ title, text, okText, cancelText, destructive });
  return new Promise((resolve) => {
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    setHTML(scrim, html`
      <div class="sheet" role="dialog" aria-modal="true" aria-label="${title}">
        <h2 class="sheet__title">${title}</h2>
        ${text ? html`<p class="sheet__text">${text}</p>` : ''}
        <div class="sheet__actions">
          <button class="btn ${destructive ? 'btn--danger' : 'btn--primary'}" data-ok type="button">${okText}</button>
          <button class="btn btn--quiet" data-cancel type="button">${cancelText}</button>
        </div>
      </div>`);
    const done = (value) => {
      scrim.remove();
      resolve(value);
    };
    scrim.addEventListener('click', (e) => {
      if (e.target === scrim || e.target.closest('[data-cancel]')) done(false);
      else if (e.target.closest('[data-ok]')) done(true);
    });
    document.body.append(scrim);
    scrim.querySelector('[data-ok]').focus({ preventScroll: true });
  });
}

// ─────────────────────────────── shared components

export function stepper(qty, { min = 1, max = 20, large = false, id = '' } = {}) {
  return html`
    <div class="stepper ${large ? 'stepper--lg' : ''}" data-stepper="${id}" data-min="${min}" data-max="${max}">
      <button type="button" data-step="-1" aria-label="Меньше" ${qty <= min ? raw('disabled') : ''}>${qty <= 1 && min === 0 ? icon('trash') : icon('minus', { stroke: 2.2 })}</button>
      <output aria-live="polite">${qty}</output>
      <button type="button" data-step="1" aria-label="Больше" ${qty >= max ? raw('disabled') : ''}>${icon('plus', { stroke: 2.2 })}</button>
    </div>`;
}

export function priceBlock(p) {
  return html`<div class="pprice">${p.old_price ? html`<span class="price price--old">${formatNumber(p.old_price)}</span>` : ''}<span class="price">${sumHtml(p.price)}</span></div>`;
}

export function productCard(p) {
  return html`
    <article class="pcard ${p.in_stock ? '' : 'is-out'}">
      <a class="pcard__media" href="#/product/${p.id}" aria-label="${p.title}">
        <img src="${p.image}" alt="" loading="lazy" decoding="async" width="400" height="400">
        ${!p.in_stock ? html`<span class="badge pcard__badge pcard__badge--out">Нет в наличии</span>` : p.discount_percent ? html`<span class="badge pcard__badge">−${p.discount_percent}%</span>` : ''}
      </a>
      <div class="pcard__body">
        <a class="pcard__title" href="#/product/${p.id}">${p.title}</a>
        <div class="pcard__sub">${p.subtitle || p.category_title}</div>
        <div class="pcard__foot">
          ${priceBlock(p)}
          <button class="add-btn" type="button" data-add="${p.id}" aria-label="Добавить в корзину: ${p.title}" ${p.in_stock ? '' : raw('disabled')}>${icon('plus', { stroke: 2.4 })}</button>
        </div>
      </div>
    </article>`;
}

export function productGridSkeleton(count = 6) {
  return html`${Array.from({ length: count }, () => html`
    <div class="pcard" aria-hidden="true">
      <span class="sk sk--media"></span>
      <div class="pcard__body"><span class="sk sk--line" style="width:85%"></span><span class="sk sk--line" style="width:60%"></span><span class="sk sk--line" style="width:45%;height:18px;margin-top:14px"></span></div>
    </div>`)}`;
}

export function rowsSkeleton(count = 3, cls = 'sk--row') {
  return html`${Array.from({ length: count }, () => html`<span class="sk ${cls}" aria-hidden="true"></span>`)}`;
}

/** Full-screen state: icon + title + text + actions. tone: accent | success | danger | muted */
export function stateBlock({ iconName = 'cup', tone = 'accent', title, text = '', meta = '', actions = '', pop = false, ring = false }) {
  return html`
    <div class="state">
      <div class="state__art state__art--${tone} ${pop ? 'state__art--pop' : ''} ${ring ? 'state__ring' : ''}">${icon(iconName, { size: 44, stroke: pop ? 2.2 : 1.6 })}</div>
      <h1 class="state__title">${title}</h1>
      ${text ? html`<p class="state__text">${text}</p>` : ''}
      ${meta ? html`<div class="state__meta">${meta}</div>` : ''}
      ${actions ? html`<div class="state__actions">${actions}</div>` : ''}
    </div>`;
}

export function errorState(err, { retry = true } = {}) {
  return html`<div class="screen">${stateBlock({
    iconName: 'alert',
    tone: 'muted',
    title: err && err.status === 404 ? 'Не нашли' : 'Не получилось загрузить',
    text: err && err.message ? err.message : 'Проверьте соединение и попробуйте ещё раз.',
    actions: html`${retry && !(err && err.status === 404) ? html`<button class="btn btn--primary" type="button" data-retry>Повторить</button>` : ''}<a class="btn btn--ghost" href="#/">В каталог</a>`,
  })}</div>`;
}

const ORDER_BADGES = {
  new: 'warning', pending_payment: 'warning', paid: 'success', processing: 'info', shipped: 'info', delivered: 'success', cancelled: '', refunded: '',
};

export function orderBadge(order) {
  const failed = order.payment_status === 'failed' && order.can_pay;
  const tone = failed ? 'danger' : ORDER_BADGES[order.status] || '';
  const label = failed ? 'Оплата не прошла' : ['new', 'pending_payment'].includes(order.status) ? 'Ждёт оплаты' : order.status_label;
  return html`<span class="badge ${tone ? `badge--${tone}` : ''}">${label}</span>`;
}

/**
 * Delegate "+ / −" clicks of every stepper inside `root`. onChange(id, qty, element).
 * Returns an unbind function (pass it to ctx.onCleanup when `root` outlives the screen).
 */
export function bindSteppers(root, onChange) {
  const onClick = (e) => {
    const btn = e.target.closest('[data-step]');
    if (!btn || btn.disabled) return;
    const box = btn.closest('[data-stepper]');
    const out = box.querySelector('output');
    const min = Number(box.dataset.min);
    const max = Number(box.dataset.max);
    const next = Math.max(min, Math.min(max, Number(out.textContent) + Number(btn.dataset.step)));
    if (next === Number(out.textContent)) return;
    out.textContent = String(next);
    const [minus, plus] = box.querySelectorAll('[data-step]');
    minus.disabled = next <= min;
    plus.disabled = next >= max;
    if (min === 0) setHTML(minus, next <= 1 ? icon('trash') : icon('minus', { stroke: 2.2 }));
    tg.haptic('select');
    onChange(box.dataset.stepper, next, box);
  };
  root.addEventListener('click', onClick);
  return () => root.removeEventListener('click', onClick);
}
