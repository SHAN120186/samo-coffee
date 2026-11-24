// Tiny in-memory fixed-window rate limiter (single process — matches the deployment model).

export class RateLimiter {
  /** @param {{windowMs?: number, max?: number}} options */
  constructor({ windowMs = 15 * 60 * 1000, max = 10 } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
    this.timer = setInterval(() => this.sweep(), Math.min(windowMs, 60_000));
    this.timer.unref();
  }

  sweep() {
    const t = Date.now();
    for (const [key, rec] of this.hits) if (rec.resetAt <= t) this.hits.delete(key);
  }

  /** Register one hit. Returns { allowed, remaining, retryAfterSec }. */
  hit(key) {
    const t = Date.now();
    let rec = this.hits.get(key);
    if (!rec || rec.resetAt <= t) {
      rec = { count: 0, resetAt: t + this.windowMs };
      this.hits.set(key, rec);
    }
    rec.count += 1;
    return {
      allowed: rec.count <= this.max,
      remaining: Math.max(0, this.max - rec.count),
      retryAfterSec: Math.ceil((rec.resetAt - t) / 1000),
    };
  }

  /** Check without counting. */
  peek(key) {
    const rec = this.hits.get(key);
    if (!rec || rec.resetAt <= Date.now()) return { allowed: true, remaining: this.max, retryAfterSec: 0 };
    return {
      allowed: rec.count < this.max,
      remaining: Math.max(0, this.max - rec.count),
      retryAfterSec: Math.ceil((rec.resetAt - Date.now()) / 1000),
    };
  }

  /** Forget a key (e.g. after a successful login). */
  reset(key) {
    this.hits.delete(key);
  }
}

/**
 * Express middleware factory.
 * rateLimit({ windowMs, max, key: (req) => string, message, json })
 * Responds 429 (JSON when `json` is true or the client asks for JSON, otherwise plain text).
 */
export function rateLimit({ windowMs = 60_000, max = 30, key = (req) => req.ip, message, json = false } = {}) {
  const limiter = new RateLimiter({ windowMs, max });
  const text = message || 'Слишком много запросов. Попробуйте чуть позже.';
  const middleware = (req, res, next) => {
    const result = limiter.hit(`${key(req)}`);
    if (result.allowed) return next();
    res.set('Retry-After', String(result.retryAfterSec));
    if (json || req.accepts(['html', 'json']) === 'json') {
      return res.status(429).json({ ok: false, error: 'rate_limited', message: text });
    }
    return res.status(429).type('text/plain; charset=utf-8').send(text);
  };
  middleware.limiter = limiter;
  return middleware;
}
