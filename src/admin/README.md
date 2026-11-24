# Admin panel (`/admin`)

Server-rendered EJS + small vanilla JS. No SQL here: every action calls the service layer
(`src/services/*`), so business rules (order status machine, `orders.markPaid`, sanitizing,
upload validation, notifications) stay in one place.

```
src/admin/
  routes.js            entry: login/logout, auth guard, layout locals, section routers, 404 + error handling
  lib.js               navigation model, pagination, badges, form helpers, CSV
  icons.js             inline SVG icon set (icon('bag'))
  controllers/         one router per section
    dashboard.js         GET /admin                       analytics for a date range
    content.js           /admin/content[/:page]           page blocks (text / rich text / image / link)
    catalog.js           /admin/products, /admin/categories
    plans.js             /admin/plans, /admin/subscriptions
    blog.js              /admin/posts, /admin/faq
    orders.js            /admin/orders[/:id], export.csv
    customers.js         /admin/customers[/:id], export.csv
    feedback.js          /admin/feedback[/:id]            inbox + replies (Telegram threads go out via the bot)
    media.js             /admin/media, upload, list.json
    settings.js          /admin/settings?tab=…            owner / admin only
    broadcasts.js        /admin/broadcasts                owner / admin only
    account.js           /admin/account, /admin/admins    admins: owner only
  views/               partials/{head,foot,pager,image-field,editor,form-error}.ejs + one folder per section
public/admin/
  css/admin.css        panel styles (built on /css/tokens.css)
  js/admin.js          confirm dialog, image fields, gallery, sortable tables, media picker, toasts
  js/editor.js         contenteditable rich text editor (progressive enhancement of a <textarea>)
  js/dashboard.js      Chart.js charts (data comes from a JSON block in the page)
```

## Conventions

- **Auth**: everything after `router.use(auth.requireAdmin)` needs a session. Roles: `owner` (all),
  `admin` (all but admin users), `manager` (no settings / broadcasts / admin users).
- **CSRF**: every `<form method="post">` renders `<%- csrfField %>`; `fetch()` calls send the
  `X-CSRF-Token` header from `<meta name="csrf-token">`; the plain multipart form of the media
  library carries the token in the query string.
- **CSP**: no inline scripts or `on*=""` handlers. Behaviour is attached through `data-*` attributes
  (`data-confirm`, `data-image-field`, `data-gallery`, `data-editor`, `data-reorder-url`, `data-copy`, …).
- **Forms**: validation errors re-render the form with status 422 and the typed values
  (`fields = { name: message }`); state errors of one-click actions become a flash message.
- **Output**: `<%= %>` everywhere; `<%- %>` only for `csrfField`, `icon()`, includes and pre-escaped helpers.
- **Secrets**: Settings → Оплата / Тексты бота show only whether an environment key is set, never its value.
- **Uploads**: only through `media.upload` + `media.registerUpload` (type, size and magic bytes are checked).

## Adding a section

1. `controllers/<name>.js` exporting an Express router; mount it in `routes.js`.
2. Add the item to `NAV` in `lib.js` (`roles` limits visibility; guard the router with `auth.requireRole`).
3. Views in `views/<name>/…` start with `<%- include('../partials/head') %>` and end with
   `<%- include('../partials/foot') %>`; pass `title` and `section` to `res.render`.

Tests: `tests/admin.*.test.js` (auth on every route, CSRF, CRUD, content, uploads, orders, feedback replies,
broadcasts through the fake Bot API, dashboard).
