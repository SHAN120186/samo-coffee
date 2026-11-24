// View helpers of the public site: icons, SEO meta, pagination, small text utilities.
import { config } from '../config.js';
import { escapeHtml, stripTags, truncate } from '../lib/escape.js';

// ─────────────────────────────── icons (inline SVG, 24×24, stroke = currentColor)

const ICONS = {
  bag: '<path d="M5 8h14l-1 12H6L5 8Z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  'arrow-left': '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10 11v5M14 11v5"/>',
  phone: '<path d="M6.5 4h3l1.5 4-2 1.5a11 11 0 0 0 5.5 5.5l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A16 16 0 0 1 4.5 6.2 2 2 0 0 1 6.5 4Z"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4 7 8 6 8-6"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  truck: '<path d="M3 6.5h10.5v10H3zM13.5 10H18l3 3.2v3.3h-7.5"/><circle cx="7.5" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
  flame: '<path d="M12 21a6 6 0 0 1-6-6c0-3 2-4.5 3-7 .5 2 1.5 2.5 2.5 3 0-3 1-5.5 2.5-7 .5 3.5 4 5.5 4 11a6 6 0 0 1-6 6Z"/>',
  grind: '<path d="M7 9h10l-1.2 5H8.2L7 9ZM9 14v3.5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V14M12 9V5M12 5h5"/><circle cx="17.5" cy="5" r="1"/>',
  box: '<path d="m3.5 8 8.5-4.5L20.5 8v8L12 20.5 3.5 16V8Z"/><path d="m3.5 8 8.5 4.5L20.5 8M12 12.5v8"/>',
  card: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3 10h18M7 14.5h4"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="14.5" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  leaf: '<path d="M5 19c0-9 5-14 14-14 0 9-5 14-14 14Z"/><path d="M5 19 14 10"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  chat: '<path d="M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H11l-4.5 3.5v-3.5a2 2 0 0 1-2-2v-8Z"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 0 1-13 5M4.5 12a7.5 7.5 0 0 1 13-5"/><path d="M17.5 3.5V7H14M6.5 20.5V17H10"/>',
  x: '<path d="m7 7 10 10M17 7 7 17"/>',
  // brands (filled)
  telegram: { fill: true, d: '<path d="M20.7 4.3 2.9 11.2c-.8.3-.8 1.4.1 1.7l4.5 1.4 1.7 5.3c.2.7 1.1.9 1.6.3l2.5-2.5 4.5 3.3c.6.4 1.4.1 1.6-.6l3-14.3c.2-.9-.7-1.7-1.7-1.5ZM9.7 14.6l8-5.9c.2-.1.4.1.2.3l-6.6 6.4-.3 3.2-1.3-4Z"/>' },
  instagram: '<rect x="4" y="4" width="16" height="16" rx="4.5"/><circle cx="12" cy="12" r="3.7"/><circle cx="16.7" cy="7.3" r=".6" fill="currentColor"/>',
  facebook: { fill: true, d: '<path d="M13.5 21v-7.5h2.6l.4-3h-3V8.7c0-.9.3-1.5 1.5-1.5h1.6V4.5c-.3 0-1.2-.1-2.3-.1-2.3 0-3.8 1.4-3.8 3.9v2.2H8v3h2.5V21h3Z"/>' },
  youtube: '<rect x="3" y="6" width="18" height="12" rx="3.5"/><path d="m10.5 9.5 4.5 2.5-4.5 2.5v-5Z" fill="currentColor"/>',
};

/**
 * Inline SVG icon markup (decorative: aria-hidden). Output with <%- icon('bag') %>.
 * @param {string} name @param {{ size?: number, className?: string }} [o]
 */
export function icon(name, { size = 20, className = '' } = {}) {
  const def = ICONS[name];
  if (!def) return '';
  const filled = typeof def === 'object' && def.fill;
  const body = typeof def === 'object' ? def.d : def;
  const paint = filled
    ? 'fill="currentColor"'
    : 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
  const cls = `icon${className ? ` ${escapeHtml(className)}` : ''}`;
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" ${paint} aria-hidden="true" focusable="false">${body}</svg>`;
}

// ─────────────────────────────── urls / seo

/** Absolute URL for a site path or an already absolute URL. */
export function abs(pathOrUrl) {
  const v = String(pathOrUrl || '');
  if (/^https?:\/\//i.test(v)) return v;
  return `${config.baseUrl}${v.startsWith('/') ? v : `/${v}`}`;
}

/** Plain-text description for meta tags. */
export const metaText = (text, max = 180) => truncate(stripTags(text), max);

/** "tel:" href from a formatted phone number. */
export function telHref(phone) {
  const digits = String(phone || '').replace(/[^\d+]/g, '');
  return digits ? `tel:${digits}` : '';
}

/**
 * Headline with one accented phrase. Explicit markup wins: "Кофе *этой недели*". Without it the
 * last two words of a 4+ word headline are emphasised. Returns safe HTML (output with <%- %>).
 */
export function accentTitle(text) {
  const raw = String(text || '').trim();
  if (/\*[^*]+\*/.test(raw)) {
    return escapeHtml(raw).replace(/\*([^*]+)\*/g, '<em>$1</em>');
  }
  const words = raw.split(/\s+/);
  if (words.length < 4) return escapeHtml(raw);
  const head = words.slice(0, -2).join(' ');
  const tail = words.slice(-2).join(' ');
  return `${escapeHtml(head)} <em>${escapeHtml(tail)}</em>`;
}

/** Subscription period in words: 30 → "в месяц", 14 → "за 14 дней". */
export function periodLabel(days) {
  const d = Number(days) || 30;
  if (d >= 28 && d <= 31) return 'в месяц';
  if (d === 7) return 'в неделю';
  if (d >= 89 && d <= 92) return 'за 3 месяца';
  if (d >= 365) return 'в год';
  return `за ${d} дн.`;
}

// ─────────────────────────────── pagination

/**
 * @param {number} total @param {number} page @param {number} perPage
 * @returns {{ page, pages, total, perPage, offset, items: (number|null)[] }} items: page numbers, null = gap
 */
export function paginate(total, page, perPage) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, Number.parseInt(page, 10) || 1), pages);
  const wanted = new Set([1, pages, current - 1, current, current + 1]);
  const numbers = [...wanted].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const items = [];
  numbers.forEach((n, i) => {
    if (i > 0 && n - numbers[i - 1] > 1) items.push(null);
    items.push(n);
  });
  return { page: current, pages, total, perPage, offset: (current - 1) * perPage, items };
}

/** Build a URL with the given query params; empty values are dropped. */
export function withQuery(basePath, params) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '' && !(key === 'page' && Number(value) === 1)) qs.set(key, String(value));
  }
  const s = qs.toString();
  return s ? `${basePath}?${s}` : basePath;
}

/** Same-site path only (open-redirect protection for "return to" form fields). */
export function safeLocalPath(candidate, fallback = '/') {
  const c = String(candidate || '');
  return /^\/(?![/\\])/.test(c) && !/[\r\n]/.test(c) && c.length <= 500 ? c : fallback;
}

/** Tasting notes for the home page ticker, taken from coffee products ("Жасмин, бергамот, персик"). */
export function tastingNotes(products, max = 14) {
  const seen = new Set();
  const notes = [];
  for (const p of products) {
    if (!p.roast || !p.subtitle || /[·\d]/.test(p.subtitle)) continue;
    for (const part of p.subtitle.split(',')) {
      const note = part.trim().toLocaleLowerCase('ru');
      if (!note || note.length > 28 || seen.has(note)) continue;
      seen.add(note);
      notes.push(note);
    }
  }
  return notes.slice(0, max);
}
