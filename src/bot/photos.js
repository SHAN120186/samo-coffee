// Product / plan pictures for Telegram.
//
// Telegram shows only raster photos, while the shop artwork in public/img is SVG. So:
//   /img/**.svg        → pre-rendered copy in src/bot/assets/img/**.jpg (scripts/render-photos.cjs)
//   /uploads/*.jpg|png|webp, /img/**.jpg|png → the file itself
//   https://…jpg|png|webp (external)         → passed to Telegram as a URL
// Local files are uploaded once (multipart) — the file_id Telegram returns is cached in memory and
// reused, so the bot shows photos even when BASE_URL is http://localhost.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GrammyError, InputFile } from 'grammy';
import { config } from '../config.js';
import { truncate } from '../lib/escape.js';

const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets');
const RASTER = new Set(['.jpg', '.jpeg', '.png', '.webp']);
export const CAPTION_LIMIT = 1024;

/** cache key → Telegram file_id */
const fileIds = new Map();
/** keys Telegram refused (bad format / too large) — the card falls back to text */
const rejected = new Set();

const inside = (dir, file) => {
  const rel = path.relative(dir, file);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
};

function statFile(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

/**
 * Find something Telegram can show for an image URL of the shop.
 * @param {string} imageUrl "/img/products/kenya-nyeri.svg", "/uploads/ab12.jpg", "https://cdn…/x.png"
 * @returns {{ key: string, file?: string, url?: string } | null}
 */
export function resolvePhoto(imageUrl) {
  let url = String(imageUrl || '').trim();
  if (!url) return null;
  if (url.startsWith(`${config.baseUrl}/`)) url = url.slice(config.baseUrl.length);
  if (/^https:\/\//i.test(url)) {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return RASTER.has(ext) ? { key: url, url } : null;
  }
  if (!url.startsWith('/') || url.startsWith('//')) return null;
  let rel;
  try {
    rel = decodeURIComponent(url.split(/[?#]/)[0]);
  } catch {
    return null;
  }
  const ext = path.extname(rel).toLowerCase();
  let file;
  if (ext === '.svg') {
    file = path.join(ASSETS_DIR, rel.replace(/\.svg$/i, '.jpg'));
    if (!inside(ASSETS_DIR, file)) return null;
  } else if (RASTER.has(ext)) {
    const uploads = rel.startsWith('/uploads/');
    const base = uploads ? config.uploads.dir : config.publicDir;
    file = path.join(base, uploads ? rel.slice('/uploads/'.length) : rel);
    if (!inside(base, file)) return null;
  } else {
    return null;
  }
  const st = statFile(file);
  if (!st || st.size === 0 || st.size > 10 * 1024 * 1024) return null;
  return { key: `${file}:${Math.round(st.mtimeMs)}`, file };
}

const isBadRequest = (err) => err instanceof GrammyError && err.error_code === 400;

/**
 * Send a card: a photo with an HTML caption when a picture is available, otherwise a text message.
 * @param {import('grammy').Api} api
 * @param {number|string} chatId
 * @param {string} imageUrl shop image URL (may be empty)
 * @param {string} html card text (cut to the 1024-char caption limit when sent with a photo)
 * @param {object} [extra] reply_markup etc.
 * @returns {Promise<object>} the sent Message
 */
export async function sendCard(api, chatId, imageUrl, html, extra = {}) {
  const photo = html.length <= CAPTION_LIMIT ? resolvePhoto(imageUrl) : null;
  if (photo && !rejected.has(photo.key)) {
    const attempts = fileIds.has(photo.key) ? ['cached', 'fresh'] : ['fresh'];
    for (const attempt of attempts) {
      const source = attempt === 'cached' ? fileIds.get(photo.key) : photo.url || new InputFile(photo.file);
      try {
        const message = await api.sendPhoto(chatId, source, { caption: html, ...extra });
        const fileId = message?.photo?.at(-1)?.file_id;
        if (fileId) fileIds.set(photo.key, fileId);
        return message;
      } catch (err) {
        if (!isBadRequest(err)) throw err;
        if (attempt === 'cached') fileIds.delete(photo.key); // stale file_id → upload again
        else rejected.add(photo.key); // Telegram does not like this picture → text card
      }
    }
  }
  return api.sendMessage(chatId, html, extra);
}

/** Shorten a description so that the whole card fits into a photo caption. */
export function fitCaption(parts, description, reserve = 0) {
  const fixed = parts.filter(Boolean).join('\n').length + reserve;
  const room = CAPTION_LIMIT - fixed - 8;
  return room > 60 ? truncate(description, Math.min(room, 420)) : '';
}

/** Test helper: forget cached file ids and rejections. */
export function resetPhotoCache() {
  fileIds.clear();
  rejected.clear();
}
