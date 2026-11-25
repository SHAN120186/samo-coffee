// Demo data seed: `npm run seed`.
// RESETS all business data (keeps admin accounts) and fills the DB with a realistic demo:
// catalog, plans, blog, FAQ, content blocks, ~60 days of analytics, orders, subscriptions, feedback.
// Deterministic (fixed PRNG seed), dates are relative to "now". Refuses to run in production
// unless called with --force.
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { db, tx, run, get, all, closeDb } from './index.js';
import * as auth from '../services/auth.js';
import * as content from '../services/content.js';
import * as settings from '../services/settings.js';
import * as catalog from '../services/catalog.js';
import * as subscriptions from '../services/subscriptions.js';
import * as posts from '../services/posts.js';
import * as faq from '../services/faq.js';
import { PAYMENT_PROVIDER_LABELS } from '../services/orders.js';
import { ensureSiteBlocks } from '../site/blocks.js';
import { CATEGORIES, PRODUCTS, PLANS, POSTS, FAQ, FEEDBACK } from './seedData.js';

const DAY = 86400000;
const DAYS = 60;

const WIPE = [
  'events', 'page_views', 'broadcasts', 'feedback_messages', 'feedback_threads', 'payments', 'order_events', 'order_items',
  'subscription_periods', 'subscriptions', 'orders', 'cart_items', 'carts', 'customers', 'tg_users', 'media', 'faq', 'posts', 'plans', 'products',
  'categories', 'content_blocks', 'settings',
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tables that hold the shop's own data: when all of them are empty the database is a fresh install. */
const BUSINESS_TABLES = ['products', 'categories', 'plans', 'posts', 'faq', 'orders', 'customers'];

/** True when the database has no catalog, content or orders yet (first boot of a new deployment). */
export function isEmptyDatabase() {
  return BUSINESS_TABLES.every((table) => get(`SELECT COUNT(*) AS n FROM ${table}`).n === 0);
}

/**
 * SEED_ON_EMPTY: load the demo data only into a fresh database. Nothing is deleted — settings and
 * content blocks that already exist are kept. Returns the seed summary, or null when data exists.
 */
export function seedIfEmpty({ quiet = true } = {}) {
  if (!isEmptyDatabase()) return null;
  return seed({ quiet, wipe: false });
}

/**
 * @param {{ quiet?: boolean, wipe?: boolean }} [options] wipe=false keeps whatever is in the database
 *   (used by seedIfEmpty on a fresh install); the default resets all business data first.
 */
export function seed({ quiet = false, wipe = true } = {}) {
  const log = (...a) => { if (!quiet) console.log(...a); };
  const rand = mulberry32(20261124);
  const chance = (p) => rand() < p;
  const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const weighted = (pairs) => {
    const total = pairs.reduce((s, [, w]) => s + w, 0);
    let r = rand() * total;
    for (const [v, w] of pairs) {
      r -= w;
      if (r <= 0) return v;
    }
    return pairs[pairs.length - 1][0];
  };
  const hex = (n) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
  const iso = (ms) => new Date(ms).toISOString();

  const nowMs = Date.now();
  const off = config.tzOffsetMinutes * 60000;
  const today0 = Math.floor((nowMs + off) / DAY) * DAY - off; // local midnight (UTC ms)

  // ───────────── reset
  if (wipe) {
    tx(() => {
      for (const table of WIPE) db.exec(`DELETE FROM ${table}`);
      db.exec(`DELETE FROM sqlite_sequence WHERE name IN (${WIPE.map((t) => `'${t}'`).join(',')})`);
    });
  }
  settings.clearCache();
  content.clearCache();
  auth.ensureDefaultAdmin();
  content.ensureDefaults();
  ensureSiteBlocks(); // the public site's extra blocks, so Admin → Контент is complete right after seeding

  // ───────────── catalog, plans, blog, faq (through services → same validation/sanitizing as the admin)
  const catId = {};
  CATEGORIES.forEach((c, i) => { catId[c.slug] = catalog.createCategory({ ...c, sort: i + 1 }).id; });
  const products = PRODUCTS.map((p, i) => {
    const created = catalog.createProduct({ ...p, category_id: catId[p.category], sort: i + 1 });
    run('UPDATE products SET created_at = ?, updated_at = ? WHERE id = ?', iso(nowMs - (90 - i * 6) * DAY), iso(nowMs - int(1, 9) * DAY), created.id);
    return created;
  });
  const plans = PLANS.map((p, i) => subscriptions.createPlan({ ...p, sort: i + 1 }));
  POSTS.forEach((p) => {
    const at = iso(today0 - p.daysAgo * DAY + 10 * 3600000);
    const post = posts.createPost({ ...p, published: 1, published_at: at });
    run('UPDATE posts SET created_at = ?, updated_at = ? WHERE id = ?', at, at, post.id);
  });
  FAQ.forEach((f, i) => faq.createFaq({ ...f, sort: i + 1 }));

  // ───────────── people
  const maleNames = ['Азиз', 'Тимур', 'Рустам', 'Бекзод', 'Жасур', 'Шерзод', 'Алишер', 'Фаррух', 'Сардор', 'Даврон', 'Иван', 'Дмитрий', 'Артём', 'Михаил', 'Олег', 'Камол', 'Улугбек', 'Нодир', 'Санжар', 'Отабек'];
  const femaleNames = ['Малика', 'Нигора', 'Дильноза', 'Севара', 'Зарина', 'Камила', 'Мадина', 'Лола', 'Гульнора', 'Шахноза', 'Анна', 'Екатерина', 'Ольга', 'Мария', 'Юлия', 'Диана', 'Азиза', 'Феруза', 'Наргиза', 'Ситора'];
  const lastNames = ['Каримов', 'Рахимов', 'Юсупов', 'Ахмедов', 'Турсунов', 'Исмаилов', 'Назаров', 'Садыков', 'Хасанов', 'Мирзаев', 'Иванов', 'Ким', 'Пак', 'Петров', 'Абдуллаев', 'Умаров', 'Салимов', 'Эргашев', 'Холматов', 'Цой'];
  const latin = { Азиз: 'aziz', Тимур: 'timur', Рустам: 'rustam', Бекзод: 'bekzod', Жасур: 'jasur', Шерзод: 'sherzod', Алишер: 'alisher', Фаррух: 'farrukh', Сардор: 'sardor', Даврон: 'davron', Иван: 'ivan', Дмитрий: 'dmitry', Артём: 'artem', Михаил: 'misha', Олег: 'oleg', Камол: 'kamol', Улугбек: 'ulugbek', Нодир: 'nodir', Санжар: 'sanjar', Отабек: 'otabek', Малика: 'malika', Нигора: 'nigora', Дильноза: 'dilnoza', Севара: 'sevara', Зарина: 'zarina', Камила: 'kamila', Мадина: 'madina', Лола: 'lola', Гульнора: 'gulnora', Шахноза: 'shahnoza', Анна: 'anna', Екатерина: 'katya', Ольга: 'olga', Мария: 'maria', Юлия: 'yulia', Диана: 'diana', Азиза: 'aziza', Феруза: 'feruza', Наргиза: 'nargiza', Ситора: 'sitora' };
  const addresses = ['Юнусабадский р-н, 4-й квартал, д. 12, кв. 45', 'ул. Амира Темура, 41, кв. 8', 'Мирзо-Улугбекский р-н, ул. Буюк Ипак Йули, 115, кв. 20', 'Чиланзар, 7-й квартал, д. 23, кв. 61', 'ул. Нукусская, 22, офис 304', 'Яккасарайский р-н, ул. Шота Руставели, 53, кв. 14', 'массив Сергели-2, д. 18, кв. 12', 'ул. Мукими, 98, кв. 27', 'Мирабадский р-н, ул. Афросиаб, 14, офис 7', 'ул. Бабура, 77, кв. 5', 'массив Ц-5, д. 9, кв. 33', 'ул. Ойбек, 38А, офис 12', 'ул. Тараса Шевченко, 21, кв. 9', 'Алмазарский р-н, ул. Беруни, 3А, кв. 52'];
  const comments = ['', '', '', '', 'Помол под воронку, пожалуйста', 'Позвоните за час до доставки', 'Помол для турки', 'Оставьте у консьержа', 'В зёрнах, не молоть', 'Домофон не работает, наберите по телефону', 'Помол под гейзер'];
  const operators = ['90', '91', '93', '94', '97', '99', '88', '33', '50', '77'];

  const person = () => {
    const female = chance(0.48);
    const first = pick(female ? femaleNames : maleNames);
    let last = pick(lastNames);
    if (female && !['Ким', 'Пак', 'Цой'].includes(last)) last += 'а';
    return { first, last, name: `${first} ${last}`, handle: `${latin[first]}_${hex(3)}` };
  };
  const phone = () => `+998${pick(operators)}${String(int(1000000, 9999999))}`;

  const insCustomer = db.prepare(`INSERT INTO customers (name, phone, email, tg_user_id, tg_username, address, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const customers = []; // { id, name, phone, email, address, tgUserId }
  function newCustomer(at, source, tgUser = null) {
    const p = tgUser ? { name: `${tgUser.first_name} ${tgUser.last_name}`.trim(), first: tgUser.first_name } : person();
    const c = {
      name: p.name, phone: phone(),
      email: !tgUser && chance(0.6) ? `${latin[p.first] || 'user'}${int(10, 99)}@${pick(['gmail.com', 'mail.ru', 'inbox.uz', 'yandex.ru'])}` : null,
      address: `Ташкент, ${pick(addresses)}`, tgUserId: tgUser?.id ?? null, tgUsername: tgUser?.username ?? null,
    };
    c.id = Number(insCustomer.run(c.name, c.phone, c.email, c.tgUserId, c.tgUsername, c.address, source, iso(at), iso(at)).lastInsertRowid);
    customers.push(c);
    return c;
  }

  // ───────────── generation buffers
  const pageViews = []; // [session, path, referrer, source, medium, campaign, device, at]
  const events = [];    // { name, channel, session, tg, product, order(ref), value, at }
  const orderSpecs = []; // filled below, inserted sorted by time

  const coffee = products.filter((p) => ['espresso', 'filter', 'drip'].includes(p.category_slug) && p.stock > 0);
  const sellable = products.filter((p) => p.stock > 0);
  const productWeights = sellable.map((p) => [p, (p.featured ? 3 : 1.4) * (p.price > 400000 ? 0.25 : 1)]);
  const blogPaths = POSTS.map((p) => `/blog/${p.slug}`);

  const hourWeights = [1, 0.5, 0.3, 0.2, 0.2, 0.4, 1, 2.5, 5, 7, 8, 9, 10, 9, 8, 7, 7, 8, 9, 10, 10, 8, 5, 2.5].map((w, h) => [h, w]);
  const sources = [
    [{ source: 'direct', medium: 'direct', campaign: '', ref: '' }, 27],
    [{ source: 'google', medium: 'organic', campaign: '', ref: 'https://www.google.com/' }, 22],
    [{ source: 'instagram', medium: 'social', campaign: '', ref: 'https://l.instagram.com/' }, 17],
    [{ source: 'telegram', medium: 'social', campaign: '', ref: 'https://t.me/samo_coffee' }, 12],
    [{ source: 'yandex', medium: 'organic', campaign: '', ref: 'https://yandex.uz/search/' }, 8],
    [{ source: 'instagram', medium: 'cpc', campaign: 'autumn_roast', ref: 'https://l.instagram.com/' }, 6],
    [{ source: 'afisha.uz', medium: 'referral', campaign: '', ref: 'https://afisha.uz/gastronomy/coffee-guide' }, 4],
    [{ source: 'telegram', medium: 'cpc', campaign: 'drip_launch', ref: 'https://t.me/tashkent_food' }, 3],
    [{ source: 'facebook', medium: 'social', campaign: '', ref: 'https://m.facebook.com/' }, 1],
  ];

  function statusFor(at, paid) {
    const ageH = (nowMs - at) / 3600000;
    if (paid) {
      if (ageH > 72) return weighted([['delivered', 93], ['refunded', 3], ['shipped', 4]]);
      if (ageH > 24) return weighted([['delivered', 40], ['shipped', 45], ['processing', 15]]);
      if (ageH > 4) return weighted([['processing', 55], ['paid', 25], ['shipped', 20]]);
      return weighted([['paid', 70], ['processing', 30]]);
    }
    if (ageH > 36) return 'cancelled';
    return weighted([['pending_payment', 70], ['new', 30]]);
  }

  function makeOrder({ at, channel, session, source, customer, tgUserId = null, items, plan = null, paid }) {
    const subtotal = plan ? plan.price : items.reduce((s, i) => s + i.price * i.qty, 0);
    const method = plan ? 'courier' : chance(0.8) ? 'courier' : 'pickup';
    const fee = plan || method === 'pickup' || subtotal >= 300000 ? 0 : 25000;
    const status = statusFor(at, paid);
    const spec = {
      at, channel, session, source, customer, tgUserId, items, plan, paid, subtotal, fee, total: subtotal + fee, method, status,
      paymentStatus: status === 'refunded' ? 'refunded' : paid ? 'paid' : status === 'pending_payment' ? (chance(0.2) ? 'failed' : 'pending') : 'unpaid',
      provider: paid || status === 'pending_payment' ? (channel === 'tma' ? weighted([['telegram', 60], ['payme', 25], ['click', 15]]) : weighted([['payme', 50], ['click', 38], ['mock', 12]])) : null,
      comment: plan ? '' : pick(comments), id: null,
    };
    orderSpecs.push(spec);
    return spec;
  }

  function basket(first) {
    const items = [{ product: first, qty: first.price < 200000 && chance(0.25) ? 2 : 1 }];
    if (chance(0.42)) {
      const second = weighted(productWeights);
      if (second.id !== first.id) items.push({ product: second, qty: 1 });
    }
    if (chance(0.14)) {
      const third = pick(coffee);
      if (!items.some((i) => i.product.id === third.id)) items.push({ product: third, qty: 1 });
    }
    return items.map((i) => ({ productId: i.product.id, title: i.product.title, image: i.product.image, price: i.product.price, qty: i.qty }));
  }

  const siteCustomers = [];
  const siteCustomer = (at) => {
    if (siteCustomers.length > 12 && chance(0.3)) return pick(siteCustomers);
    const c = newCustomer(at, 'site');
    siteCustomers.push(c);
    return c;
  };

  // ───────────── telegram users (bot + mini app)
  const insTgUser = db.prepare(`INSERT INTO tg_users (id, chat_id, username, first_name, last_name, language_code, start_param, source, is_blocked, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 'ru', ?, ?, ?, ?, ?)`);
  const tgUsers = [];
  const subscribers = []; // subscription orders to turn into subscriptions

  // ───────────── day loop (oldest → newest)
  for (let d = DAYS - 1; d >= 0; d--) {
    const dayStart = today0 - d * DAY;
    const dow = new Date(dayStart + off).getUTCDay();
    const growth = 0.58 + 0.42 * ((DAYS - 1 - d) / (DAYS - 1));
    const season = [1.18, 0.94, 0.9, 0.95, 1.0, 1.1, 1.24][dow];
    const promo = d <= 24 && d >= 18 ? 1.4 : 1; // paid campaign week
    const elapsed = d === 0 ? Math.max(0.04, (nowMs - dayStart) / DAY) : 1;
    const timeOfDay = () => {
      for (let i = 0; i < 20; i++) {
        const t = dayStart + weighted(hourWeights) * 3600000 + int(0, 3599) * 1000;
        if (t < nowMs - 60000) return t;
      }
      return dayStart + Math.floor(rand() * Math.max(60000, nowMs - dayStart - 60000));
    };

    // new Telegram users
    const newTg = Math.round((1.2 + 2.6 * growth) * season * (0.6 + rand() * 0.8) * elapsed);
    for (let i = 0; i < newTg; i++) {
      const p = person();
      const at = timeOfDay();
      const u = { id: 100000000 + int(1000000, 899999999), first_name: p.first, last_name: chance(0.6) ? p.last : '', username: chance(0.75) ? p.handle : null, createdAt: at, customer: null };
      const viaTma = chance(0.25);
      const startParam = viaTma ? null : weighted([[null, 50], ['site', 20], ['insta', 15], ['qr_cafe', 10], ['friend', 5]]);
      insTgUser.run(u.id, u.id, u.username, u.first_name, u.last_name, startParam, viaTma ? 'tma' : 'bot', chance(0.05) ? 1 : 0, iso(at), iso(Math.min(nowMs, at + int(0, d) * DAY)));
      tgUsers.push(u);
      if (!viaTma) events.push({ name: 'bot_start', channel: 'bot', session: `tg:${u.id}`, tg: u.id, at, meta: startParam ? { start_param: startParam } : {} });
      else events.push({ name: 'tma_open', channel: 'tma', session: `tg:${u.id}`, tg: u.id, at });
    }

    // mini app sessions
    const tmaSessions = Math.min(tgUsers.length, Math.round(tgUsers.length * (0.1 + rand() * 0.08) * season * elapsed));
    for (let i = 0; i < tmaSessions; i++) {
      const u = pick(tgUsers);
      let t = timeOfDay();
      if (t < u.createdAt) continue;
      const session = `tg:${u.id}`;
      events.push({ name: 'tma_open', channel: 'tma', session, tg: u.id, at: t });
      if (!chance(0.62)) continue;
      const product = weighted(productWeights);
      t += int(15, 60) * 1000;
      events.push({ name: 'view_product', channel: 'tma', session, tg: u.id, product: product.id, at: t });
      if (chance(0.03)) { // subscription from the mini app
        const plan = weighted([[plans[0], 55], [plans[1], 35], [plans[2], 10]]);
        t += int(30, 90) * 1000;
        events.push({ name: 'begin_checkout', channel: 'tma', session, tg: u.id, value: plan.price, at: t });
        u.customer ||= newCustomer(t, 'tma', u);
        const spec = makeOrder({ at: t, channel: 'tma', session, source: 'telegram', customer: u.customer, tgUserId: u.id, items: [], plan, paid: true });
        events.push({ name: 'subscribe', channel: 'tma', session, tg: u.id, order: spec, value: plan.price, at: t });
        subscribers.push(spec);
        continue;
      }
      if (!chance(0.36)) continue;
      t += int(10, 50) * 1000;
      events.push({ name: 'add_to_cart', channel: 'tma', session, tg: u.id, product: product.id, value: product.price, at: t });
      if (!chance(0.66)) continue;
      t += int(20, 80) * 1000;
      const items = basket(product);
      events.push({ name: 'begin_checkout', channel: 'tma', session, tg: u.id, value: items.reduce((s, x) => s + x.price * x.qty, 0), at: t });
      const paid = chance(0.74);
      if (!paid && !chance(0.5)) continue;
      u.customer ||= newCustomer(t, 'tma', u);
      makeOrder({ at: t + int(30, 120) * 1000, channel: 'tma', session, source: 'telegram', customer: u.customer, tgUserId: u.id, items, paid });
    }

    // site sessions
    const sessions = Math.round(128 * growth * season * promo * (0.86 + rand() * 0.28) * elapsed);
    for (let i = 0; i < sessions; i++) {
      const src = promo > 1 && chance(0.22) ? sources[5][0] : weighted(sources);
      const device = weighted([['mobile', 61], ['desktop', 34], ['tablet', 5]]);
      const sid = crypto.createHash('sha1').update(`${d}:${i}:${rand()}`).digest('base64url').slice(0, 20);
      let t = timeOfDay();
      let first = true;
      const view = (path) => {
        if (t > nowMs) return;
        pageViews.push([sid, path, first ? src.ref : '', src.source, src.medium, src.campaign, device, iso(t)]);
        first = false;
        t += int(12, 95) * 1000;
      };
      const product = weighted(productWeights);
      const landing = weighted([['/', 40], ['/catalog', 17], ['product', 17], ['blog', 9], ['/subscriptions', 8], ['/delivery', 3], ['/about', 3], ['/contacts', 2], ['/faq', 1]]);
      const landingPath = landing === 'product' ? `/catalog/${product.slug}` : landing === 'blog' ? pick(blogPaths) : landing;
      view(landingPath);
      if (chance(0.34) && landing !== 'product') continue; // bounce

      // subscription flow
      if (landing === "/subscriptions" ? chance(0.07) : chance(0.004)) {
        if (landing !== '/subscriptions') view('/subscriptions');
        const plan = weighted([[plans[0], 50], [plans[1], 38], [plans[2], 12]]);
        events.push({ name: 'begin_checkout', channel: 'site', session: sid, value: plan.price, at: t });
        view('/checkout');
        const spec = makeOrder({ at: t, channel: 'site', session: sid, source: src.source, customer: siteCustomer(t), items: [], plan, paid: true });
        events.push({ name: 'subscribe', channel: 'site', session: sid, order: spec, value: plan.price, at: t });
        subscribers.push(spec);
        view('/order/*');
        continue;
      }

      for (const extra of ['/about', '/delivery', '/faq', '/blog', '/subscriptions', '/contacts']) if (chance(0.07)) view(extra);
      if (landing === 'blog' && chance(0.5)) view('/blog');
      const wantsProduct = landing === 'product' || chance(0.6);
      if (!wantsProduct) continue;
      if (landing !== 'product') {
        if (landing !== '/catalog') view('/catalog');
        view(`/catalog/${product.slug}`);
      }
      events.push({ name: 'view_product', channel: 'site', session: sid, product: product.id, at: t - 5000 });
      if (chance(0.3)) {
        const other = weighted(productWeights);
        view(`/catalog/${other.slug}`);
        events.push({ name: 'view_product', channel: 'site', session: sid, product: other.id, at: t - 4000 });
      }
      if (!chance(src.medium === "cpc" ? 0.3 : device === "desktop" ? 0.28 : 0.22)) continue;
      events.push({ name: 'add_to_cart', channel: 'site', session: sid, product: product.id, value: product.price, at: t });
      view('/cart');
      if (!chance(0.56)) continue;
      const items = basket(product);
      events.push({ name: 'begin_checkout', channel: 'site', session: sid, value: items.reduce((s, x) => s + x.price * x.qty, 0), at: t });
      view('/checkout');
      const paid = chance(0.63);
      if (!paid && !chance(0.45)) continue;
      makeOrder({ at: t, channel: 'site', session: sid, source: src.source, customer: siteCustomer(t), items, paid });
      view('/order/*');
    }
  }

  // subscription renewals (30 days after the first payment)
  for (const first of [...subscribers]) {
    const renewAt = first.at + first.plan.period_days * DAY + int(-6, 6) * 3600000;
    if (renewAt < nowMs - 3600000 && chance(0.68)) {
      const spec = makeOrder({ at: renewAt, channel: first.channel, session: null, source: '', customer: first.customer, tgUserId: first.tgUserId, items: [], plan: first.plan, paid: true });
      spec.renewalOf = first;
      first.renewed = spec;
    }
  }

  // ───────────── write everything
  orderSpecs.sort((a, b) => a.at - b.at);
  const counters = { orders: 0, paid: 0, revenue: 0 };
  tx(() => {
    const insPv = db.prepare('INSERT INTO page_views (session_id, path, referrer, source, medium, utm_campaign, device, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const pv of pageViews) insPv.run(...pv);

    const insOrder = db.prepare(`INSERT INTO orders (number, public_token, customer_id, kind, plan_id, status, payment_status, payment_provider, channel,
        subtotal, delivery_fee, discount, total, customer_name, customer_phone, customer_email, delivery_method, delivery_address, comment,
        tg_user_id, session_id, source, paid_at, cancelled_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insItem = db.prepare('INSERT INTO order_items (order_id, product_id, plan_id, title, image, price, qty, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const insEvent = db.prepare('INSERT INTO order_events (order_id, type, from_value, to_value, note, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insPay = db.prepare(`INSERT INTO payments (order_id, provider, provider_tx_id, amount, status, state, create_time, perform_time, cancel_time, raw, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{"seed":true}', ?, ?)`);
    const flow = ['processing', 'shipped', 'delivered'];

    const setNumber = db.prepare('UPDATE orders SET number = ? WHERE id = ?');

    orderSpecs.forEach((o, index) => {
      const paidAt = o.paid ? o.at + int(40, 400) * 1000 : null;
      const closedAt = ['cancelled', 'refunded'].includes(o.status) ? Math.min(nowMs, o.at + int(20, 60) * 3600000) : null;
      const updatedAt = Math.min(nowMs, closedAt || (paidAt ? paidAt + int(1, 30) * 3600000 : o.at));
      const c = o.customer;
      // the id comes from the database (it does not start at 1 when rows were deleted before), the number follows it
      const id = Number(insOrder.run(`seed-${index}`, hex(32), c.id, o.plan ? 'subscription' : 'product', o.plan ? o.plan.id : null, o.status, o.paymentStatus,
        o.provider, o.channel, o.subtotal, o.fee, o.total, c.name, c.phone, c.email || '', o.method, o.method === 'pickup' ? '' : c.address, o.comment,
        o.tgUserId, o.session, o.source || '', paidAt ? iso(paidAt) : null, closedAt ? iso(closedAt) : null, iso(o.at), iso(updatedAt)).lastInsertRowid);
      o.id = id;
      setNumber.run(`SC-${100000 + id}`, id);
      if (o.plan) insItem.run(id, null, o.plan.id, `Подписка «${o.plan.title}»`, o.plan.image, o.plan.price, 1, o.plan.price);
      else for (const it of o.items) insItem.run(id, it.productId, null, it.title, it.image, it.price, it.qty, it.price * it.qty);

      insEvent.run(id, 'created', null, 'new', '', 'customer', iso(o.at));
      if (o.provider) insEvent.run(id, 'status', 'new', 'pending_payment', `Способ оплаты: ${PAYMENT_PROVIDER_LABELS[o.provider] || o.provider}`, 'system', iso(o.at + 5000));
      if (o.paid) {
        const tx = `${o.provider === 'payme' ? '' : `${o.provider}_`}${hex(24)}`;
        insPay.run(id, o.provider, tx, o.total, o.status === 'refunded' ? 'refunded' : 'paid', o.provider === 'payme' ? (o.status === 'refunded' ? -2 : 2) : 0,
          o.at + 8000, paidAt, o.status === 'refunded' ? closedAt : null, iso(o.at + 8000), iso(paidAt));
        insEvent.run(id, 'payment', 'pending_payment', 'paid', `Оплата: ${PAYMENT_PROVIDER_LABELS[o.provider] || o.provider} (${tx})`, `provider:${o.provider}`, iso(paidAt));
        let prev = 'paid';
        let t = paidAt;
        for (const step of flow) {
          if (flow.indexOf(step) > flow.indexOf(o.status === 'refunded' ? 'delivered' : o.status)) break;
          t = Math.min(nowMs, t + int(1, 9) * 3600000);
          insEvent.run(id, 'status', prev, step, '', 'admin:1', iso(t));
          prev = step;
        }
        if (o.status === 'refunded') insEvent.run(id, 'status', prev, 'refunded', 'Клиент попросил заменить лот — оформили возврат', 'admin:1', iso(closedAt));
        counters.paid += 1;
        if (o.status !== 'refunded') counters.revenue += o.total;
        events.push({ name: 'purchase', channel: o.channel, session: o.session, tg: o.tgUserId, order: o, value: o.total, at: paidAt, meta: { provider: o.provider, kind: o.plan ? 'subscription' : 'product' } });
      } else if (o.status === 'cancelled') {
        insEvent.run(id, 'status', o.provider ? 'pending_payment' : 'new', 'cancelled', 'Не оплачен в течение суток', 'system', iso(closedAt));
      } else if (o.paymentStatus === 'failed') {
        insPay.run(id, o.provider, `${o.provider}_${hex(24)}`, o.total, 'failed', 0, o.at + 8000, null, null, iso(o.at + 8000), iso(o.at + 60000));
        insEvent.run(id, 'payment', 'pending', 'failed', 'Банк отклонил операцию', `provider:${o.provider}`, iso(o.at + 60000));
      }
      counters.orders += 1;
    });

    // subscriptions
    const insSub = db.prepare(`INSERT INTO subscriptions (customer_id, plan_id, status, started_at, current_period_end, last_order_id, renewals, cancelled_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insPeriod = db.prepare('INSERT INTO subscription_periods (subscription_id, order_id, days, created_at) VALUES (?, ?, ?, ?)');
    const seenCustomers = new Set();
    for (const first of subscribers.sort((a, b) => a.at - b.at)) {
      if (first.status === 'refunded' || seenCustomers.has(first.customer.id)) continue;
      seenCustomers.add(first.customer.id);
      const last = first.renewed || first;
      const renewals = first.renewed ? 1 : 0;
      const end = first.at + first.plan.period_days * DAY * (renewals + 1);
      const status = end < nowMs ? weighted([['expired', 65], ['cancelled', 35]]) : weighted([['active', 88], ['paused', 7], ['cancelled', 5]]);
      const cancelledAt = status === 'cancelled' ? iso(Math.min(nowMs, last.at + int(3, 20) * DAY)) : null;
      const subId = Number(insSub.run(first.customer.id, first.plan.id, status, iso(first.at), iso(end), last.id, renewals, cancelledAt, iso(first.at), iso(Math.min(nowMs, last.at + 600000))).lastInsertRowid);
      // which order paid for which period (a refund in the panel reverts exactly that period)
      for (const o of first.renewed ? [first, first.renewed] : [first]) insPeriod.run(subId, o.id, first.plan.period_days, iso(o.at));
    }

    const insEv = db.prepare('INSERT INTO events (name, channel, session_id, tg_user_id, product_id, order_id, value, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    events.sort((a, b) => a.at - b.at);
    for (const e of events) {
      if (e.at > nowMs) continue;
      insEv.run(e.name, e.channel, e.session ?? null, e.tg ?? null, e.product ?? null, e.order?.id ?? null, Math.round(e.value || 0), JSON.stringify(e.meta || {}), iso(e.at));
    }

    // feedback threads
    const insThread = db.prepare(`INSERT INTO feedback_threads (channel, customer_id, tg_user_id, tg_chat_id, name, contact, subject, status, unread, last_message_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insMsg = db.prepare(`INSERT INTO feedback_messages (thread_id, direction, text, admin_id, via, delivered, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const adminId = get('SELECT id FROM admins ORDER BY id LIMIT 1')?.id ?? null;
    const tgWithOrders = tgUsers.filter((u) => u.customer).slice(-6);
    for (const f of FEEDBACK) {
      const u = f.tg !== undefined ? (tgWithOrders[f.tg] || tgUsers[f.tg]) : null;
      const startAt = nowMs - f.hoursAgo * 3600000;
      const lastDir = f.messages[f.messages.length - 1][0];
      const lastAt = startAt + (f.messages.length - 1) * 47 * 60000;
      const threadId = Number(insThread.run(
        f.channel, u?.customer?.id ?? null, u?.id ?? null, u?.id ?? null,
        u ? `${u.first_name} ${u.last_name}`.trim() : f.name, u ? (u.username ? `@${u.username}` : `tg id ${u.id}`) : f.contact,
        f.subject || '', f.status, f.status === 'open' && lastDir === 'in' ? 1 : 0, iso(Math.min(nowMs, lastAt)), iso(startAt)).lastInsertRowid);
      f.messages.forEach(([dir, text], i) => {
        insMsg.run(threadId, dir, text, dir === 'out' ? adminId : null, dir === 'out' ? 'panel' : '', dir === 'out' && u ? 1 : 0, iso(Math.min(nowMs, startAt + i * 47 * 60000)));
      });
      insEv.run('feedback', f.channel === 'site' ? 'site' : f.channel, u ? `tg:${u.id}` : null, u?.id ?? null, null, null, 0, JSON.stringify({ thread_id: threadId }), iso(startAt));
    }

    // one finished broadcast for the history
    run(`INSERT INTO broadcasts (text, status, total, sent, failed, created_by, created_at, finished_at) VALUES (?, 'done', ?, ?, ?, ?, ?, ?)`,
      '☕ <b>Новый урожай Кении уже в обжарке!</b>\n\nНьери АА: чёрная смородина, грейпфрут и сладкое послевкусие. Первая партия — всего 40 пачек.',
      Math.max(0, tgUsers.length - 12), Math.max(0, tgUsers.length - 15), 3, adminId, iso(nowMs - 9 * DAY), iso(nowMs - 9 * DAY + 90000));
  });

  const summary = {
    products: products.length,
    plans: plans.length,
    posts: POSTS.length,
    customers: customers.length,
    tgUsers: tgUsers.length,
    orders: counters.orders,
    paidOrders: counters.paid,
    revenue: counters.revenue,
    subscriptions: get('SELECT COUNT(*) AS n FROM subscriptions').n,
    pageViews: pageViews.length,
    events: get('SELECT COUNT(*) AS n FROM events').n,
    feedbackThreads: FEEDBACK.length,
    contentBlocks: get('SELECT COUNT(*) AS n FROM content_blocks').n,
  };
  log('[seed] done:', summary);
  log(`[seed] admin login: ${all('SELECT email FROM admins ORDER BY id LIMIT 1')[0]?.email || '(none — set ADMIN_PASSWORD)'}`);
  return summary;
}

// CLI entry
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (config.isProd && !process.argv.includes('--force')) {
    console.error('[seed] refusing to reset data with NODE_ENV=production. Run with --force if you really mean it.');
    process.exit(1);
  }
  try {
    seed();
  } finally {
    closeDb();
  }
}
