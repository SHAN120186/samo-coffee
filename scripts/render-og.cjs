// Renders public/img/og.svg → public/img/og.png (1200×630). Social networks do not show SVG previews,
// so the site's og:image points to the PNG. Run after `npm run art` when the artwork changes:
//   node scripts/render-og.cjs
// Needs Playwright with Chromium (a development tool, not a runtime dependency).
const path = require('node:path');
const fs = require('node:fs');

(async () => {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.error('Playwright is not installed: npm i -D playwright && npx playwright install chromium');
    process.exit(1);
  }
  const img = path.join(__dirname, '..', 'public', 'img');
  const svg = fs.readFileSync(path.join(img, 'og.svg'), 'utf8');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(`<body style="margin:0">${svg}</body>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(img, 'og.png'), clip: { x: 0, y: 0, width: 1200, height: 630 } });
  await browser.close();
  console.log('public/img/og.png written');
})();
