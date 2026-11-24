// Deep links: https://t.me/<bot>?start=<payload>  (payload: A-Z a-z 0-9 _ -, up to 64 chars)
//
//   order_SC-100042      open an order (the site's "follow in Telegram" link)
//   plan_<id|slug>       open a subscription plan
//   product_<id|slug>    open a product card
//   catalog | plans | support | orders
//   anything else        a traffic source label: "site", "insta", "qr_cafe", "utm_insta", "src-flyer"…
// Every payload is recorded in the analytics `bot_start` event (meta.start_param, meta.source).

const SOURCE_PREFIX = /^(?:utm|src|source|ref|from)[_-]+/i;

/** "sc-100042" | "SC100042" | "100042" → "SC-100042" */
export function normalizeOrderNumber(value) {
  const v = String(value || '').trim().toUpperCase();
  const m = /^(?:SC)?-?(\d{4,12})$/.exec(v);
  return m ? `SC-${m[1]}` : v;
}

/**
 * @param {string} raw payload after "/start "
 * @returns {{ kind: 'none'|'order'|'plan'|'product'|'catalog'|'plans'|'support'|'orders'|'source', value: string, raw: string, source: string }}
 *   source — label stored in analytics ("direct" when there is no payload)
 */
export function parseStartParam(raw) {
  const p = String(raw ?? '').trim().slice(0, 64);
  if (!p || !/^[\w-]+$/.test(p)) return { kind: 'none', value: '', raw: '', source: 'direct' };
  let m;
  if ((m = /^order[_-](.+)$/i.exec(p))) return { kind: 'order', value: normalizeOrderNumber(m[1]), raw: p, source: 'order_link' };
  if ((m = /^plan[_-](.+)$/i.exec(p))) return { kind: 'plan', value: m[1], raw: p, source: 'plan_link' };
  if ((m = /^(?:product|item)[_-](.+)$/i.exec(p))) return { kind: 'product', value: m[1], raw: p, source: 'product_link' };
  if (/^catalog$/i.test(p)) return { kind: 'catalog', value: '', raw: p, source: 'catalog_link' };
  if (/^(?:plans|subscription|subscriptions)$/i.test(p)) return { kind: 'plans', value: '', raw: p, source: 'plans_link' };
  if (/^(?:support|help|feedback)$/i.test(p)) return { kind: 'support', value: '', raw: p, source: 'support_link' };
  if (/^orders$/i.test(p)) return { kind: 'orders', value: '', raw: p, source: 'orders_link' };
  const source = p.replace(SOURCE_PREFIX, '').toLowerCase() || p.toLowerCase();
  return { kind: 'source', value: source, raw: p, source };
}
