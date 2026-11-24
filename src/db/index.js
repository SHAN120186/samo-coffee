// SQLite access (node:sqlite, synchronous). One shared connection per process.
// Services import { db, tx, now } from here; route files never touch SQL.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function open() {
  if (config.databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  }
  const conn = new DatabaseSync(config.databasePath);
  conn.exec('PRAGMA journal_mode = WAL');
  conn.exec('PRAGMA foreign_keys = ON');
  conn.exec('PRAGMA busy_timeout = 5000');
  conn.exec('PRAGMA synchronous = NORMAL');
  // SQLite lower()/LIKE are ASCII-only; ulower() makes case-insensitive Cyrillic search possible:
  //   WHERE ulower(name) LIKE ?   (bind `%${text.toLocaleLowerCase('ru')}%`)
  conn.function('ulower', { deterministic: true }, (v) => (v === null || v === undefined ? null : String(v).toLocaleLowerCase('ru')));
  return conn;
}

/** The shared DatabaseSync connection. */
export const db = open();

/** Current time as ISO-8601 UTC string — the format of every timestamp column. */
export const now = () => new Date().toISOString();

/** ISO string for a Date / epoch ms. */
export const iso = (d) => new Date(d).toISOString();

let txDepth = 0;
/**
 * Run fn inside a transaction (nested calls use savepoints). Returns fn's result.
 * fn must be synchronous — never await inside a transaction.
 */
export function tx(fn) {
  const depth = txDepth++;
  const sp = `sp_${depth}`;
  db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
  try {
    const result = fn();
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return result;
  } catch (err) {
    try {
      db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    } catch { /* connection already rolled back */ }
    throw err;
  } finally {
    txDepth--;
  }
}

const stmtCache = new Map();
/** Cached prepared statement. */
export function q(sql) {
  let s = stmtCache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

/** Convenience helpers: positional params only (parameterized SQL everywhere). */
// Rows are returned as plain objects (node:sqlite yields null-prototype objects).
export const get = (sql, ...params) => {
  const row = q(sql).get(...params);
  return row ? { ...row } : undefined;
};
export const all = (sql, ...params) => q(sql).all(...params).map((r) => ({ ...r }));
export const run = (sql, ...params) => q(sql).run(...params);

/** Parse a JSON column safely. */
export function parseJson(text, fallback) {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * Lightweight migration runner.
 * "000_schema" = schema.sql, then every src/db/migrations/NNN_name.sql in lexical order.
 * Each file runs once inside a transaction and is recorded in schema_migrations.
 */
export function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  const files = [{ name: '000_schema', file: path.join(here, 'schema.sql') }];
  const dir = path.join(here, 'migrations');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      files.push({ name: f.replace(/\.sql$/, ''), file: path.join(dir, f) });
    }
  }
  const done = [];
  for (const m of files) {
    if (applied.has(m.name)) continue;
    const sql = fs.readFileSync(m.file, 'utf8');
    tx(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(m.name);
    });
    done.push(m.name);
  }
  return done;
}

export function closeDb() {
  try {
    stmtCache.clear();
    db.close();
  } catch { /* already closed */ }
}

// The schema is always up to date as soon as anything imports the db.
migrate();
