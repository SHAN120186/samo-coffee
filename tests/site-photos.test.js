import './helpers/env.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp } from './helpers/http.js';
import { seed } from '../src/db/seed.js';
import { all, get, run, db } from '../src/db/index.js';
import * as content from '../src/services/content.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = fs.readFileSync(path.join(ROOT, 'src/db/migrations/003_photos.sql'), 'utf8');
const credits = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/img/photos/credits.json'), 'utf8'));

let t;
before(async () => {
  seed({ quiet: true });
  t = await startTestApp();
});
after(async () => {
  await t.close();
});

test('every photo the site ships with exists, is a real JPEG and has a credit entry', () => {
  const used = new Set([
    ...all("SELECT value AS v FROM content_blocks WHERE type = 'image' AND value LIKE '/img/photos/%'").map((r) => r.v),
    ...all("SELECT image AS v FROM categories WHERE image LIKE '/img/photos/%'").map((r) => r.v),
    ...all("SELECT image AS v FROM plans WHERE image LIKE '/img/photos/%'").map((r) => r.v),
    ...all("SELECT cover AS v FROM posts WHERE cover LIKE '/img/photos/%'").map((r) => r.v),
  ]);
  assert.ok(used.size >= 20, `the demo uses the photos (${used.size})`);
  const credited = new Set(credits.map((c) => c.file));
  for (const file of used) {
    const buf = fs.readFileSync(path.join(ROOT, 'public', file));
    assert.equal(buf.subarray(0, 3).toString('hex'), 'ffd8ff', `${file} is a JPEG`);
    assert.ok(buf.length < 400 * 1024, `${file} is web-sized (${Math.round(buf.length / 1024)} KB)`);
    assert.ok(credited.has(file), `${file} is credited`);
  }
  for (const c of credits) {
    assert.ok(c.author && c.license && /^https:\/\/commons\.wikimedia\.org\//.test(c.source), `${c.file}: author, licence and source`);
    if (/^CC BY/.test(c.license)) assert.match(c.license_url, /creativecommons\.org\/licenses\/by/, `${c.file}: licence link`);
  }
});

test('the photo credits page lists every photo and the footer links to it', async () => {
  const c = t.newClient();
  const page = await c.get('/photo-credits');
  assert.equal(page.status, 200);
  for (const p of credits) assert.ok(page.text.includes(p.source.replace(/&/g, '&amp;')) || page.text.includes(p.source), `${p.file} is listed`);
  const home = await c.get('/');
  assert.ok(home.text.includes('href="/photo-credits"'), 'footer link');
  assert.ok(home.text.includes('hero__img--photo'), 'the hero renders the photo frame');
  assert.ok(home.text.includes('mood__grid--5'), 'the mood gallery shows five photos');
});

test('migration 003 switches the shipped illustrations to photos but keeps images an admin replaced', () => {
  run("UPDATE content_blocks SET value = '/img/hero.svg' WHERE page = 'home' AND key = 'hero_image'");
  run("UPDATE content_blocks SET value = '/uploads/custom.jpg' WHERE page = 'about' AND key = 'image'");
  run("UPDATE categories SET image = '/img/categories/filter.svg' WHERE slug = 'filter'");
  run("UPDATE plans SET image = '/img/plans/plan-2.svg' WHERE slug = 'duo'");
  run("UPDATE posts SET cover = '/img/blog/cover-4.svg' WHERE cover = '/img/photos/blog-cold-brew.jpg'");
  db.exec(MIGRATION);
  content.clearCache();
  assert.equal(get("SELECT value FROM content_blocks WHERE page = 'home' AND key = 'hero_image'").value, '/img/photos/hero.jpg');
  assert.equal(get("SELECT value FROM content_blocks WHERE page = 'about' AND key = 'image'").value, '/uploads/custom.jpg', 'an admin choice stays');
  assert.equal(get("SELECT image FROM categories WHERE slug = 'filter'").image, '/img/photos/category-filter.jpg');
  assert.equal(get("SELECT image FROM plans WHERE slug = 'duo'").image, '/img/photos/plan-duo.jpg');
  assert.equal(get("SELECT COUNT(*) AS n FROM posts WHERE cover = '/img/photos/blog-cold-brew.jpg'").n, 1);
});

test('demo bot users are flagged, so broadcasts and reminders never write to made-up ids', () => {
  const total = get('SELECT COUNT(*) AS n FROM tg_users').n;
  assert.ok(total > 0);
  assert.equal(get('SELECT COUNT(*) AS n FROM tg_users WHERE is_demo = 1').n, total, 'the seed marks every user it invents');
  // an older stand seeded without the flag: migration 004 marks users older than the first admin, not later ones
  run('UPDATE tg_users SET is_demo = 0');
  run("UPDATE admins SET created_at = '2030-01-01T00:00:00.000Z'");
  run("INSERT INTO tg_users (id, chat_id, first_name, source, created_at, last_seen_at) VALUES (424242, 424242, 'Real', 'bot', '2030-02-01T00:00:00.000Z', '2030-02-01T00:00:00.000Z')");
  db.exec(fs.readFileSync(path.join(ROOT, 'src/db/migrations/004_mark_demo_tg_users.sql'), 'utf8'));
  assert.equal(get('SELECT is_demo FROM tg_users WHERE id = 424242').is_demo, 0, 'a real user who came later stays reachable');
  assert.equal(get('SELECT COUNT(*) AS n FROM tg_users WHERE is_demo = 1').n, total, 'all seeded users are flagged');
});
