// Defensive wrapper around Telegram.WebApp.
// Inside Telegram it drives the native UI (MainButton, BackButton, haptics, popups, invoices);
// in a regular browser (dev preview) every call degrades to an in-page fallback or a no-op.

const wa = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
const initData = wa && typeof wa.initData === 'string' ? wa.initData : '';
const inTelegram = initData.length > 0;

const BRAND_ACCENT = '#b84a24';
const BRAND_ACCENT_DARK = '#d0643a';

const THEME_KEYS = [
  'bg_color', 'text_color', 'hint_color', 'link_color', 'button_color', 'button_text_color', 'secondary_bg_color',
  'header_bg_color', 'bottom_bar_bg_color', 'accent_text_color', 'section_bg_color', 'section_header_text_color',
  'section_separator_color', 'subtitle_text_color', 'destructive_text_color',
];

/** Theme presets for the browser preview: /tma/?theme=dark | light | brand */
const PREVIEW_THEMES = {
  dark: {
    bg_color: '#212121', secondary_bg_color: '#0f0f0f', text_color: '#ffffff', hint_color: '#aaaaaa', link_color: '#8774e1',
    button_color: '#8774e1', button_text_color: '#ffffff', header_bg_color: '#212121', bottom_bar_bg_color: '#0f0f0f',
    accent_text_color: '#8774e1', section_bg_color: '#212121', section_header_text_color: '#aaaaaa',
    section_separator_color: '#000000', subtitle_text_color: '#aaaaaa', destructive_text_color: '#e53935',
  },
  light: {
    bg_color: '#ffffff', secondary_bg_color: '#efeff4', text_color: '#000000', hint_color: '#8e8e93', link_color: '#007aff',
    button_color: '#007aff', button_text_color: '#ffffff', header_bg_color: '#f8f8f8', bottom_bar_bg_color: '#ffffff',
    accent_text_color: '#007aff', section_bg_color: '#ffffff', section_header_text_color: '#6d6d72',
    section_separator_color: '#c8c7cc', subtitle_text_color: '#8e8e93', destructive_text_color: '#ff3b30',
  },
};

const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

function isDark(hex) {
  if (!isHex(hex)) return false;
  const n = Number.parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

function atLeast(version) {
  if (!inTelegram) return false;
  try {
    return typeof wa.isVersionAtLeast === 'function' ? wa.isVersionAtLeast(version) : false;
  } catch {
    return false;
  }
}

/** Run a WebApp call that may be missing or unsupported in the current client. */
function attempt(fn, fallback) {
  try {
    return fn();
  } catch (err) {
    return typeof fallback === 'function' ? fallback(err) : fallback;
  }
}

// ─────────────────────────────── theme

let scheme = 'light';
const themeListeners = new Set();

function previewThemeName() {
  let name = '';
  try {
    name = new URLSearchParams(location.search).get('theme') || '';
    if (name) sessionStorage.setItem('tma.previewTheme', name);
    else name = sessionStorage.getItem('tma.previewTheme') || '';
  } catch { /* storage may be blocked */ }
  return name;
}

function applyTheme() {
  const root = document.documentElement;
  let params = null;
  if (inTelegram) params = wa.themeParams || {};
  else if (PREVIEW_THEMES[previewThemeName()]) params = PREVIEW_THEMES[previewThemeName()];

  for (const key of THEME_KEYS) {
    const name = `--tg-theme-${key.replace(/_/g, '-')}`;
    if (params && isHex(params[key])) root.style.setProperty(name, params[key]);
    else if (!inTelegram) root.style.removeProperty(name);
  }
  if (params) root.dataset.tg = '1';
  else delete root.dataset.tg;

  const bg = params ? params.secondary_bg_color || params.bg_color : '';
  scheme = params ? (inTelegram && wa.colorScheme ? wa.colorScheme : isDark(bg) ? 'dark' : 'light') : 'light';
  root.dataset.scheme = scheme;

  if (inTelegram) {
    // Telegram chrome follows the page background; the brand accent stays on the main button.
    if (atLeast('6.1')) {
      attempt(() => wa.setHeaderColor('secondary_bg_color'));
      attempt(() => wa.setBackgroundColor('secondary_bg_color'));
    }
    if (atLeast('7.10')) attempt(() => wa.setBottomBarColor(params.section_bg_color || params.bg_color || '#ffffff'));
    main.refreshColors();
  }
  themeListeners.forEach((fn) => attempt(() => fn(scheme)));
}

// ─────────────────────────────── main button

const fallbackBar = () => document.getElementById('mainbar');
const fallbackBtn = () => document.getElementById('mainbar-btn');
const fallbackText = () => document.getElementById('mainbar-text');

const main = {
  handler: null,
  state: null,
  bound: false,

  bind() {
    if (this.bound) return;
    this.bound = true;
    const fire = () => {
      if (this.handler && this.state && this.state.enabled !== false && !this.state.loading) this.handler();
    };
    if (inTelegram) attempt(() => wa.MainButton.onClick(fire));
    else fallbackBtn()?.addEventListener('click', fire);
  },

  refreshColors() {
    if (!inTelegram || !this.state) return;
    attempt(() => wa.MainButton.setParams({ color: scheme === 'dark' ? BRAND_ACCENT_DARK : BRAND_ACCENT, text_color: '#ffffff' }));
  },

  /** @param {{ text: string, onClick: Function, enabled?: boolean, loading?: boolean } | null} options */
  set(options) {
    this.bind();
    if (!options) {
      this.handler = null;
      this.state = null;
      if (inTelegram) {
        attempt(() => wa.MainButton.hideProgress());
        attempt(() => wa.MainButton.hide());
      } else {
        const bar = fallbackBar();
        if (bar) bar.hidden = true;
        document.body.classList.remove('has-mainbar');
      }
      return;
    }
    const next = { enabled: true, loading: false, ...(this.state || {}), ...options };
    this.state = next;
    this.handler = next.onClick || null;
    const active = next.enabled !== false && !next.loading;
    if (inTelegram) {
      attempt(() => wa.MainButton.setParams({
        text: next.text,
        color: scheme === 'dark' ? BRAND_ACCENT_DARK : BRAND_ACCENT,
        text_color: '#ffffff',
        is_active: active,
        is_visible: true,
      }));
      attempt(() => (next.loading ? wa.MainButton.showProgress(false) : wa.MainButton.hideProgress()));
    } else {
      const bar = fallbackBar();
      const btn = fallbackBtn();
      if (!bar || !btn) return;
      fallbackText().textContent = next.text;
      btn.disabled = !active;
      btn.classList.toggle('is-loading', Boolean(next.loading));
      bar.hidden = false;
      document.body.classList.add('has-mainbar');
    }
  },
};

// ─────────────────────────────── back button

const backState = { handler: null, bound: false };
const hasNativeBack = atLeast('6.1');

function setBack(visible, handler) {
  backState.handler = handler || backState.handler;
  if (!hasNativeBack) return;
  if (!backState.bound) {
    backState.bound = true;
    attempt(() => wa.BackButton.onClick(() => backState.handler && backState.handler()));
  }
  attempt(() => (visible ? wa.BackButton.show() : wa.BackButton.hide()));
}

// ─────────────────────────────── public API

export const tg = {
  raw: wa,
  inTelegram,
  initData,
  platform: inTelegram ? wa.platform || 'unknown' : 'browser',
  version: inTelegram ? wa.version || '' : '',
  user: inTelegram && wa.initDataUnsafe ? wa.initDataUnsafe.user || null : null,
  startParam: inTelegram && wa.initDataUnsafe ? wa.initDataUnsafe.start_param || '' : '',
  hasNativeBack,
  /** WebApp.openInvoice is available (Bot API 6.1+). */
  canInvoice: atLeast('6.1'),
  canRequestContact: atLeast('6.9'),
  atLeast,

  get scheme() {
    return scheme;
  },

  /** Call once on boot: tells Telegram the app is ready, expands the sheet, applies the theme. */
  init() {
    applyTheme();
    if (!inTelegram) return;
    attempt(() => wa.ready());
    attempt(() => wa.expand());
    if (atLeast('7.7')) attempt(() => wa.disableVerticalSwipes());
    attempt(() => wa.onEvent('themeChanged', applyTheme));
  },

  onTheme(fn) {
    themeListeners.add(fn);
    return () => themeListeners.delete(fn);
  },

  setMain: (options) => main.set(options),
  setBack,

  /** kind: light | medium | heavy | select | success | warning | error */
  haptic(kind = 'light') {
    if (!atLeast('6.1') || !wa.HapticFeedback) return;
    attempt(() => {
      if (kind === 'select') wa.HapticFeedback.selectionChanged();
      else if (['success', 'warning', 'error'].includes(kind)) wa.HapticFeedback.notificationOccurred(kind);
      else wa.HapticFeedback.impactOccurred(kind);
    });
  },

  /** Ask before closing the Mini App (unsaved checkout form). */
  closingConfirmation(enabled) {
    if (!atLeast('6.2')) return;
    attempt(() => (enabled ? wa.enableClosingConfirmation() : wa.disableClosingConfirmation()));
  },

  /** Native popups exist since 6.2; the caller renders an in-page sheet otherwise. */
  hasNativePopup: atLeast('6.2'),

  /** @returns {Promise<boolean>} */
  nativeConfirm({ title, text, okText, cancelText, destructive }) {
    return new Promise((resolve) => {
      attempt(
        () => wa.showPopup({
          ...(title ? { title: String(title).slice(0, 64) } : {}),
          message: String(text || title || '').slice(0, 256),
          buttons: [
            { id: 'ok', type: destructive ? 'destructive' : 'default', text: String(okText || 'Да').slice(0, 64) },
            cancelText ? { id: 'cancel', type: 'default', text: String(cancelText).slice(0, 64) } : { id: 'cancel', type: 'cancel' },
          ],
        }, (id) => resolve(id === 'ok')),
        () => resolve(window.confirm(text || title)),
      );
    });
  },

  /** Open an external page: Telegram shows it in the browser, the Mini App stays open. */
  openLink(url) {
    if (inTelegram) return attempt(() => wa.openLink(url), () => window.open(url, '_blank'));
    return window.open(url, '_blank', 'noopener');
  },

  /** t.me links (chat with the bot, invoices on old clients). */
  openTelegramLink(url) {
    if (inTelegram) return attempt(() => wa.openTelegramLink(url), () => window.open(url, '_blank'));
    return window.open(url, '_blank', 'noopener');
  },

  /**
   * Show a Telegram invoice. Resolves with 'paid' | 'cancelled' | 'failed' | 'pending' | 'unsupported'.
   * The order itself becomes paid on the server (bot → successful_payment), not here.
   */
  openInvoice(link) {
    return new Promise((resolve) => {
      if (!tg.canInvoice) return resolve('unsupported');
      return attempt(() => wa.openInvoice(link, (status) => resolve(status || 'pending')), () => resolve('unsupported'));
    });
  },

  /** Ask the user to share their phone number. Resolves with "+998…" or null. */
  requestContact() {
    return new Promise((resolve) => {
      if (!tg.canRequestContact) return resolve(null);
      return attempt(
        () => wa.requestContact((shared, response) => {
          const phone = response && response.responseUnsafe && response.responseUnsafe.contact
            ? response.responseUnsafe.contact.phone_number
            : '';
          resolve(shared && phone ? (String(phone).startsWith('+') ? String(phone) : `+${phone}`) : null);
        }),
        () => resolve(null),
      );
    });
  },

  close() {
    if (inTelegram) attempt(() => wa.close());
  },
};

export default tg;
