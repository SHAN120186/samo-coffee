# SITE module — public website

Server-rendered (EJS) multi-page shop mounted at `/`. No SQL here: routes call the service layer
(`src/services/*`), payments start through `src/payments` (`order.pay_url`).

```
src/site/routes.js        router: pages, cart, checkout, order status, feedback, sitemap, 404/500
src/site/blocks.js        extra editable content blocks of the site (additive) + pageContent()
src/site/helpers.js       icons, SEO helpers, pagination, small text utilities
src/site/views/*.ejs      one view per page; partials/ = layout (head, foot) and cards
public/site/css/site.css  site styles (loaded after /css/tokens.css)
public/site/js/site.js    progressive enhancement (every feature works without it)
tests/site-*.test.js      route smoke tests, SEO, cart, checkout → mock payment → paid
```

## Routes

| Route | Page |
|---|---|
| `GET /` | Home |
| `GET /catalog?category=&sort=&q=&page=` | Catalog: category filter, sort, search, pagination (12 per page) |
| `GET /catalog/:slug` | Product (tracks `view_product`, JSON-LD `Product`) |
| `GET /cart`, `POST /cart/add`, `/cart/update`, `/cart/remove`, `/cart/clear` | Cart (`add_to_cart` event) |
| `GET /checkout`, `POST /checkout` | Checkout (`begin_checkout` event) → `303 /pay/order/:token` |
| `GET /order/:token`, `GET /order/:token/status` | Order status / thank-you page (payment return URL) + JSON for polling |
| `GET /subscriptions`, `GET/POST /subscriptions/:slug` | Plans and the subscribe form → payment |
| `GET /about`, `/delivery`, `/faq`, `/blog`, `/blog/:slug` | Content pages |
| `GET /contacts`, `POST /contacts` | Contacts + feedback form (CSRF, honeypot, 5 messages / 10 min per IP) |
| `GET /robots.txt`, `/sitemap.xml` | SEO |
| anything else | branded 404; errors inside the router → branded error page |

## Cart contract (progressive enhancement)

Cart forms are plain `POST` forms (`product_id`, `qty`, optional `redirect` = same-site path to return to).
Without JavaScript the server answers `303` + a flash message. `site.js` sends the same forms with
`fetch()` (`Accept: application/json`, `X-CSRF-Token`) and gets:

```json
{ "ok": true, "message": "«Кения Ньери АА» — в корзине",
  "cart": { "count": 3, "subtotal": 537000, "delivery_fee": 0, "total": 537000, "free_delivery_left": 0,
            "has_unavailable": false,
            "items": [{ "product_id": 6, "qty": 3, "stock": 4, "available": true, "line_total": 537000, "line_total_text": "537 000 сум" }],
            "text": { "count": "3 товара", "subtotal": "537 000 сум", "delivery": "Бесплатно", "total": "537 000 сум", "free_delivery_left": "" } } }
```

Errors: `{ "ok": false, "error": "out_of_stock" | "not_found" | "rate_limited", "message": "…" }`.

## Content

Every heading, paragraph and illustration of the content pages is a content block (`Admin → Контент`)
or a setting (`Admin → Настройки`: phone, address, socials, delivery prices). Catalog, plans, blog and
FAQ come from their own admin sections.

`blocks.js` adds the blocks the foundation defaults do not cover (reviews, product-page perks, order
status texts for every stage, CTA bands, the Telegram block, …). They are inserted at boot with
`ON CONFLICT DO NOTHING` semantics — an edited value is never overwritten — and are listed after the
default blocks of the same page. Views read a page with `pageContent(page)`; an emptied block hides
its element.

The hero headline accents its last two words; write `Кофе *этой недели*` in the block to choose the
accented phrase yourself.

"Open in Telegram" links (footer block, mobile menu, CTA bands, contacts, order page) appear only when
`BOT_USERNAME` is configured: `https://t.me/<bot>?start=site` and `?start=order_<number>`.
