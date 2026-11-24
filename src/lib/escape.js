// Escaping / text helpers shared by all modules.

const HTML_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text for HTML element content and attribute values. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_MAP[ch]);
}

/** Escape text for Telegram messages sent with parse_mode "HTML". */
export function escapeTg(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escaped text with line breaks converted to <br>. Safe to output with <%- %>. */
export function nl2br(value) {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

/** Serialize data for embedding inside a <script type="application/json"> tag. */
export function jsonForScript(data) {
  return JSON.stringify(data ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Strip tags and collapse whitespace (for meta descriptions, excerpts, previews). */
export function stripTags(html) {
  return String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Cut text to max chars on a word boundary and append an ellipsis. */
export function truncate(text, max = 160) {
  const s = String(text ?? '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[.,;:!?\s]+$/, '')}…`;
}

/** Trimmed string limited to max chars; non-strings become ''. Use for all form inputs. */
export function clean(value, max = 500) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\u0000/g, '').trim().slice(0, max);
}

/** Russian plural: plural(5, ['товар','товара','товаров']) -> "товаров". */
export function plural(n, forms) {
  const a = Math.abs(Number(n)) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}
