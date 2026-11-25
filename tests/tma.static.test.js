// Mini App static bundle: served at /tma with the Telegram-friendly CSP; every ES module parses and
// every relative import resolves (there is no build step that would catch a typo).
import './helpers/env.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startTestApp } from './helpers/http.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'tma');

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

let t;
before(async () => {
  t = await startTestApp();
});
after(async () => {
  await t.close();
});

test('GET /tma/ serves the app shell with the Telegram bridge and a CSP that allows only it', async () => {
  const res = await t.client.get('/tma/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.ok(res.text.includes('<script src="https://telegram.org/js/telegram-web-app.js"></script>'));
  assert.ok(res.text.includes('<script type="module" src="/tma/js/main.js"></script>'));
  assert.ok(res.text.includes('href="/css/tokens.css"'));
  assert.doesNotMatch(res.text, /<script(?![^>]*\bsrc=)[^>]*>/i, 'no inline scripts (CSP)');
  assert.doesNotMatch(res.text, /\son[a-z]+="/i, 'no inline event handlers (CSP)');
  const external = [...res.text.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(external, ['https://telegram.org/js/telegram-web-app.js'], 'the only third-party resource');

  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' 'nonce-[^']+' https:\/\/telegram\.org/);
  assert.match(csp, /frame-ancestors 'self' https:\/\/web\.telegram\.org/);
  assert.match(csp, /connect-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), null, 'Telegram Web embeds the Mini App in an iframe');
});

test('every module and stylesheet of the bundle is served', async () => {
  const files = [...jsFiles(path.join(root, 'js')), path.join(root, 'app.css')];
  assert.ok(files.length >= 15);
  for (const file of files) {
    const url = `/tma/${path.relative(root, file).split(path.sep).join('/')}`;
    const res = await t.client.get(url);
    assert.equal(res.status, 200, url);
    assert.match(res.headers.get('content-type'), url.endsWith('.css') ? /text\/css/ : /javascript/, url);
  }
});

test('ES modules parse and their relative imports exist', () => {
  for (const file of jsFiles(path.join(root, 'js'))) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) {
      assert.ok(fs.existsSync(path.resolve(path.dirname(file), match[1])), `${path.relative(root, file)} imports ${match[1]}`);
    }
    assert.doesNotMatch(source, /https?:\/\/(?!telegram\.org|t\.me)[a-z0-9.-]+\.[a-z]{2,}\/[^\s'"`]*\.(?:js|css)/i, 'no CDN assets');
  }
});

test('images referenced by the shell exist', async () => {
  for (const url of ['/img/favicon.svg', '/img/placeholder.svg', '/img/tma-banner.svg']) {
    assert.equal((await t.client.get(url)).status, 200, url);
  }
});
