// DTOs of the Mini App API: only the fields the client needs (no admin notes, sessions, tokens of others).
import { config } from '../config.js';
import { MAX_QTY_PER_ITEM } from '../services/cart.js';

const bool = (v) => Boolean(v);

export function productCard(p) {
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    subtitle: p.subtitle || '',
    image: p.image,
    price: p.price,
    old_price: p.old_price || null,
    discount_percent: p.discount_percent || 0,
    in_stock: bool(p.in_stock),
    /** how many units can be added at once (stock is capped, the exact number is not exposed) */
    max_qty: Math.max(0, Math.min(p.stock, MAX_QTY_PER_ITEM)),
    low_stock: p.stock > 0 && p.stock <= 5,
    weight_g: p.weight_g || null,
    roast: p.roast || '',
    origin: p.origin || '',
    featured: bool(p.featured),
    category_slug: p.category_slug || '',
    category_title: p.category_title || '',
  };
}

export function productFull(p) {
  return {
    ...productCard(p),
    images: p.images?.length ? p.images : [p.image],
    description: p.description || '',
    details_html: p.details_html || '', // sanitized by the catalog service on save
    process: p.process || '',
    attributes: p.attributes && typeof p.attributes === 'object' ? p.attributes : {},
  };
}

export function categoryView(c) {
  return { id: c.id, slug: c.slug, title: c.title, image: c.image || '', product_count: c.product_count || 0 };
}

export function planView(p) {
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    description: p.description || '',
    price: p.price,
    period_days: p.period_days,
    perks: Array.isArray(p.perks) ? p.perks : [],
    image: p.image,
    badge: p.badge || '',
  };
}

export function subscriptionView(s) {
  if (!s) return null;
  return {
    id: s.id,
    plan_id: s.plan_id,
    plan_title: s.plan_title,
    plan_price: s.plan_price,
    plan_period_days: s.plan_period_days,
    status: s.status,
    status_label: s.status_label,
    is_active: bool(s.is_active),
    started_at: s.started_at,
    current_period_end: s.current_period_end,
    days_left: s.days_left,
    renewals: s.renewals || 0,
  };
}

export function orderView(o) {
  if (!o) return null;
  return {
    id: o.id,
    number: o.number,
    kind: o.kind,
    kind_label: o.kind_label,
    plan_id: o.plan_id || null,
    status: o.status,
    status_label: o.status_label,
    payment_status: o.payment_status,
    payment_status_label: o.payment_status_label,
    payment_provider: o.payment_provider || '',
    is_paid: bool(o.is_paid),
    can_pay: bool(o.can_pay),
    can_cancel: !o.is_paid && ['new', 'pending_payment'].includes(o.status),
    subtotal: o.subtotal,
    delivery_fee: o.delivery_fee,
    discount: o.discount,
    total: o.total,
    customer_name: o.customer_name,
    customer_phone: o.customer_phone,
    delivery_method: o.delivery_method,
    delivery_method_label: o.delivery_method_label,
    delivery_address: o.delivery_address || '',
    comment: o.comment || '',
    created_at: o.created_at,
    paid_at: o.paid_at || null,
    /** public status page (works in any browser, no login) */
    status_url: `${config.baseUrl}${o.url}`,
    items: (o.items || []).map((i) => ({
      product_id: i.product_id || null,
      plan_id: i.plan_id || null,
      title: i.title,
      image: i.image || '/img/placeholder.svg',
      price: i.price,
      qty: i.qty,
      total: i.total,
    })),
  };
}

export function messageView(m) {
  return { id: m.id, thread_id: m.thread_id, direction: m.direction, text: m.text, created_at: m.created_at };
}
