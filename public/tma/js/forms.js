// Customer form shared by the checkout and the subscription screens.
import { tg } from './tg.js';
import { store } from './store.js';
import { html, icon, toast, formatPhone } from './ui.js';

const DRAFT_KEY = 'tma.customer';

function readDraft() {
  try {
    return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

export function saveDraft(values) {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(values));
  } catch { /* storage may be unavailable */ }
}

/** Prefill: what the user typed in this session → last order / customer profile → Telegram name. */
export function initialValues() {
  const profile = (store.boot && store.boot.profile) || {};
  const draft = readDraft();
  return {
    name: draft.name ?? profile.name ?? '',
    phone: draft.phone ?? formatPhone(profile.phone) ?? '',
    address: draft.address ?? profile.address ?? '',
    method: draft.method ?? profile.delivery_method ?? 'courier',
    comment: draft.comment ?? '',
  };
}

export function field({ name, label, value = '', type = 'text', placeholder = '', autocomplete = 'off', inputmode = '', hint = '', textarea = false, maxlength = 300, after = '' }) {
  const control = textarea
    ? html`<textarea class="textarea" id="f-${name}" name="${name}" rows="2" maxlength="${maxlength}" placeholder="${placeholder}" autocomplete="${autocomplete}">${value}</textarea>`
    : html`<input class="input" id="f-${name}" name="${name}" type="${type}" value="${value}" maxlength="${maxlength}" placeholder="${placeholder}" autocomplete="${autocomplete}" ${inputmode ? html`inputmode="${inputmode}"` : ''}>`;
  return html`
    <div class="field" data-field="${name}">
      <label class="field__label" for="f-${name}">${label}</label>
      ${after ? html`<div class="field__row">${control}${after}</div>` : control}
      ${hint ? html`<div class="field__hint">${hint}</div>` : ''}
      <div class="field__error" hidden></div>
    </div>`;
}

export function contactFields(values) {
  return html`
    ${field({ name: 'name', label: 'Имя', value: values.name, placeholder: 'Как к вам обращаться', autocomplete: 'name', maxlength: 120 })}
    ${field({
      name: 'phone', label: 'Телефон', value: values.phone, type: 'tel', inputmode: 'tel', placeholder: '+998 90 123 45 67', autocomplete: 'tel', maxlength: 40,
      after: tg.canRequestContact ? html`<button class="contact-btn" type="button" data-share-phone aria-label="Взять номер из Telegram" title="Взять номер из Telegram">${icon('telegram')}</button>` : '',
      hint: tg.canRequestContact ? 'Нажмите на самолётик, чтобы подставить номер из Telegram' : '',
    })}`;
}

/** Wire the "share phone" button and the draft autosave. Returns a function that reads the values. */
export function bindForm(root, getExtra = () => ({})) {
  const read = () => {
    const value = (name) => {
      const el = root.querySelector(`[name="${name}"]`);
      return el ? el.value.trim() : '';
    };
    return { name: value('name'), phone: value('phone'), address: value('address'), comment: value('comment'), ...getExtra() };
  };

  root.addEventListener('input', (e) => {
    const box = e.target.closest('.field');
    if (box) clearFieldError(box);
    saveDraft(read());
  });

  const share = root.querySelector('[data-share-phone]');
  if (share) {
    share.addEventListener('click', async () => {
      tg.haptic('light');
      const phone = await tg.requestContact();
      const input = root.querySelector('[name="phone"]');
      if (phone && input) {
        input.value = phone;
        clearFieldError(input.closest('.field'));
        saveDraft(read());
        tg.haptic('success');
      } else if (!phone) {
        toast('Не получили номер — введите его вручную', { type: 'info' });
      }
    });
  }
  return read;
}

function clearFieldError(box) {
  box.classList.remove('field--invalid');
  const error = box.querySelector('.field__error');
  if (error) error.hidden = true;
}

/** Show server-side validation messages next to the fields; focuses the first invalid one. */
export function showFieldErrors(root, fields = {}) {
  let first = null;
  for (const [name, message] of Object.entries(fields)) {
    const box = root.querySelector(`[data-field="${name}"]`);
    if (!box) continue;
    box.classList.add('field--invalid');
    const error = box.querySelector('.field__error');
    if (error) {
      error.textContent = message;
      error.hidden = false;
    }
    first = first || box;
  }
  if (first) {
    first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const control = first.querySelector('input, textarea');
    if (control) control.focus({ preventScroll: true });
  }
  return Boolean(first);
}

/** Remember what the customer entered for the next order of this session. */
export function rememberProfile(values) {
  if (!store.boot) return;
  store.boot.profile = {
    ...store.boot.profile,
    name: values.name || store.boot.profile.name,
    phone: values.phone || store.boot.profile.phone,
    address: values.address || store.boot.profile.address,
    delivery_method: values.method || store.boot.profile.delivery_method,
  };
  saveDraft({ ...values, comment: '' });
}

/** What the client can do with a payment: native invoice inside Telegram, hosted page otherwise. */
export const paymentCapabilities = () => ({ invoice: tg.canInvoice, returnToApp: !tg.inTelegram });

export function paymentNote() {
  const native = store.boot && store.boot.payments.invoice && tg.canInvoice;
  return html`<div class="note">${icon('lock')}<span>${native ? 'Оплата картой прямо в Telegram — данные карты видит только платёжный сервис.' : 'Оплата картой на защищённой странице платёжного сервиса.'}</span></div>`;
}
