// Dev-time tool (NOT used at runtime): Telegram cannot display SVG, so the bot sends pre-rendered
// JPEG copies of the shop artwork. This script renders public/img/{products,plans}/*.svg and a few
// banners into src/bot/assets/img/**.jpg with a headless Chromium (Playwright must be installed
// globally; it is not a project dependency).
//
//   node src/bot/scripts/render-photos.cjs
//
// Uploaded product photos (JPG/PNG/WebP in /uploads) need no rendering — the bot sends them as is.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'public', 'img');
const OUT = path.join(ROOT, 'src', 'bot', 'assets', 'img');
const SETS = ['products', 'plans'];
const SINGLES = ['tma-banner.svg', 'subscription.svg'];

(async () => {
  const files = [
    ...SETS.flatMap((dir) => fs.readdirSync(path.join(SRC, dir)).filter((f) => f.endsWith('.svg')).map((f) => path.join(dir, f))),
    ...SINGLES.filter((f) => fs.existsSync(path.join(SRC, f))),
  ];
  const browser = await chromium.launch();
  for (const rel of files) {
    const file = path.join(SRC, rel);
    const head = fs.readFileSync(file, 'utf8').slice(0, 400);
    const width = Number(/\swidth="(\d+)"/.exec(head)?.[1]) || 800;
    const height = Number(/\sheight="(\d+)"/.exec(head)?.[1]) || 800;
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.goto(`file://${file}`);
    await page.waitForTimeout(250); // embedded fonts
    const out = path.join(OUT, rel.replace(/\.svg$/, '.jpg'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await page.screenshot({ path: out, type: 'jpeg', quality: 88 });
    await page.close();
    console.log(`${rel} → ${path.relative(ROOT, out)} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
  }
  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
