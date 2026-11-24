// Generates the original SVG illustrations in public/img (products, categories, hero, blog covers,
// plans, logo, favicon). Run: `npm run art`. Output is committed; re-run only to tweak the artwork.
// Text inside the SVGs uses an embedded copy of Playfair Display (latin, 600) so the files render
// identically when loaded through <img>.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'img');
const fontFile = path.join(root, 'node_modules/@fontsource/playfair-display/files/playfair-display-latin-600-normal.woff2');
const FONT = fs.readFileSync(fontFile).toString('base64');

const C = {
  cream: '#f7f1e6', paper: '#fffaf1', sand: '#efe5d3', tan: '#e6dac6', kraft: '#c9a67c', kraftDark: '#b08a5e',
  espresso: '#2a1a12', brown: '#4f3324', mocha: '#6b4a37', terracotta: '#b84a24', clay: '#d0643a', blush: '#edc9b3',
  honey: '#d7a53a', butter: '#f1d48a', sage: '#647a53', moss: '#4c5f3f', mint: '#cfdcc0', sky: '#2f5d7c', mist: '#c9dbe6',
  berry: '#8c2f39', rose: '#e8c3c0', plum: '#4a2a3f', white: '#ffffff',
};

const fontDefs = `<style>@font-face{font-family:'SamoDisplay';font-weight:600;src:url(data:font/woff2;base64,${FONT}) format('woff2')}
.t{font-family:'SamoDisplay',Georgia,'Times New Roman',serif;font-weight:600}</style>`;

const svg = (w, h, body, { font = false, defs = '' } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
  `<defs>${font ? fontDefs : ''}` +
  `<linearGradient id="vol" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#fff" stop-opacity=".16"/><stop offset=".22" stop-color="#fff" stop-opacity=".05"/><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".2"/></linearGradient>` +
  `<linearGradient id="glass" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity=".7"/><stop offset=".5" stop-color="#fff" stop-opacity=".25"/><stop offset="1" stop-color="#fff" stop-opacity=".5"/></linearGradient>` +
  `${defs}</defs>${body}</svg>\n`;

const g = (x, y, s, inner, rot = 0) => `<g transform="translate(${x} ${y}) rotate(${rot}) scale(${s})">${inner}</g>`;

// deterministic pseudo-random
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────────── primitives

function bean(x, y, r, rot = 0, color = C.brown, crease = C.espresso) {
  return `<g transform="translate(${x} ${y}) rotate(${rot})"><ellipse rx="${r}" ry="${r * 0.66}" fill="${color}"/>` +
    `<path d="M${-r * 0.82} 0 C ${-r * 0.3} ${-r * 0.42}, ${r * 0.3} ${r * 0.42}, ${r * 0.82} 0" fill="none" stroke="${crease}" stroke-width="${Math.max(1.5, r * 0.13)}" stroke-linecap="round"/>` +
    `<ellipse rx="${r * 0.55}" ry="${r * 0.16}" cx="${-r * 0.1}" cy="${-r * 0.36}" fill="#fff" opacity=".12"/></g>`;
}

function beans(seed, n, box, { colors = [C.brown, C.mocha, C.espresso], rMin = 12, rMax = 20 } = {}) {
  const rand = rng(seed);
  let s = '';
  for (let i = 0; i < n; i++) {
    const r = rMin + rand() * (rMax - rMin);
    s += bean(box[0] + rand() * box[2], box[1] + rand() * box[3], r, rand() * 180, colors[Math.floor(rand() * colors.length)], C.espresso === colors[0] ? C.brown : '#1c110b');
  }
  return s;
}

function leaf(x, y, len, rot, color = C.sage) {
  return `<g transform="translate(${x} ${y}) rotate(${rot})"><path d="M0 0 C ${len * 0.3} ${-len * 0.32}, ${len * 0.75} ${-len * 0.28}, ${len} 0 C ${len * 0.75} ${len * 0.28}, ${len * 0.3} ${len * 0.32}, 0 0Z" fill="${color}"/>` +
    `<path d="M${len * 0.06} 0 L${len * 0.92} 0" stroke="#000" stroke-opacity=".18" stroke-width="2" stroke-linecap="round"/></g>`;
}

function sprig(x, y, s, rot, color = C.sage) {
  let inner = `<path d="M0 0 C 20 -60, 10 -130, 40 -190" fill="none" stroke="${C.moss}" stroke-width="4" stroke-linecap="round"/>`;
  [[4, -30, -150], [8, -62, -20], [10, -96, -155], [18, -128, -25], [26, -160, -150], [38, -188, -70]].forEach(([lx, ly, r]) => { inner += leaf(lx, ly, 46, r, color); });
  return g(x, y, s, inner, rot);
}

function steam(x, y, s = 1, color = C.espresso, opacity = 0.28) {
  const p = (dx) => `<path d="M${dx} 0 c -14 -18, 14 -32, 0 -52 c -14 -20, 14 -34, 0 -54" fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="5" stroke-linecap="round"/>`;
  return g(x, y, s, p(-22) + p(0) + p(22));
}

const MOTIFS = {
  sun: (a) => {
    let s = `<circle r="17" fill="${a}"/>`;
    for (let i = 0; i < 12; i++) s += `<line x1="0" y1="-26" x2="0" y2="${i % 2 ? -36 : -42}" stroke="${a}" stroke-width="3.5" stroke-linecap="round" transform="rotate(${i * 30})"/>`;
    return s;
  },
  ikat: (a, b) => `<path d="M0 -44 L30 0 L0 44 L-30 0Z" fill="${a}"/><path d="M0 -26 L18 0 L0 26 L-18 0Z" fill="${b}"/><path d="M0 -10 L7 0 L0 10 L-7 0Z" fill="${a}"/>` +
    `<path d="M-52 -18 L-40 0 L-52 18 L-64 0Z M52 -18 L64 0 L52 18 L40 0Z" fill="${a}" opacity=".75"/>`,
  mountains: (a, b) => `<circle cx="24" cy="-22" r="12" fill="${b}"/><path d="M-58 34 L-22 -24 L4 14 L20 -8 L58 34Z" fill="${a}"/><path d="M-22 -24 L-10 -6 L-20 -2 L-30 -10Z" fill="#fff" opacity=".55"/>`,
  waves: (a) => [-24, -8, 8, 24].map((y) => `<path d="M-52 ${y} q 13 -12 26 0 t 26 0 t 26 0 t 26 0" fill="none" stroke="${a}" stroke-width="4.5" stroke-linecap="round"/>`).join(''),
  berries: (a, b) => `<path d="M0 -40 C -4 -20, -14 -8, -20 4 M0 -40 C 6 -22, 16 -10, 22 0" stroke="${b}" stroke-width="3" fill="none" stroke-linecap="round"/>` +
    `<circle cx="-22" cy="16" r="15" fill="${a}"/><circle cx="20" cy="12" r="15" fill="${a}"/><circle cx="-1" cy="30" r="13" fill="${a}" opacity=".8"/>` +
    leaf(2, -40, 34, -20, b),
  arches: (a, b) => `<path d="M-48 30 a48 48 0 0 1 96 0" fill="none" stroke="${a}" stroke-width="9"/><path d="M-31 30 a31 31 0 0 1 62 0" fill="none" stroke="${b}" stroke-width="9"/><path d="M-14 30 a14 14 0 0 1 28 0Z" fill="${a}"/>`,
  flower: (a, b) => {
    let s = '';
    for (let i = 0; i < 8; i++) s += `<ellipse cx="0" cy="-25" rx="9" ry="19" fill="${a}" transform="rotate(${i * 45})"/>`;
    return `${s}<circle r="10" fill="${b}"/>`;
  },
  dots: (a, b) => {
    let s = '';
    for (let r = 0; r < 4; r++) for (let c = 0; c < 5; c++) s += `<circle cx="${-48 + c * 24}" cy="${-34 + r * 22}" r="${(r + c) % 2 ? 4 : 7}" fill="${(r + c) % 3 ? a : b}"/>`;
    return s;
  },
  moon: (a, b) => `<circle r="34" fill="${a}"/><circle cx="14" cy="-10" r="30" fill="${b}"/><circle cx="-40" cy="-30" r="3.5" fill="${a}"/><circle cx="44" cy="24" r="3.5" fill="${a}"/><circle cx="34" cy="-38" r="2.5" fill="${a}"/>`,
  bolt: (a) => `<path d="M10 -44 L-24 6 L-2 6 L-12 44 L26 -10 L4 -10Z" fill="${a}"/>`,
};

/**
 * Coffee bag, local box 300×510.
 */
function bag({ body = C.espresso, label = C.cream, ink = C.espresso, accent = C.terracotta, motif = 'sun', title = 'ESPRESSO', sub = 'BLEND', weight = '250 g', bodyStroke = 'none' }) {
  const shape = 'M14 24 L286 24 L300 482 Q300 500 282 500 L18 500 Q0 500 0 482 Z';
  let crimps = '';
  for (let i = 0; i < 26; i++) crimps += `<line x1="${22 + i * 10.3}" y1="5" x2="${22 + i * 10.3}" y2="25" stroke="#000" stroke-opacity=".14" stroke-width="2"/>`;
  const size = title.length > 11 ? 21 : title.length > 8 ? 25 : 30;
  return `<ellipse cx="150" cy="502" rx="158" ry="13" fill="#2a1a12" opacity=".16"/>` +
    `<path d="${shape}" fill="${body}" stroke="${bodyStroke}"/><path d="${shape}" fill="url(#vol)"/>` +
    `<rect x="12" y="0" width="276" height="30" rx="3" fill="${body}"/><rect x="12" y="0" width="276" height="30" rx="3" fill="#000" opacity=".1"/>${crimps}` +
    `<circle cx="248" cy="74" r="12" fill="#000" opacity=".16"/><circle cx="248" cy="74" r="5" fill="#000" opacity=".25"/>` +
    `<rect x="38" y="118" width="224" height="300" rx="5" fill="${label}"/>` +
    `<text class="t" x="150" y="153" text-anchor="middle" font-size="15" letter-spacing="7" fill="${ink}">SAMO</text>` +
    `<line x1="62" y1="168" x2="238" y2="168" stroke="${ink}" stroke-opacity=".25" stroke-width="1.5"/>` +
    `<g transform="translate(150 232)">${MOTIFS[motif](accent, ink)}</g>` +
    `<text class="t" x="150" y="322" text-anchor="middle" font-size="${size}" letter-spacing="${title.length > 9 ? 1 : 2.5}" fill="${ink}">${title}</text>` +
    `<text class="t" x="150" y="347" text-anchor="middle" font-size="12.5" letter-spacing="3.5" fill="${ink}" opacity=".7">${sub}</text>` +
    `<rect x="38" y="378" width="224" height="40" rx="0" fill="${accent}"/><path d="M38 378h224v35a5 5 0 0 1-5 5h-214a5 5 0 0 1-5-5z" fill="${accent}"/>` +
    `<text class="t" x="150" y="404" text-anchor="middle" font-size="14" letter-spacing="4" fill="${label}">${weight.toUpperCase()}</text>`;
}

/** Pour-over dripper on a glass server, local box 200×330. */
function dripper({ cone = C.paper, coffee = C.espresso, accent = C.terracotta, level = 0.5 } = {}) {
  const top = 150 + (1 - level) * 150;
  let ribs = '';
  for (let i = 0; i < 6; i++) ribs += `<path d="M${40 + i * 24} 14 Q ${62 + i * 15} 60 ${82 + i * 7} 98" fill="none" stroke="#000" stroke-opacity=".09" stroke-width="3"/>`;
  return `<ellipse cx="100" cy="322" rx="104" ry="10" fill="#2a1a12" opacity=".15"/>` +
    // server
    `<path d="M40 128 L160 128 L186 300 Q187 316 172 316 L28 316 Q13 316 14 300 Z" fill="#fff" opacity=".35"/>` +
    `<path d="M${16 + (top - 128) * -0.02} ${top} L${184 + (top - 128) * 0.02} ${top} L186 300 Q187 316 172 316 L28 316 Q13 316 14 300 Z" fill="${coffee}"/>` +
    `<path d="M40 128 L160 128 L186 300 Q187 316 172 316 L28 316 Q13 316 14 300 Z" fill="none" stroke="${C.espresso}" stroke-opacity=".55" stroke-width="3.5"/>` +
    `<path d="M36 150 L24 296" stroke="#fff" stroke-opacity=".55" stroke-width="5" stroke-linecap="round"/>` +
    `<path d="M100 112 L100 ${top}" stroke="${coffee}" stroke-width="3" stroke-dasharray="2 9" stroke-linecap="round"/>` +
    // base plate + cone
    `<rect x="26" y="104" width="148" height="12" rx="6" fill="${cone}"/><rect x="26" y="104" width="148" height="12" rx="6" fill="#000" opacity=".12"/>` +
    `<path d="M12 12 L188 12 L124 106 L76 106 Z" fill="${cone}"/><path d="M12 12 L188 12 L124 106 L76 106 Z" fill="url(#vol)"/>${ribs}` +
    `<rect x="4" y="0" width="192" height="18" rx="9" fill="${cone}"/><rect x="4" y="0" width="192" height="18" rx="9" fill="#000" opacity=".06"/>` +
    `<path d="M178 30 q 40 6 22 44 q -10 18 -44 22" fill="none" stroke="${cone}" stroke-width="13" stroke-linecap="round"/>` +
    `<path d="M178 30 q 40 6 22 44 q -10 18 -44 22" fill="none" stroke="#000" stroke-opacity=".08" stroke-width="13" stroke-linecap="round"/>` +
    `<path d="M24 20 L176 20" stroke="${accent}" stroke-width="4" stroke-linecap="round"/>`;
}

/** Cup seen from above, centered at 0,0, radius ~100. */
function cupTop({ cup = C.paper, coffee = C.brown, saucer = C.blush, crema = '#8a5a3a' } = {}) {
  return `<ellipse cx="6" cy="10" rx="128" ry="128" fill="#2a1a12" opacity=".12"/><circle r="126" fill="${saucer}"/><circle r="126" fill="none" stroke="#000" stroke-opacity=".06" stroke-width="6"/>` +
    `<circle r="100" fill="#000" opacity=".06"/>` +
    `<path d="M70 -60 q 76 -40 84 10 q 2 40 -66 30" fill="none" stroke="${cup}" stroke-width="20" stroke-linecap="round"/>` +
    `<circle r="88" fill="${cup}"/><circle r="74" fill="${coffee}"/><circle r="74" fill="none" stroke="${crema}" stroke-width="7" opacity=".7"/>` +
    `<path d="M-40 -34 a52 52 0 0 1 60 -18" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="6" stroke-linecap="round"/>`;
}

/** Mug side view, local box 180×150. */
function mug({ cup = C.paper, band = C.terracotta } = {}) {
  return `<ellipse cx="80" cy="148" rx="96" ry="9" fill="#2a1a12" opacity=".15"/>` +
    `<path d="M150 40 q 52 4 44 44 q -6 30 -52 34" fill="none" stroke="${cup}" stroke-width="16" stroke-linecap="round"/>` +
    `<path d="M0 0 H160 L148 122 Q146 146 122 146 H38 Q14 146 12 122 Z" fill="${cup}"/><path d="M0 0 H160 L148 122 Q146 146 122 146 H38 Q14 146 12 122 Z" fill="url(#vol)"/>` +
    `<path d="M5 52 H155 L152 84 H8 Z" fill="${band}"/><ellipse cx="80" cy="3" rx="80" ry="7" fill="${C.brown}"/>`;
}

/** Hand grinder, local box 150×330. */
function grinder({ body = C.espresso, metal = '#c9c2b8', accent = C.terracotta } = {}) {
  return `<ellipse cx="75" cy="324" rx="86" ry="9" fill="#2a1a12" opacity=".15"/>` +
    `<path d="M70 44 L70 18 L190 18" fill="none" stroke="${metal}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<circle cx="196" cy="2" r="17" fill="${accent}"/><rect x="189" y="2" width="14" height="22" rx="5" fill="${metal}"/>` +
    `<rect x="52" y="36" width="46" height="18" rx="5" fill="${metal}"/>` +
    `<rect x="14" y="50" width="122" height="150" rx="14" fill="${body}"/><rect x="14" y="50" width="122" height="150" rx="14" fill="url(#vol)"/>` +
    `<rect x="14" y="118" width="122" height="16" fill="${accent}"/>` +
    `<rect x="8" y="196" width="134" height="18" rx="6" fill="${metal}"/>` +
    `<rect x="18" y="212" width="114" height="108" rx="12" fill="#fff" opacity=".4"/><rect x="18" y="262" width="114" height="58" rx="10" fill="${C.brown}"/>` +
    `<rect x="18" y="212" width="114" height="108" rx="12" fill="none" stroke="${C.espresso}" stroke-opacity=".5" stroke-width="3"/>` +
    `<path d="M30 226 L30 300" stroke="#fff" stroke-opacity=".6" stroke-width="5" stroke-linecap="round"/>`;
}

/** Gooseneck kettle, local box 330×260. */
function kettle({ body = C.espresso, accent = C.terracotta, wood = C.kraft } = {}) {
  return `<ellipse cx="170" cy="254" rx="130" ry="10" fill="#2a1a12" opacity=".15"/>` +
    `<path d="M98 210 C 40 200, 60 110, 22 86 C 8 78, 2 70, 0 58" fill="none" stroke="${body}" stroke-width="13" stroke-linecap="round"/>` +
    `<path d="M252 92 C 330 84, 336 190, 262 206" fill="none" stroke="${wood}" stroke-width="17" stroke-linecap="round"/>` +
    `<path d="M112 70 H236 L262 236 Q263 250 248 250 H100 Q85 250 86 236 Z" fill="${body}"/><path d="M112 70 H236 L262 236 Q263 250 248 250 H100 Q85 250 86 236 Z" fill="url(#vol)"/>` +
    `<rect x="104" y="58" width="140" height="16" rx="8" fill="${body}"/><rect x="104" y="58" width="140" height="16" rx="8" fill="#fff" opacity=".1"/>` +
    `<rect x="160" y="34" width="28" height="26" rx="8" fill="${wood}"/>` +
    `<circle cx="174" cy="172" r="26" fill="${C.cream}"/><circle cx="174" cy="172" r="26" fill="none" stroke="${accent}" stroke-width="4"/>` +
    `<line x1="174" y1="172" x2="188" y2="158" stroke="${accent}" stroke-width="4" stroke-linecap="round"/><circle cx="174" cy="172" r="4" fill="${C.espresso}"/>`;
}

/** Carton box of drip bags, local box 360×330. */
function dripBox({ box = C.kraft, label = C.cream, ink = C.espresso, accent = C.terracotta, title = 'DRIP', sub = 'ETHIOPIA', count = '10 PCS' } = {}) {
  return `<ellipse cx="180" cy="326" rx="196" ry="11" fill="#2a1a12" opacity=".15"/>` +
    `<path d="M20 70 L60 28 H340 L300 70 Z" fill="${box}"/><path d="M20 70 L60 28 H340 L300 70 Z" fill="#fff" opacity=".18"/>` +
    `<path d="M300 70 L340 28 V282 L300 322 Z" fill="${box}"/><path d="M300 70 L340 28 V282 L300 322 Z" fill="#000" opacity=".2"/>` +
    `<rect x="20" y="70" width="280" height="252" fill="${box}"/><rect x="20" y="70" width="280" height="252" fill="url(#vol)" opacity=".6"/>` +
    `<rect x="44" y="96" width="232" height="200" rx="4" fill="${label}"/>` +
    `<text class="t" x="160" y="126" text-anchor="middle" font-size="13" letter-spacing="6" fill="${ink}">SAMO</text>` +
    // tiny drip-bag pictogram
    `<g transform="translate(160 176)"><path d="M-46 -22 H46 L34 14 H-34 Z" fill="${accent}"/><path d="M-58 -22 H58" stroke="${ink}" stroke-width="5" stroke-linecap="round"/>` +
    `<path d="M-30 18 H30 L26 34 Q25 40 19 40 H-19 Q-25 40 -26 34 Z" fill="${ink}"/><path d="M0 14 V20" stroke="${ink}" stroke-width="3" stroke-dasharray="2 4"/></g>` +
    `<text class="t" x="160" y="250" text-anchor="middle" font-size="27" letter-spacing="3" fill="${ink}">${title}</text>` +
    `<text class="t" x="160" y="274" text-anchor="middle" font-size="12" letter-spacing="3.5" fill="${ink}" opacity=".7">${sub} · ${count}</text>`;
}

/** Single drip sachet, local box 150×190. */
function sachet({ color = C.terracotta, ink = C.cream } = {}) {
  let z = 'M0 10';
  for (let i = 0; i < 15; i++) z += ` L${5 + i * 10} ${i % 2 ? 10 : 0}`;
  return `<path d="${z} L150 10 V180 H0 Z" fill="${color}"/><path d="M0 10 H150 V180 H0 Z" fill="url(#vol)"/>` +
    `<circle cx="75" cy="92" r="34" fill="none" stroke="${ink}" stroke-width="3"/><text class="t" x="75" y="103" text-anchor="middle" font-size="32" fill="${ink}">S</text>` +
    `<text class="t" x="75" y="158" text-anchor="middle" font-size="11" letter-spacing="4" fill="${ink}">DRIP BAG</text>`;
}

const tile = (w, h, color, rx = 0) => `<rect width="${w}" height="${h}" rx="${rx}" fill="${color}"/>`;
const blob = (cx, cy, r, color, o = 1) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" opacity="${o}"/>`;
const write = (name, content) => {
  const file = path.join(out, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

// ─────────────────────────────── products (800×800)

const PRODUCTS = [
  // slug, kind, options
  ['espresso-tashkent', 'bag', { bg: C.blush, spot: C.terracotta, body: C.espresso, label: C.cream, accent: C.terracotta, motif: 'ikat', title: 'TASHKENT', sub: 'ESPRESSO BLEND' }],
  ['brazil-cerrado', 'bag', { bg: C.butter, spot: C.honey, body: C.brown, label: C.paper, accent: C.honey, motif: 'sun', title: 'BRAZIL', sub: 'CERRADO · NATURAL' }],
  ['colombia-huila', 'bag', { bg: C.mint, spot: C.sage, body: C.moss, label: C.cream, accent: C.clay, motif: 'mountains', title: 'COLOMBIA', sub: 'HUILA · WASHED' }],
  ['ethiopia-yirgacheffe', 'bag', { bg: C.rose, spot: C.berry, body: C.cream, label: C.berry, ink: C.cream, accent: C.honey, motif: 'flower', title: 'ETHIOPIA', sub: 'YIRGACHEFFE', bodyStroke: C.tan }],
  ['kenya-nyeri', 'bag', { bg: C.blush, spot: C.clay, body: C.kraft, label: C.espresso, ink: C.cream, accent: C.clay, motif: 'berries', title: 'KENYA', sub: 'NYERI AA · WASHED' }],
  ['rwanda-nyamasheke', 'bag', { bg: C.mist, spot: C.sky, body: C.sky, label: C.cream, accent: C.terracotta, motif: 'waves', title: 'RWANDA', sub: 'NYAMASHEKE' }],
  ['decaf-colombia', 'bag', { bg: C.sand, spot: C.plum, body: C.plum, label: C.cream, accent: C.honey, ink: C.plum, motif: 'moon', title: 'DECAF', sub: 'COLOMBIA · SUGARCANE' }],
  ['drip-ethiopia', 'drip', { bg: C.rose, spot: C.berry, box: C.kraft, accent: C.berry, title: 'DRIP', sub: 'ETHIOPIA', sachet: C.berry }],
  ['drip-assorted', 'drip', { bg: C.butter, spot: C.terracotta, box: C.espresso, label: C.cream, accent: C.terracotta, title: 'DRIP MIX', sub: 'ASSORTED', count: '12 PCS', sachet: C.terracotta }],
  ['v60-dripper', 'dripper', { bg: C.mint, spot: C.sage }],
  ['hand-grinder', 'grinder', { bg: C.sand, spot: C.kraft }],
  ['gooseneck-kettle', 'kettle', { bg: C.blush, spot: C.terracotta }],
];

function productArt(kind, o) {
  let inner = tile(800, 800, o.bg) + blob(400, 410, 290, C.paper, 0.55) + blob(610, 200, 74, o.spot, 0.9);
  if (kind === 'bag') {
    inner += beans(o.title.length * 7, 5, [90, 610, 130, 90]) + g(232, 132, 1.12, bag(o)) + beans(o.title.length * 13 + 1, 4, [590, 640, 120, 70]);
  } else if (kind === 'drip') {
    inner += g(170, 232, 1.08, dripBox(o)) + g(520, 430, 1.0, sachet({ color: o.sachet }), 9) + beans(77, 4, [110, 650, 120, 60]);
  } else if (kind === 'dripper') {
    inner += g(250, 190, 1.5, dripper({ level: 0.42, cone: C.clay, accent: C.cream })) + steam(400, 170, 1.3) + beans(5, 5, [560, 640, 150, 70]);
  } else if (kind === 'grinder') {
    inner += g(290, 170, 1.45, grinder()) + beans(9, 7, [110, 610, 170, 90]) + beans(10, 3, [590, 660, 100, 50]);
  } else if (kind === 'kettle') {
    inner += g(160, 240, 1.5, kettle()) + steam(160, 320, 1.1) + beans(12, 4, [560, 660, 150, 50]);
  }
  return svg(800, 800, inner, { font: kind === 'bag' || kind === 'drip' });
}
for (const [slug, kind, o] of PRODUCTS) write(`products/${slug}.svg`, productArt(kind, o));

// ─────────────────────────────── categories (800×600)

write('categories/espresso.svg', svg(800, 600, tile(800, 600, C.espresso) + blob(400, 320, 230, C.brown, 0.6) + g(400, 310, 1.25, cupTop({ saucer: C.terracotta, coffee: '#3a2216' })) + beans(21, 9, [40, 60, 180, 480], { colors: [C.mocha, C.brown] }) + beans(22, 7, [600, 80, 160, 460], { colors: [C.mocha, C.brown] })));
write('categories/filter.svg', svg(800, 600, tile(800, 600, C.mint) + blob(400, 330, 240, C.paper, 0.6) + blob(640, 130, 60, C.honey) + g(280, 110, 1.3, dripper({ level: 0.55 })) + steam(410, 96, 1.1) + sprig(110, 560, 1.3, -8) + beans(31, 5, [560, 460, 180, 80])));
write('categories/drip.svg', svg(800, 600, tile(800, 600, C.butter) + blob(400, 320, 240, C.paper, 0.55) + g(200, 190, 1.25, sachet({ color: C.terracotta }), -10) + g(360, 150, 1.35, sachet({ color: C.espresso }), 4) + g(520, 230, 1.2, sachet({ color: C.sage }), 14) + beans(41, 5, [60, 480, 200, 70]), { font: true }));
write('categories/accessories.svg', svg(800, 600, tile(800, 600, C.blush) + blob(400, 320, 250, C.paper, 0.55) + g(150, 190, 1.05, kettle()) + g(540, 150, 1.15, grinder()) + beans(51, 6, [300, 500, 220, 60])));

// ─────────────────────────────── hero + page illustrations

write('hero.svg', svg(1100, 960,
  blob(600, 470, 380, C.terracotta) + blob(600, 470, 380, 'url(#heroShade)') + blob(905, 150, 78, C.honey) + blob(170, 250, 44, C.sage, 0.9) +
  `<circle cx="600" cy="470" r="430" fill="none" stroke="${C.espresso}" stroke-opacity=".14" stroke-width="2" stroke-dasharray="3 12"/>` +
  sprig(960, 760, 1.7, 14) + sprig(210, 640, 1.25, -24, C.moss) +
  g(310, 150, 1.36, bag({ body: C.espresso, label: C.cream, accent: C.terracotta, motif: 'ikat', title: 'TASHKENT', sub: 'ESPRESSO BLEND' }), -5) +
  g(640, 340, 1.5, dripper({ level: 0.5 })) + steam(790, 310, 1.5, C.cream, 0.55) +
  g(330, 800, 0.92, cupTop({ saucer: C.cream, coffee: '#3a2216' })) +
  beans(101, 9, [500, 850, 420, 80]) + beans(102, 4, [80, 420, 120, 120]),
  { font: true, defs: `<radialGradient id="heroShade" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#fff" stop-opacity=".2"/><stop offset="1" stop-color="#000" stop-opacity=".12"/></radialGradient>` }));

write('story.svg', svg(900, 760,
  tile(900, 760, C.sand, 28) + blob(660, 260, 210, C.blush) + blob(180, 600, 120, C.mint) +
  g(120, 130, 1.0, bag({ body: C.kraft, label: C.espresso, ink: C.cream, accent: C.clay, motif: 'berries', title: 'KENYA', sub: 'NYERI AA' }), -4) +
  g(430, 100, 1.08, bag({ body: C.cream, label: C.berry, ink: C.cream, accent: C.honey, motif: 'flower', title: 'ETHIOPIA', sub: 'YIRGACHEFFE', bodyStroke: C.tan }), 3) +
  g(690, 560, 0.72, cupTop({ saucer: C.terracotta })) + beans(201, 12, [80, 640, 500, 80]) + sprig(820, 330, 1.1, 20),
  { font: true }));

write('about.svg', svg(1200, 800,
  tile(1200, 800, C.espresso, 28) + blob(880, 300, 300, C.brown, 0.7) + blob(230, 640, 180, C.terracotta, 0.9) +
  // stylized drum roaster
  `<g transform="translate(360 150)"><rect x="150" y="360" width="50" height="170" fill="${C.mocha}"/><rect x="330" y="360" width="50" height="170" fill="${C.mocha}"/><rect x="100" y="520" width="330" height="26" rx="8" fill="${C.kraft}"/>` +
  `<path d="M70 20 L220 20 L190 120 L100 120Z" fill="${C.kraft}"/><rect x="60" y="6" width="170" height="22" rx="8" fill="${C.cream}"/>` +
  `<rect x="60" y="120" width="420" height="250" rx="60" fill="${C.cream}"/><rect x="60" y="120" width="420" height="250" rx="60" fill="url(#vol)"/>` +
  `<circle cx="330" cy="245" r="92" fill="${C.espresso}"/><circle cx="330" cy="245" r="92" fill="none" stroke="${C.terracotta}" stroke-width="12"/><circle cx="330" cy="245" r="60" fill="${C.brown}"/>` +
  bean(310, 230, 20, 30, C.mocha, '#1c110b') + bean(350, 262, 18, 100, C.mocha, '#1c110b') + bean(322, 276, 14, 160, '#7b5946', '#1c110b') +
  `<circle cx="140" cy="200" r="26" fill="${C.terracotta}"/><line x1="140" y1="200" x2="156" y2="184" stroke="${C.cream}" stroke-width="5" stroke-linecap="round"/><rect x="110" y="260" width="110" height="14" rx="7" fill="${C.tan}"/><rect x="110" y="290" width="70" height="14" rx="7" fill="${C.tan}"/>` +
  `<path d="M480 300 h70 l40 120 h-150" fill="${C.kraft}"/><ellipse cx="520" cy="430" rx="120" ry="24" fill="${C.cream}"/><ellipse cx="520" cy="426" rx="104" ry="17" fill="${C.brown}"/></g>` +
  steam(500, 150, 1.6, C.cream, 0.35) + beans(301, 10, [90, 120, 220, 300], { colors: [C.mocha, '#7b5946'] }) + sprig(1080, 720, 1.5, 10, C.sage)));

write('subscription.svg', svg(1000, 760,
  tile(1000, 760, C.mint, 28) + blob(500, 400, 300, C.paper, 0.6) + blob(830, 150, 70, C.honey) +
  `<path d="M210 400 a290 290 0 0 1 560 -110" fill="none" stroke="${C.terracotta}" stroke-width="7" stroke-linecap="round" stroke-dasharray="2 18"/><path d="M780 250 l-6 46 l-38 -26z" fill="${C.terracotta}"/>` +
  `<path d="M790 420 a290 290 0 0 1 -560 110" fill="none" stroke="${C.terracotta}" stroke-width="7" stroke-linecap="round" stroke-dasharray="2 18"/><path d="M220 570 l6 -46 l38 26z" fill="${C.terracotta}"/>` +
  g(190, 200, 0.84, bag({ body: C.brown, label: C.paper, accent: C.honey, motif: 'sun', title: 'BRAZIL', sub: 'CERRADO' }), -7) +
  g(560, 200, 0.84, bag({ body: C.sky, label: C.cream, accent: C.terracotta, motif: 'waves', title: 'RWANDA', sub: 'NYAMASHEKE' }), 7) +
  g(360, 150, 1.0, bag({ body: C.espresso, label: C.cream, accent: C.terracotta, motif: 'ikat', title: 'TASHKENT', sub: 'ESPRESSO BLEND' })) +
  beans(401, 8, [120, 660, 760, 60]), { font: true }));

write('delivery.svg', svg(1000, 760,
  tile(1000, 760, C.blush, 28) + blob(500, 420, 300, C.paper, 0.55) +
  `<path d="M120 610 C 260 520, 330 660, 470 560 S 720 520, 880 420" fill="none" stroke="${C.espresso}" stroke-opacity=".35" stroke-width="6" stroke-dasharray="4 16" stroke-linecap="round"/>` +
  `<g transform="translate(850 330)"><path d="M0 90 C -52 30, -46 -40, 0 -40 C 46 -40, 52 30, 0 90Z" fill="${C.terracotta}"/><circle cy="-2" r="17" fill="${C.cream}"/></g>` +
  `<g transform="translate(120 560)"><circle r="20" fill="${C.espresso}"/><circle r="8" fill="${C.cream}"/></g>` +
  // parcel box
  `<g transform="translate(300 250)"><ellipse cx="200" cy="330" rx="230" ry="14" fill="#2a1a12" opacity=".15"/><path d="M0 90 L200 30 L400 90 L200 150Z" fill="${C.kraft}"/><path d="M0 90 L200 30 L400 90 L200 150Z" fill="#fff" opacity=".2"/>` +
  `<path d="M0 90 V260 L200 322 V150Z" fill="${C.kraft}"/><path d="M400 90 V260 L200 322 V150Z" fill="${C.kraftDark}"/>` +
  `<path d="M100 60 L300 120 V190 L270 168 L250 196 V135 L60 76Z" fill="${C.terracotta}"/>` +
  `<g transform="translate(60 180) skewY(17)"><rect width="90" height="56" rx="4" fill="${C.cream}"/><rect x="10" y="12" width="52" height="7" rx="3" fill="${C.espresso}" opacity=".7"/><rect x="10" y="28" width="68" height="6" rx="3" fill="${C.espresso}" opacity=".35"/><rect x="10" y="40" width="40" height="6" rx="3" fill="${C.espresso}" opacity=".35"/></g></g>` +
  g(600, 90, 0.5, bag({ body: C.espresso, label: C.cream, accent: C.terracotta, motif: 'ikat', title: 'TASHKENT', sub: 'ESPRESSO' }), 12) +
  beans(501, 6, [140, 660, 300, 50]) + sprig(110, 300, 1.2, -18), { font: true }));

write('contacts.svg', svg(1000, 760,
  tile(1000, 760, C.sand, 28) + blob(790, 170, 90, C.honey) +
  `<rect x="0" y="640" width="1000" height="120" fill="${C.tan}"/><path d="M0 640 H1000" stroke="${C.espresso}" stroke-opacity=".2" stroke-width="3"/>` +
  // storefront
  `<g transform="translate(210 170)"><rect width="580" height="470" fill="${C.espresso}"/><rect width="580" height="470" fill="url(#vol)" opacity=".5"/>` +
  `<rect x="40" y="26" width="500" height="70" rx="6" fill="${C.cream}"/><text class="t" x="290" y="74" text-anchor="middle" font-size="40" letter-spacing="10" fill="${C.espresso}">SAMO COFFEE</text>` +
  Array.from({ length: 8 }, (_, i) => `<path d="M${-20 + i * 77.5} 120 h77.5 v58 a38.75 26 0 0 1 -77.5 0z" fill="${i % 2 ? C.cream : C.terracotta}"/>`).join('') +
  `<rect x="40" y="230" width="290" height="190" rx="6" fill="${C.mist}"/><rect x="40" y="230" width="290" height="190" rx="6" fill="#fff" opacity=".25"/><path d="M60 400 L170 250 M110 400 L200 280" stroke="#fff" stroke-opacity=".6" stroke-width="10" stroke-linecap="round"/>` +
  `<rect x="380" y="230" width="160" height="240" rx="6" fill="${C.kraft}"/><rect x="400" y="250" width="120" height="120" rx="4" fill="${C.mist}"/><circle cx="402" cy="400" r="8" fill="${C.cream}"/>` +
  g(210, 310, 0.42, mug({})) + g(90, 318, 0.2, bag({ body: C.terracotta, label: C.cream, title: 'SAMO', sub: '', motif: 'sun' })) + `</g>` +
  // plant + bench
  `<path d="M120 640 l14 -90 h72 l14 90z" fill="${C.terracotta}"/>` + sprig(170, 556, 1.4, -6) + sprig(170, 556, 1.2, 22, C.moss) +
  `<g transform="translate(820 540)"><rect x="0" y="40" width="120" height="14" rx="5" fill="${C.kraft}"/><rect x="10" y="54" width="10" height="46" fill="${C.kraftDark}"/><rect x="100" y="54" width="10" height="46" fill="${C.kraftDark}"/></g>`,
  { font: true }));

write('404.svg', svg(900, 700,
  blob(450, 350, 300, C.blush) + g(450, 360, 1.7, cupTop({ saucer: C.cream, coffee: C.paper, crema: C.tan })) +
  `<path d="M360 330 a96 96 0 0 1 150 -60" fill="none" stroke="${C.mocha}" stroke-opacity=".5" stroke-width="7" stroke-linecap="round"/>` +
  `<text class="t" x="450" y="396" text-anchor="middle" font-size="92" fill="${C.espresso}" opacity=".85">404</text>` +
  beans(601, 6, [80, 520, 220, 120]) + beans(602, 5, [640, 80, 180, 140]) + sprig(780, 640, 1.2, 12), { font: true }));

write('tma-banner.svg', svg(1200, 520,
  tile(1200, 520, C.espresso) + blob(940, 260, 300, C.terracotta) + blob(1120, 80, 60, C.honey) +
  g(760, 60, 0.82, bag({ body: C.cream, label: C.berry, ink: C.cream, accent: C.honey, motif: 'flower', title: 'ETHIOPIA', sub: 'YIRGACHEFFE' }), -6) +
  g(960, 90, 0.78, bag({ body: C.brown, label: C.paper, accent: C.honey, motif: 'sun', title: 'BRAZIL', sub: 'CERRADO' }), 8) +
  g(620, 400, 0.6, cupTop({ saucer: C.cream })) + beans(701, 8, [60, 380, 420, 100], { colors: [C.mocha, '#7b5946'] }) + sprig(540, 500, 1.1, -12, C.sage),
  { font: true }));

// ─────────────────────────────── plans (800×600)

const planArt = (bg, bags) => svg(800, 600, tile(800, 600, bg) + blob(400, 320, 240, C.paper, 0.55) + bags + beans(bags.length, 6, [80, 500, 640, 60]), { font: true });
write('plans/plan-1.svg', planArt(C.blush, g(275, 90, 0.84, bag({ title: 'TASHKENT', sub: 'ESPRESSO BLEND', motif: 'ikat' }))));
write('plans/plan-2.svg', planArt(C.mint,
  g(170, 100, 0.8, bag({ body: C.moss, label: C.cream, accent: C.clay, motif: 'mountains', title: 'COLOMBIA', sub: 'HUILA' }), -5) +
  g(400, 100, 0.8, bag({ body: C.cream, label: C.berry, ink: C.cream, accent: C.honey, motif: 'flower', title: 'ETHIOPIA', sub: 'YIRGACHEFFE', bodyStroke: C.tan }), 5)));
write('plans/plan-3.svg', planArt(C.butter,
  g(90, 150, 0.68, bag({ body: C.brown, label: C.paper, accent: C.honey, motif: 'sun', title: 'BRAZIL', sub: 'CERRADO' }), -8) +
  g(510, 150, 0.68, bag({ body: C.sky, label: C.cream, accent: C.terracotta, motif: 'waves', title: 'RWANDA', sub: 'NYAMASHEKE' }), 8) +
  g(262, 60, 0.92, bag({ title: 'OFFICE', sub: 'ESPRESSO BLEND', motif: 'bolt', weight: '1 kg' }))));

// ─────────────────────────────── blog covers (1200×750)

write('blog/cover-1.svg', svg(1200, 750, tile(1200, 750, C.mint) + blob(600, 400, 330, C.paper, 0.55) + blob(980, 150, 80, C.honey) +
  g(420, 120, 1.75, dripper({ level: 0.6 })) + steam(600, 110, 1.6) + g(180, 300, 1.0, kettle(), -14) + beans(801, 8, [820, 560, 300, 110]) + sprig(110, 720, 1.4, -6)));
write('blog/cover-2.svg', svg(1200, 750, tile(1200, 750, C.rose) +
  `<path d="M0 520 L220 300 L380 430 L560 220 L760 440 L900 330 L1200 560 V750 H0Z" fill="${C.berry}" opacity=".85"/><path d="M0 610 L260 450 L470 560 L700 420 L960 580 L1200 480 V750 H0Z" fill="${C.plum}"/>` +
  blob(900, 170, 90, C.honey) + `<path d="M560 220 L600 268 L570 280 L540 262Z" fill="#fff" opacity=".6"/>` +
  sprig(240, 700, 2.2, -4, C.sage) + sprig(330, 720, 1.8, 16, C.moss) +
  [[230, 470], [262, 505], [205, 520], [330, 560], [368, 590]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="17" fill="${C.terracotta}"/><circle cx="${x - 5}" cy="${y - 5}" r="5" fill="#fff" opacity=".35"/>`).join('')));
write('blog/cover-3.svg', svg(1200, 750, tile(1200, 750, C.espresso) + blob(600, 380, 300, C.brown, 0.7) +
  // roast curve chart
  `<g transform="translate(180 130)"><rect width="840" height="480" rx="18" fill="${C.cream}"/>` +
  Array.from({ length: 5 }, (_, i) => `<line x1="60" x2="790" y1="${80 + i * 80}" y2="${80 + i * 80}" stroke="${C.espresso}" stroke-opacity=".12" stroke-width="2"/>`).join('') +
  `<path d="M60 150 C 120 330, 180 340, 250 300 S 470 150, 790 90" fill="none" stroke="${C.terracotta}" stroke-width="8" stroke-linecap="round"/>` +
  `<path d="M60 400 C 240 380, 420 300, 790 240" fill="none" stroke="${C.sky}" stroke-width="6" stroke-linecap="round" stroke-dasharray="3 14"/>` +
  `<circle cx="585" cy="140" r="14" fill="${C.cream}" stroke="${C.terracotta}" stroke-width="7"/><line x1="585" y1="160" x2="585" y2="400" stroke="${C.espresso}" stroke-opacity=".3" stroke-width="3" stroke-dasharray="6 8"/>` +
  `<text class="t" x="604" y="124" font-size="24" fill="${C.espresso}">first crack</text></g>` +
  beans(901, 9, [60, 600, 300, 110], { colors: [C.mocha, '#7b5946'] }) + beans(902, 6, [900, 40, 240, 120], { colors: [C.mocha, '#7b5946'] }), { font: true }));
write('blog/cover-4.svg', svg(1200, 750, tile(1200, 750, C.butter) + blob(600, 380, 320, C.paper, 0.55) + blob(210, 170, 70, C.terracotta) +
  // cold brew glass
  `<g transform="translate(480 110)"><ellipse cx="120" cy="528" rx="150" ry="14" fill="#2a1a12" opacity=".15"/><path d="M0 0 H240 L210 500 Q208 524 184 524 H56 Q32 524 30 500Z" fill="#fff" opacity=".4"/>` +
  `<path d="M9 150 H231 L210 500 Q208 524 184 524 H56 Q32 524 30 500Z" fill="${C.brown}"/><path d="M9 150 H231 L226 230 H14Z" fill="${C.mocha}"/>` +
  `<rect x="60" y="120" width="70" height="70" rx="12" fill="#fff" opacity=".55" transform="rotate(-12 95 155)"/><rect x="130" y="170" width="64" height="64" rx="12" fill="#fff" opacity=".45" transform="rotate(18 162 202)"/><rect x="70" y="250" width="60" height="60" rx="12" fill="#fff" opacity=".3" transform="rotate(8 100 280)"/>` +
  `<path d="M0 0 H240 L210 500 Q208 524 184 524 H56 Q32 524 30 500Z" fill="none" stroke="${C.espresso}" stroke-opacity=".5" stroke-width="4"/><path d="M22 30 L44 480" stroke="#fff" stroke-opacity=".7" stroke-width="7" stroke-linecap="round"/>` +
  `<path d="M150 -90 L176 300" stroke="${C.terracotta}" stroke-width="12" stroke-linecap="round"/></g>` +
  `<g transform="translate(860 480)"><circle r="78" fill="${C.honey}"/><circle r="64" fill="${C.butter}"/>` + Array.from({ length: 8 }, (_, i) => `<line y2="-60" stroke="${C.honey}" stroke-width="4" transform="rotate(${i * 45})"/>`).join('') + `</g>` +
  sprig(260, 700, 1.7, -10) + beans(1001, 6, [820, 600, 280, 90])));

// ─────────────────────────────── brand

const mark = (ink, accent) => `<circle cx="24" cy="24" r="24" fill="${accent}"/>` +
  `<g transform="translate(24 24) rotate(-28)"><ellipse rx="13" ry="9" fill="${ink === C.cream ? C.cream : C.paper}"/><path d="M-10.5 0 C -4 -5.5, 4 5.5, 10.5 0" fill="none" stroke="${accent}" stroke-width="2.4" stroke-linecap="round"/></g>`;
const logo = (ink) => svg(190, 48, mark(ink, C.terracotta) +
  `<text class="t" x="60" y="30" font-size="29" fill="${ink}" letter-spacing=".4">Samo</text>` +
  `<text class="t" x="61.5" y="45" font-size="9.5" fill="${ink}" letter-spacing="5.2" opacity=".75">COFFEE</text>`, { font: true });
write('logo.svg', logo(C.espresso));
write('logo-light.svg', logo(C.cream));
write('favicon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">${mark(C.cream, C.terracotta)}</svg>\n`);
write('placeholder.svg', svg(800, 800, tile(800, 800, C.sand) + blob(400, 400, 230, C.paper, 0.6) + bean(400, 400, 110, -28, C.tan, C.sand)));
// social sharing card
write('og.svg', svg(1200, 630, tile(1200, 630, C.cream) + blob(930, 315, 300, C.terracotta) +
  g(760, 70, 0.95, bag({ title: 'TASHKENT', sub: 'ESPRESSO BLEND', motif: 'ikat' }), 6) +
  `<text class="t" x="90" y="300" font-size="110" fill="${C.espresso}">Samo</text><text class="t" x="96" y="360" font-size="30" letter-spacing="16" fill="${C.espresso}" opacity=".75">COFFEE</text>` +
  `<text class="t" x="96" y="450" font-size="30" fill="${C.terracotta}">Fresh roast · Tashkent</text>` + beans(1101, 7, [90, 500, 500, 70]), { font: true }));

console.log('art generated →', out);
