// Structured (one JSON object per line) log of payment activity: provider callbacks, started
// payments, refused requests. Secrets never reach the log: credentials, signatures and tokens are
// replaced by "[redacted]" by key name, wherever they sit in the logged object.
//
//   {"ts":"2026-01-01T10:00:00.000Z","scope":"payments","event":"payme.rpc","method":"PerformTransaction",
//    "tx":"5f1a…","order":42,"state":2,"ms":3}
import { config } from '../config.js';

const SECRET_KEY = /^(authorization|cookie|sign_string|sign|signature|secret|secret_key|key|password|provider_token|token|x-auth)$/i;
const MAX_STRING = 300;
const MAX_DEPTH = 4;

/** Deep copy with secrets masked and long strings shortened. */
export function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

const defaultSink = (entry) => {
  if (config.isTest) return;
  const line = JSON.stringify(entry);
  if (entry.level === 'error') console.error(line);
  else console.log(line);
};
let sink = defaultSink;

/**
 * Write one log entry.
 * @param {string} event e.g. "payme.rpc", "click.complete", "start", "mock.result"
 * @param {object} [fields] flat JSON-serializable details (masked by redact())
 */
export function paymentLog(event, fields = {}) {
  try {
    sink({ ts: new Date().toISOString(), scope: 'payments', event, ...redact(fields) });
  } catch { /* logging must never break a payment */ }
}

/** Replace the log sink (tests, shipping logs elsewhere). Returns a function that restores the default. */
export function setLogSink(fn) {
  sink = typeof fn === 'function' ? fn : defaultSink;
  return () => {
    sink = defaultSink;
  };
}
