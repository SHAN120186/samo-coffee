-- Samo Coffee — base schema (applied once as migration "000_schema").
-- Conventions:
--   * money: INTEGER, whole UZS sums (no tiyin) unless a column says otherwise
--   * timestamps: TEXT, ISO-8601 UTC ("2026-01-31T09:15:00.000Z"); *_time columns are INTEGER epoch ms
--   * booleans: INTEGER 0/1;  JSON: TEXT containing JSON

CREATE TABLE admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('owner','admin','manager')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at TEXT
);

CREATE TABLE admin_sessions (
  id         TEXT PRIMARY KEY,              -- sha256(token); the raw token lives only in the cookie
  admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  ip         TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_admin_sessions_admin ON admin_sessions(admin_id);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE content_blocks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  page       TEXT NOT NULL,
  key        TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text','richtext','image','link')),
  value      TEXT NOT NULL DEFAULT '',
  label      TEXT NOT NULL DEFAULT '',
  sort       INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (page, key)
);

CREATE TABLE categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image       TEXT NOT NULL DEFAULT '',
  sort        INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE products (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  slug         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  subtitle     TEXT NOT NULL DEFAULT '',     -- short line under the title (flavour notes etc.)
  description  TEXT NOT NULL DEFAULT '',     -- plain-text short description
  details_html TEXT NOT NULL DEFAULT '',     -- sanitized rich text
  price        INTEGER NOT NULL CHECK (price >= 0),
  old_price    INTEGER,                      -- crossed-out price, NULL when no discount
  images       TEXT NOT NULL DEFAULT '[]',   -- JSON array of URLs, first one is the cover
  stock        INTEGER NOT NULL DEFAULT 0,
  weight_g     INTEGER,
  roast        TEXT NOT NULL DEFAULT '',     -- e.g. "Светлая", "Средняя", "Тёмная"
  origin       TEXT NOT NULL DEFAULT '',
  process      TEXT NOT NULL DEFAULT '',     -- processing method
  attributes   TEXT NOT NULL DEFAULT '{}',   -- JSON object of extra "label: value" pairs
  active       INTEGER NOT NULL DEFAULT 1,
  featured     INTEGER NOT NULL DEFAULT 0,
  sort         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_products_category ON products(category_id, active);
CREATE INDEX idx_products_featured ON products(featured, active);

CREATE TABLE plans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price       INTEGER NOT NULL CHECK (price >= 0),   -- per period
  period_days INTEGER NOT NULL DEFAULT 30 CHECK (period_days > 0),
  perks       TEXT NOT NULL DEFAULT '[]',            -- JSON array of strings
  image       TEXT NOT NULL DEFAULT '',
  badge       TEXT NOT NULL DEFAULT '',              -- e.g. "Хит"
  active      INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE posts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  excerpt      TEXT NOT NULL DEFAULT '',
  body_html    TEXT NOT NULL DEFAULT '',     -- sanitized rich text
  cover        TEXT NOT NULL DEFAULT '',
  author       TEXT NOT NULL DEFAULT '',
  reading_min  INTEGER NOT NULL DEFAULT 3,
  published    INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_posts_published ON posts(published, published_at);

CREATE TABLE faq (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  question   TEXT NOT NULL,
  answer     TEXT NOT NULL DEFAULT '',       -- sanitized rich text
  topic      TEXT NOT NULL DEFAULT '',       -- optional grouping label
  sort       INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE tg_users (
  id            INTEGER PRIMARY KEY,         -- Telegram user id
  chat_id       INTEGER,                     -- private chat id (== id for private chats)
  username      TEXT,
  first_name    TEXT NOT NULL DEFAULT '',
  last_name     TEXT NOT NULL DEFAULT '',
  language_code TEXT,
  state         TEXT NOT NULL DEFAULT '',    -- bot conversation state, e.g. "support"
  state_data    TEXT NOT NULL DEFAULT '{}',  -- JSON
  start_param   TEXT,                        -- first deep-link payload
  source        TEXT NOT NULL DEFAULT 'bot' CHECK (source IN ('bot','tma')),
  is_blocked    INTEGER NOT NULL DEFAULT 0,  -- user blocked the bot (sendMessage 403)
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE customers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL DEFAULT '',
  phone       TEXT,                          -- normalized "+998901234567"
  email       TEXT COLLATE NOCASE,
  tg_user_id  INTEGER UNIQUE,
  tg_username TEXT,
  address     TEXT NOT NULL DEFAULT '',      -- last used delivery address
  source      TEXT NOT NULL DEFAULT 'site' CHECK (source IN ('site','tma','bot','admin')),
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_customers_phone ON customers(phone);
CREATE INDEX idx_customers_email ON customers(email);

-- One cart per site visitor (cookie token) or per Telegram user (Mini App / bot).
CREATE TABLE carts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token      TEXT UNIQUE,
  tg_user_id INTEGER UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE cart_items (
  cart_id    INTEGER NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty        INTEGER NOT NULL CHECK (qty > 0),
  added_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (cart_id, product_id)
);

CREATE TABLE orders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  number           TEXT UNIQUE,              -- human number "SC-100042"
  public_token     TEXT NOT NULL UNIQUE,     -- unguessable id for the public status page
  customer_id      INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  kind             TEXT NOT NULL DEFAULT 'product' CHECK (kind IN ('product','subscription')),
  plan_id          INTEGER REFERENCES plans(id) ON DELETE SET NULL,   -- for kind=subscription
  status           TEXT NOT NULL DEFAULT 'new'
                   CHECK (status IN ('new','pending_payment','paid','processing','shipped','delivered','cancelled','refunded')),
  payment_status   TEXT NOT NULL DEFAULT 'unpaid'
                   CHECK (payment_status IN ('unpaid','pending','paid','failed','refunded')),
  payment_provider TEXT,                     -- provider that was last used / that paid
  channel          TEXT NOT NULL DEFAULT 'site' CHECK (channel IN ('site','tma','bot','admin')),
  subtotal         INTEGER NOT NULL DEFAULT 0,
  delivery_fee     INTEGER NOT NULL DEFAULT 0,
  discount         INTEGER NOT NULL DEFAULT 0,
  total            INTEGER NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL DEFAULT 'UZS',
  customer_name    TEXT NOT NULL DEFAULT '',
  customer_phone   TEXT NOT NULL DEFAULT '',
  customer_email   TEXT NOT NULL DEFAULT '',
  delivery_method  TEXT NOT NULL DEFAULT 'courier' CHECK (delivery_method IN ('courier','pickup')),
  delivery_address TEXT NOT NULL DEFAULT '',
  comment          TEXT NOT NULL DEFAULT '',
  tg_user_id       INTEGER,                  -- Telegram user to notify (may differ from customer)
  session_id       TEXT,                     -- analytics session that created the order
  source           TEXT NOT NULL DEFAULT '', -- traffic source label at order time
  admin_note       TEXT NOT NULL DEFAULT '',
  paid_at          TEXT,
  cancelled_at     TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_orders_status ON orders(status, created_at);
CREATE INDEX idx_orders_created ON orders(created_at);
CREATE INDEX idx_orders_paid ON orders(paid_at);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_tg ON orders(tg_user_id);

CREATE TABLE order_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  plan_id    INTEGER REFERENCES plans(id) ON DELETE SET NULL,
  title      TEXT NOT NULL,                  -- snapshot
  image      TEXT NOT NULL DEFAULT '',       -- snapshot
  price      INTEGER NOT NULL,               -- snapshot unit price
  qty        INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
  total      INTEGER NOT NULL
);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_order_items_product ON order_items(product_id);

-- Status history / audit trail of an order.
CREATE TABLE order_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,                  -- created | status | payment | note
  from_value TEXT,
  to_value   TEXT,
  note       TEXT NOT NULL DEFAULT '',
  actor      TEXT NOT NULL DEFAULT 'system', -- system | customer | admin:<id> | provider:<id>
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_order_events_order ON order_events(order_id);

-- Payment attempts / provider transactions (enough for Payme & Click state machines).
CREATE TABLE payments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id       INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider       TEXT NOT NULL,              -- mock | telegram | payme | click
  provider_tx_id TEXT,                       -- provider transaction id (unique per provider)
  amount         INTEGER NOT NULL,           -- whole sums
  status         TEXT NOT NULL DEFAULT 'created'
                 CHECK (status IN ('created','pending','paid','cancelled','failed','refunded')),
  state          INTEGER NOT NULL DEFAULT 0, -- provider state code (Payme: 1, 2, -1, -2)
  reason         INTEGER,                    -- provider cancel reason code
  error          TEXT,                       -- last error text
  create_time    INTEGER,                    -- epoch ms (provider side)
  perform_time   INTEGER,
  cancel_time    INTEGER,
  raw            TEXT NOT NULL DEFAULT '{}', -- JSON: provider payload / our metadata
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_payments_provider_tx ON payments(provider, provider_tx_id) WHERE provider_tx_id IS NOT NULL;
CREATE INDEX idx_payments_order ON payments(order_id);
CREATE INDEX idx_payments_create_time ON payments(provider, create_time);

CREATE TABLE subscriptions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id        INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  plan_id            INTEGER NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','cancelled','expired')),
  started_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  current_period_end TEXT NOT NULL,
  last_order_id      INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  renewals           INTEGER NOT NULL DEFAULT 0,
  cancelled_at       TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_subscriptions_customer ON subscriptions(customer_id, status);
CREATE INDEX idx_subscriptions_period ON subscriptions(status, current_period_end);

CREATE TABLE feedback_threads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  channel         TEXT NOT NULL CHECK (channel IN ('site','bot','tma')),
  customer_id     INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  tg_user_id      INTEGER,
  tg_chat_id      INTEGER,                   -- where replies are delivered
  name            TEXT NOT NULL DEFAULT '',
  contact         TEXT NOT NULL DEFAULT '',  -- email / phone / @username
  subject         TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  unread          INTEGER NOT NULL DEFAULT 0, -- incoming messages not yet seen by an admin
  last_message_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_feedback_threads_status ON feedback_threads(status, last_message_at);
CREATE INDEX idx_feedback_threads_tg ON feedback_threads(tg_user_id);

CREATE TABLE feedback_messages (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id             INTEGER NOT NULL REFERENCES feedback_threads(id) ON DELETE CASCADE,
  direction             TEXT NOT NULL CHECK (direction IN ('in','out')),
  text                  TEXT NOT NULL,
  admin_id              INTEGER REFERENCES admins(id) ON DELETE SET NULL,  -- author of an "out" message
  via                   TEXT NOT NULL DEFAULT '',  -- "panel" | "telegram" for out messages
  tg_message_id         INTEGER,             -- message id in the USER chat (in: user's msg, out: our reply)
  admin_chat_message_id INTEGER,             -- id of the notification in ADMIN_CHAT_ID (reply mapping)
  delivered             INTEGER NOT NULL DEFAULT 0, -- out: delivered to Telegram
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_feedback_messages_thread ON feedback_messages(thread_id, id);
CREATE INDEX idx_feedback_messages_admin_msg ON feedback_messages(admin_chat_message_id);

CREATE TABLE media (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  filename      TEXT NOT NULL UNIQUE,        -- random name on disk
  original_name TEXT NOT NULL DEFAULT '',
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL DEFAULT 0,
  url           TEXT NOT NULL,               -- public URL, e.g. /uploads/ab12.webp
  alt           TEXT NOT NULL DEFAULT '',
  uploaded_by   INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE page_views (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  path          TEXT NOT NULL,
  referrer      TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT 'direct',  -- utm_source or referrer host or "direct"
  medium        TEXT NOT NULL DEFAULT 'direct',  -- direct | organic | social | referral | cpc | <utm_medium>
  utm_campaign  TEXT NOT NULL DEFAULT '',
  device        TEXT NOT NULL DEFAULT 'desktop' CHECK (device IN ('desktop','mobile','tablet')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_page_views_created ON page_views(created_at);
CREATE INDEX idx_page_views_session ON page_views(session_id);
CREATE INDEX idx_page_views_path ON page_views(path);

CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,   -- view_product | add_to_cart | begin_checkout | purchase | feedback | tma_open | bot_start | ...
  channel    TEXT NOT NULL DEFAULT 'site' CHECK (channel IN ('site','tma','bot','admin')),
  session_id TEXT,
  tg_user_id INTEGER,
  product_id INTEGER,
  order_id   INTEGER,
  value      INTEGER NOT NULL DEFAULT 0,     -- money value in sums when relevant
  meta       TEXT NOT NULL DEFAULT '{}',     -- JSON
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_events_name_created ON events(name, created_at);
CREATE INDEX idx_events_session ON events(session_id);

CREATE TABLE broadcasts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  text        TEXT NOT NULL,
  image       TEXT NOT NULL DEFAULT '',
  button_text TEXT NOT NULL DEFAULT '',
  button_url  TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sending','done','failed')),
  total       INTEGER NOT NULL DEFAULT 0,
  sent        INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);
