-- Payment integrity (refunds must undo exactly what the payment did).

-- 1. Which paid order granted which period of a subscription. A refund reverts the period of THAT
--    order (not just of the latest one) and cancels the subscription when no paid period is left.
CREATE TABLE subscription_periods (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id          INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  order_id                 INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  days                     INTEGER NOT NULL CHECK (days > 0),   -- length of the granted period
  -- the subscription (another plan) that this order's subscription replaced, and the status it had:
  -- restored when the order is refunded
  replaced_subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
  replaced_status          TEXT,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reverted_at              TEXT                                  -- set when the order was refunded
);
CREATE INDEX idx_subscription_periods_sub ON subscription_periods(subscription_id);

-- Existing data: every paid subscription order belongs to the subscription it was last recorded on,
-- else to the customer's latest subscription for that plan that had started by the time of payment.
INSERT INTO subscription_periods (subscription_id, order_id, days, created_at)
SELECT s.id, o.id, p.period_days, COALESCE(o.paid_at, o.created_at)
  FROM orders o
  JOIN subscriptions s ON s.id = (
         SELECT s2.id FROM subscriptions s2
          WHERE s2.customer_id = o.customer_id AND s2.plan_id = o.plan_id
            AND (s2.last_order_id = o.id
                 OR julianday(s2.started_at) <= julianday(COALESCE(o.paid_at, o.created_at)) + 1.0 / 1440)
          ORDER BY (s2.last_order_id = o.id) DESC, s2.id DESC LIMIT 1)
  JOIN plans p ON p.id = s.plan_id
 WHERE o.kind = 'subscription' AND o.payment_status = 'paid';

-- 2. Units really taken from stock when a product order was paid. Stock never goes below zero, so an
--    oversold order takes less than its quantity — and a refund must give back only what was taken.
--    NULL = paid before this column existed (the full quantity is assumed).
ALTER TABLE order_items ADD COLUMN stock_taken INTEGER;
