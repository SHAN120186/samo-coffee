// Editable content blocks: every text / image on the public pages is a row in content_blocks
// addressed by (page, key). Defaults live in contentDefaults.js and are inserted at boot,
// so views can always rely on a block being present.
import { all, get as dbGet, run, tx, now } from '../db/index.js';
import { sanitizeRichText } from '../lib/sanitize.js';
import { AppError } from '../lib/errors.js';
import { DEFAULT_BLOCKS, PAGE_TITLES } from './contentDefaults.js';

export { DEFAULT_BLOCKS, PAGE_TITLES };
export const BLOCK_TYPES = ['text', 'richtext', 'image', 'link'];

const cache = new Map();

/** Drop the cache (after direct table writes in seeds/tests). */
export function clearCache() {
  cache.clear();
}

/** Insert default blocks that are missing in the DB (never overwrites edited values). */
export function ensureDefaults() {
  tx(() => {
    DEFAULT_BLOCKS.forEach((b, i) => {
      run(
        `INSERT INTO content_blocks (page, key, type, value, label, sort) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(page, key) DO NOTHING`,
        b.page, b.key, b.type, b.value, b.label, i,
      );
    });
  });
  cache.clear();
}

/**
 * All blocks of a page as { key: value }. Unknown keys read as undefined — use
 * `c.key || 'fallback'` in views or content.get(). Rich text values are already sanitized.
 */
export function getPage(page) {
  let map = cache.get(page);
  if (!map) {
    map = {};
    for (const b of DEFAULT_BLOCKS) if (b.page === page) map[b.key] = b.value;
    for (const row of all('SELECT key, value FROM content_blocks WHERE page = ?', page)) map[row.key] = row.value;
    cache.set(page, map);
  }
  return { ...map };
}

/** One block value with fallback. */
export function get(page, key, fallback = '') {
  const v = getPage(page)[key];
  return v === undefined || v === null || v === '' ? fallback : v;
}

/** Pages that have blocks: [{ page, title, blocks }] in a stable, human order. */
export function listPages() {
  const counts = new Map(all('SELECT page, COUNT(*) AS n FROM content_blocks GROUP BY page').map((r) => [r.page, r.n]));
  const known = Object.keys(PAGE_TITLES);
  const pages = [...known.filter((p) => counts.has(p)), ...[...counts.keys()].filter((p) => !known.includes(p)).sort()];
  return pages.map((page) => ({ page, title: PAGE_TITLES[page] || page, blocks: counts.get(page) }));
}

/** Full block rows of a page ordered for the editor: [{ id, page, key, type, value, label, sort, updated_at }]. */
export function listBlocks(page) {
  return all('SELECT * FROM content_blocks WHERE page = ? ORDER BY sort, id', page);
}

export function getBlock(id) {
  return dbGet('SELECT * FROM content_blocks WHERE id = ?', id);
}

function normalizeValue(type, value) {
  const v = String(value ?? '');
  if (type === 'richtext') return sanitizeRichText(v);
  if (type === 'image' || type === 'link') {
    const t = v.trim();
    // Only site-relative paths and http(s)/mailto/tel links are allowed.
    if (t && !/^(\/(?!\/)|https?:\/\/|mailto:|tel:|#)/i.test(t)) {
      throw new AppError('validation', 'Ссылка должна начинаться с «/» или «https://»', 422);
    }
    return t.slice(0, 1000);
  }
  return v.replace(/\r\n/g, '\n').trim().slice(0, 20000);
}

/** Update the value of an existing block by (page, key). Returns the updated row. */
export function setBlock(page, key, value) {
  const row = dbGet('SELECT * FROM content_blocks WHERE page = ? AND key = ?', page, key);
  if (!row) throw new AppError('not_found', `Блок ${page}.${key} не найден`, 404);
  run('UPDATE content_blocks SET value = ?, updated_at = ? WHERE id = ?', normalizeValue(row.type, value), now(), row.id);
  cache.delete(page);
  return getBlock(row.id);
}

/** Update many blocks of one page: setBlocks('home', { hero_title: '...', hero_image: '/uploads/x.webp' }). */
export function setBlocks(page, values) {
  tx(() => {
    for (const [key, value] of Object.entries(values)) {
      const row = dbGet('SELECT id, type FROM content_blocks WHERE page = ? AND key = ?', page, key);
      if (row) run('UPDATE content_blocks SET value = ?, updated_at = ? WHERE id = ?', normalizeValue(row.type, value), now(), row.id);
    }
  });
  cache.delete(page);
}

/** Create or fully replace a block. */
export function upsertBlock({ page, key, type = 'text', value = '', label = '', sort = null }) {
  if (!page || !key) throw new AppError('validation', 'Укажите страницу и ключ блока', 422);
  if (!/^[a-z0-9_]+$/.test(page) || !/^[a-z0-9_]+$/.test(key)) {
    throw new AppError('validation', 'Страница и ключ: только латинские буквы, цифры и «_»', 422);
  }
  if (!BLOCK_TYPES.includes(type)) throw new AppError('validation', 'Неизвестный тип блока', 422);
  const nextSort = sort ?? (dbGet('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM content_blocks WHERE page = ?', page).s);
  run(
    `INSERT INTO content_blocks (page, key, type, value, label, sort, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(page, key) DO UPDATE SET type = excluded.type, value = excluded.value,
       label = excluded.label, sort = excluded.sort, updated_at = excluded.updated_at`,
    page, key, type, normalizeValue(type, value), String(label || key), nextSort, now(),
  );
  cache.delete(page);
  return dbGet('SELECT * FROM content_blocks WHERE page = ? AND key = ?', page, key);
}

export function deleteBlock(id) {
  const row = getBlock(id);
  if (!row) return false;
  run('DELETE FROM content_blocks WHERE id = ?', id);
  cache.delete(row.page);
  return true;
}
