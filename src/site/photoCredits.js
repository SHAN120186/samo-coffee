// Authors and licences of the stock photos the site ships with (public/img/photos/credits.json).
// CC BY photos must credit their author: the /photo-credits page and the footer link do that.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

let cached = null;

/** [{ file, title, author, license, license_url, source }] — empty when the file is missing. */
export function photoCredits() {
  if (cached) return cached;
  try {
    const list = JSON.parse(fs.readFileSync(path.join(config.publicDir, 'img', 'photos', 'credits.json'), 'utf8'));
    cached = Array.isArray(list) ? list.filter((c) => c && c.file && c.source) : [];
  } catch {
    cached = [];
  }
  return cached;
}
