// Money helpers. All amounts in the app are whole UZS sums (integers).
// Payme and Telegram Payments expect tiyin (1 sum = 100 tiyin).

/** 129000 -> "129 000" */
export function formatNumber(n) {
  const v = Math.round(Number(n) || 0);
  const sign = v < 0 ? '-' : '';
  return sign + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** 129000 -> "129 000 сум" */
export function formatSum(n) {
  return `${formatNumber(n)} сум`;
}

/** Compact form for charts and KPI tiles: 1250000 -> "1,25 млн", 129000 -> "129 тыс." */
export function formatCompact(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  const trim = (x) => String(Math.round(x * 100) / 100).replace('.', ',');
  if (abs >= 1e9) return `${trim(v / 1e9)} млрд`;
  if (abs >= 1e6) return `${trim(v / 1e6)} млн`;
  if (abs >= 1e3) return `${trim(v / 1e3)} тыс.`;
  return String(Math.round(v));
}

/** Whole sums -> tiyin (integer). */
export function sumToTiyin(sum) {
  return Math.round(Number(sum) * 100);
}

/** Tiyin -> whole sums. Throws when the amount is not a whole number of sums. */
export function tiyinToSum(tiyin) {
  const t = Number(tiyin);
  if (!Number.isInteger(t) || t % 100 !== 0) {
    throw new RangeError(`Amount ${tiyin} tiyin is not a whole number of sums`);
  }
  return t / 100;
}

/** Parse user input ("129 000", "129000 сум", 129000) into an integer >= 0, or null when invalid. */
export function parseSum(input) {
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? Math.round(input) : null;
  const cleaned = String(input ?? '').replace(/[^\d.,-]/g, '').replace(',', '.');
  if (cleaned === '' || cleaned.startsWith('-')) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Discount percent between old and current price (0 when there is no discount). */
export function discountPercent(price, oldPrice) {
  if (!oldPrice || oldPrice <= price) return 0;
  return Math.round((1 - price / oldPrice) * 100);
}
