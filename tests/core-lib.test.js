import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSum, formatNumber, formatCompact, sumToTiyin, tiyinToSum, parseSum, discountPercent } from '../src/lib/money.js';
import { createToken, verifyToken, newSecret } from '../src/lib/csrf.js';
import { slugify, uniqueSlug } from '../src/lib/slugify.js';
import { escapeHtml, escapeTg, nl2br, jsonForScript, plural, truncate, clean } from '../src/lib/escape.js';
import { sanitizeRichText } from '../src/lib/sanitize.js';
import { RateLimiter } from '../src/lib/ratelimit.js';
import { validateInitData, signInitData } from '../src/lib/initData.js';

test('money: formatting', () => {
  assert.equal(formatSum(129000), '129 000 сум');
  assert.equal(formatSum(0), '0 сум');
  assert.equal(formatSum(1250000), '1 250 000 сум');
  assert.equal(formatNumber(999), '999');
  assert.equal(formatNumber(-45000), '-45 000');
  assert.equal(formatCompact(1250000), '1,25 млн');
  assert.equal(formatCompact(129000), '129 тыс.');
});

test('money: sum <-> tiyin', () => {
  assert.equal(sumToTiyin(129000), 12900000);
  assert.equal(tiyinToSum(12900000), 129000);
  assert.throws(() => tiyinToSum(12900050), RangeError);
  assert.throws(() => tiyinToSum('abc'), RangeError);
});

test('money: parse and discount', () => {
  assert.equal(parseSum('129 000 сум'), 129000);
  assert.equal(parseSum(5000.4), 5000);
  assert.equal(parseSum(''), null);
  assert.equal(parseSum('-5'), null);
  assert.equal(discountPercent(149000, 169000), 12);
  assert.equal(discountPercent(149000, null), 0);
});

test('csrf: token round trip and tampering', () => {
  const secret = newSecret();
  const token = createToken(secret);
  assert.ok(verifyToken(secret, token));
  assert.notEqual(createToken(secret), token, 'tokens are salted');
  assert.equal(verifyToken(newSecret(), token), false, 'other secret');
  assert.equal(verifyToken(secret, `${token}x`), false);
  assert.equal(verifyToken(secret, ''), false);
  assert.equal(verifyToken(secret, undefined), false);
  assert.equal(verifyToken('', token), false);
  const [salt, mac] = token.split('.');
  assert.equal(verifyToken(secret, `${salt}A.${mac}`), false);
});

test('slugify: cyrillic aware', () => {
  assert.equal(slugify('Эфиопия Иргачефф 250 г'), 'efiopiya-irgacheff-250-g');
  assert.equal(slugify('  Колд-брю дома!  '), 'kold-bryu-doma');
  assert.equal(slugify('Ўзбекистон қаҳваси'), 'ozbekiston-qahvasi');
  assert.equal(slugify('???'), 'item');
  const taken = new Set(['kofe', 'kofe-2']);
  assert.equal(uniqueSlug('Кофе', (s) => taken.has(s)), 'kofe-3');
});

test('escape helpers', () => {
  assert.equal(escapeHtml(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  assert.equal(escapeTg('<b>1 & 2</b>'), '&lt;b&gt;1 &amp; 2&lt;/b&gt;');
  assert.equal(nl2br('a\n<b>'), 'a<br>&lt;b&gt;');
  assert.ok(!jsonForScript({ x: '</script><script>alert(1)' }).includes('</script>'));
  assert.deepEqual(JSON.parse(jsonForScript({ x: '</script>&' })), { x: '</script>&' });
  assert.equal(plural(1, ['товар', 'товара', 'товаров']), 'товар');
  assert.equal(plural(3, ['товар', 'товара', 'товаров']), 'товара');
  assert.equal(plural(11, ['товар', 'товара', 'товаров']), 'товаров');
  assert.equal(truncate('короткий текст', 50), 'короткий текст');
  assert.ok(truncate('слово '.repeat(50), 40).length <= 40);
  assert.equal(clean('  abc  ', 2), 'ab');
  assert.equal(clean(null), '');
});

test('sanitize: strips scripts and dangerous attributes, keeps formatting', () => {
  const html = sanitizeRichText('<h2 onclick="x()">Заголовок</h2><script>alert(1)</script><p>Текст <a href="javascript:alert(1)">a</a> <a href="https://x.uz">b</a><img src="x" onerror="1"></p><iframe src="//evil"></iframe>');
  assert.ok(html.includes('<h2>Заголовок</h2>'));
  assert.ok(!/script|onclick|onerror|javascript:|iframe/i.test(html));
  assert.ok(html.includes('rel="noopener noreferrer"'));
});

test('rate limiter', () => {
  const rl = new RateLimiter({ windowMs: 1000, max: 2 });
  assert.equal(rl.hit('a').allowed, true);
  assert.equal(rl.hit('a').allowed, true);
  const third = rl.hit('a');
  assert.equal(third.allowed, false);
  assert.ok(third.retryAfterSec >= 1);
  assert.equal(rl.peek('a').allowed, false);
  assert.equal(rl.hit('b').allowed, true);
  rl.reset('a');
  assert.equal(rl.hit('a').allowed, true);
});

test('initData: valid signature is accepted', () => {
  const token = '123456:ABC-DEF';
  const raw = signInitData({ user: { id: 42, first_name: 'Азиз', username: 'aziz' }, query_id: 'AAE', start_param: 'promo' }, token);
  const result = validateInitData(raw, token);
  assert.equal(result.ok, true);
  assert.equal(result.user.id, 42);
  assert.equal(result.user.first_name, 'Азиз');
  assert.equal(result.data.start_param, 'promo');
});

test('initData: matches the reference algorithm', async () => {
  // Independent re-implementation of the documented algorithm.
  const crypto = await import('node:crypto');
  const token = '777:SECRET';
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'Q1', user: JSON.stringify({ id: 7, first_name: 'T' }) };
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  const raw = new URLSearchParams({ ...fields, hash }).toString();
  assert.equal(validateInitData(raw, token).ok, true);
});

test('initData: tampering, wrong token, missing hash', () => {
  const token = '123456:ABC-DEF';
  const raw = signInitData({ user: { id: 42, first_name: 'A' } }, token);
  assert.deepEqual(validateInitData(raw, 'other:token'), { ok: false, reason: 'bad_hash' });
  const tampered = raw.replace('%22id%22%3A42', '%22id%22%3A43');
  assert.notEqual(tampered, raw);
  assert.equal(validateInitData(tampered, token).reason, 'bad_hash');
  const params = new URLSearchParams(raw);
  params.delete('hash');
  assert.equal(validateInitData(params.toString(), token).reason, 'no_hash');
  assert.equal(validateInitData('', token).reason, 'empty');
  assert.equal(validateInitData(raw, '').reason, 'no_token');
});

test('initData: freshness check', () => {
  const token = '123456:ABC-DEF';
  const old = signInitData({ user: { id: 1, first_name: 'A' }, auth_date: Math.floor(Date.now() / 1000) - 7200 }, token);
  assert.equal(validateInitData(old, token, { maxAgeSeconds: 3600 }).reason, 'expired');
  assert.equal(validateInitData(old, token, { maxAgeSeconds: 86400 }).ok, true);
  assert.equal(validateInitData(old, token, { maxAgeSeconds: 0 }).ok, true, '0 disables the check');
  const future = signInitData({ user: { id: 1, first_name: 'A' }, auth_date: Math.floor(Date.now() / 1000) + 3600 }, token);
  assert.equal(validateInitData(future, token).reason, 'expired');
});
