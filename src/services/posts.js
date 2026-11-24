// Blog posts.
import { all, get, run, now } from '../db/index.js';
import { slugify, uniqueSlug } from '../lib/slugify.js';
import { sanitizeRichText } from '../lib/sanitize.js';
import { stripTags, truncate } from '../lib/escape.js';
import { AppError, notFound } from '../lib/errors.js';

const flag = (v) => (v === true || v === 1 || v === '1' || v === 'on' || v === 'true' ? 1 : 0);
const hydrate = (row) => (row ? { ...row, url: `/blog/${row.slug}`, cover: row.cover || '/img/blog/cover-1.svg' } : null);

/**
 * @param {{ publishedOnly?: boolean, limit?: number, offset?: number }} [o] publishedOnly defaults to true
 * @returns {{ items: object[], total: number }} newest first
 */
export function listPosts({ publishedOnly = true, limit = 50, offset = 0 } = {}) {
  const where = publishedOnly ? 'WHERE published = 1' : '';
  const total = get(`SELECT COUNT(*) AS n FROM posts ${where}`).n;
  const items = all(
    `SELECT * FROM posts ${where} ORDER BY COALESCE(published_at, created_at) DESC, id DESC LIMIT ? OFFSET ?`,
    Number(limit), Number(offset),
  ).map(hydrate);
  return { items, total };
}

export function getPost(id) {
  return hydrate(get('SELECT * FROM posts WHERE id = ?', Number(id)));
}

export function getPostBySlug(slug, { publishedOnly = true } = {}) {
  return hydrate(get(`SELECT * FROM posts WHERE slug = ? ${publishedOnly ? 'AND published = 1' : ''}`, String(slug)));
}

const slugTaken = (slug, exceptId = 0) => Boolean(get('SELECT 1 AS x FROM posts WHERE slug = ? AND id <> ?', slug, exceptId));

function fields(data, current = null) {
  const pick = (k, def) => (data[k] !== undefined ? data[k] : current ? current[k] : def);
  const title = String(pick('title', '')).trim();
  if (!title) throw new AppError('validation', 'Укажите заголовок статьи', 422);
  const body = data.body_html !== undefined ? sanitizeRichText(data.body_html) : (current?.body_html ?? '');
  const text = stripTags(body);
  const published = data.published === undefined ? (current?.published ?? 0) : flag(data.published);
  let publishedAt = data.published_at !== undefined && data.published_at !== '' ? new Date(data.published_at) : null;
  publishedAt = publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt.toISOString() : (current?.published_at ?? null);
  if (published && !publishedAt) publishedAt = now();
  return {
    title,
    excerpt: String(pick('excerpt', '')).trim() || truncate(text, 180),
    body_html: body,
    cover: String(pick('cover', '')).trim(),
    author: String(pick('author', '')).trim(),
    reading_min: Math.max(1, Math.round(text.split(/\s+/).filter(Boolean).length / 180)),
    published,
    published_at: publishedAt,
  };
}

/** data: { title*, slug, excerpt, body_html, cover, author, published, published_at } */
export function createPost(data) {
  const f = fields(data);
  const slug = uniqueSlug(data.slug || f.title, (s) => slugTaken(s));
  const ts = now();
  const { lastInsertRowid } = run(
    `INSERT INTO posts (slug, title, excerpt, body_html, cover, author, reading_min, published, published_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    slug, f.title, f.excerpt, f.body_html, f.cover, f.author, f.reading_min, f.published, f.published_at, ts, ts,
  );
  return getPost(Number(lastInsertRowid));
}

export function updatePost(id, data) {
  const row = get('SELECT * FROM posts WHERE id = ?', Number(id));
  if (!row) throw notFound('Статья');
  const f = fields(data, row);
  let slug = row.slug;
  if (data.slug && slugify(data.slug) !== row.slug) slug = uniqueSlug(data.slug, (s) => slugTaken(s, row.id));
  run(
    `UPDATE posts SET slug = ?, title = ?, excerpt = ?, body_html = ?, cover = ?, author = ?, reading_min = ?,
       published = ?, published_at = ?, updated_at = ? WHERE id = ?`,
    slug, f.title, f.excerpt, f.body_html, f.cover, f.author, f.reading_min, f.published, f.published_at, now(), row.id,
  );
  return getPost(row.id);
}

export function deletePost(id) {
  return run('DELETE FROM posts WHERE id = ?', Number(id)).changes > 0;
}
