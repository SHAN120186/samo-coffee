// Deployment behaviour (Docker / Railway), checked on real child processes:
//   * configuration: DATA_DIR keeps the database and the uploads together, BASE_URL falls back to
//     https://$RAILWAY_PUBLIC_DOMAIN, trust proxy, listen address;
//   * `node src/server.js` with SEED_ON_EMPTY=1: the first boot loads the demo data into DATA_DIR,
//     the second boot changes nothing; uploads are written to DATA_DIR/uploads and served at /uploads;
//   * the container entry script starts the same server.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samo-ops-'));
const children = new Set();
const NODE_FLAGS = ['--disable-warning=ExperimentalWarning'];
/** A clean environment: nothing leaks in from the developer's shell or .env. */
const baseEnv = () => ({ PATH: process.env.PATH, SKIP_DOTENV: '1' });

after(() => {
  for (const child of children) child.kill('SIGKILL');
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Evaluate src/config.js in a child process with the given environment. */
function loadConfig(env) {
  const script = "import('./src/config.js').then(({ config: c }) => console.log(JSON.stringify({ baseUrl: c.baseUrl, isHttps: c.isHttps, trustProxy: c.trustProxy, host: c.host, port: c.port, dataDir: c.dataDir, databasePath: c.databasePath, uploads: c.uploads.dir, tma: c.tma.url, seedOnEmpty: c.seedOnEmpty })))";
  const res = spawnSync(process.execPath, [...NODE_FLAGS, '-e', script], { cwd: ROOT, env: { ...baseEnv(), ...env }, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

async function waitFor(check, what, timeoutMs = 20_000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
}

async function startServer(env, entry = 'src/server.js') {
  const port = await freePort();
  const child = spawn(process.execPath, [...NODE_FLAGS, entry], {
    cwd: ROOT,
    env: { ...baseEnv(), NODE_ENV: 'development', PORT: String(port), SESSION_SECRET: 'ops-test-secret-0123456789', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  const server = { port, output: '', exitCode: undefined, url: `http://127.0.0.1:${port}` };
  child.stdout.on('data', (chunk) => { server.output += chunk; });
  child.stderr.on('data', (chunk) => { server.output += chunk; });
  child.on('exit', (code) => {
    server.exitCode = code;
    children.delete(child);
  });
  server.stop = async () => {
    child.kill('SIGTERM');
    await waitFor(() => server.exitCode !== undefined, 'server exit');
    return server.exitCode;
  };
  await waitFor(() => {
    if (server.exitCode !== undefined) throw new Error(`server exited (${server.exitCode}):\n${server.output}`);
    return /\[samo\] \w+ · http/.test(server.output);
  }, `server start:\n${server.output}`);
  return server;
}

test('config: DATA_DIR holds the database and the uploads; explicit paths still win', () => {
  const dir = path.join(tmp, 'volume');
  const c = loadConfig({ DATA_DIR: dir });
  assert.equal(c.dataDir, dir);
  assert.equal(c.databasePath, path.join(dir, 'samo.db'));
  assert.equal(c.uploads, path.join(dir, 'uploads'));

  const def = loadConfig({});
  assert.equal(def.databasePath, path.join(ROOT, 'data', 'samo.db'));
  assert.equal(def.uploads, path.join(ROOT, 'data', 'uploads'));
  assert.equal(def.host, '0.0.0.0', 'listens on every interface by default');
  assert.equal(def.seedOnEmpty, false, 'demo data is opt-in');

  const custom = loadConfig({ DATA_DIR: dir, DATABASE_PATH: '/srv/db/shop.db', UPLOAD_DIR: '/srv/media' });
  assert.equal(custom.databasePath, '/srv/db/shop.db');
  assert.equal(custom.uploads, '/srv/media');

  // empty values (docker-compose blanks them) mean "use the default"
  const blank = loadConfig({ DATA_DIR: dir, DATABASE_PATH: '', UPLOAD_DIR: '' });
  assert.equal(blank.databasePath, path.join(dir, 'samo.db'));
  assert.equal(blank.uploads, path.join(dir, 'uploads'));
});

test('config: BASE_URL falls back to the Railway domain; trust proxy behind the platform proxy', () => {
  const railway = loadConfig({ RAILWAY_PUBLIC_DOMAIN: 'samo-production.up.railway.app', RAILWAY_ENVIRONMENT: 'production', PORT: '8080' });
  assert.equal(railway.baseUrl, 'https://samo-production.up.railway.app');
  assert.equal(railway.isHttps, true);
  assert.equal(railway.tma, 'https://samo-production.up.railway.app/tma/');
  assert.equal(railway.trustProxy, '1', 'one proxy in front on Railway, even without NODE_ENV=production');
  assert.equal(railway.port, 8080, 'the platform-assigned PORT is used');

  const explicit = loadConfig({ RAILWAY_PUBLIC_DOMAIN: 'samo-production.up.railway.app', BASE_URL: 'https://samo.coffee/' });
  assert.equal(explicit.baseUrl, 'https://samo.coffee', 'an explicit BASE_URL (custom domain) wins');

  const local = loadConfig({ PORT: '4567' });
  assert.equal(local.baseUrl, 'http://localhost:4567');
  assert.equal(local.trustProxy, '', 'no proxy is trusted in local development');

  assert.equal(loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(24) }).trustProxy, '1');
  for (const off of ['0', 'false', 'off']) {
    assert.equal(loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(24), TRUST_PROXY: off }).trustProxy, '', `TRUST_PROXY=${off} disables it`);
  }
});

test('SEED_ON_EMPTY: first boot fills DATA_DIR, the second boot leaves the data alone', async () => {
  const dir = path.join(tmp, 'railway-volume');
  const env = { DATA_DIR: dir, SEED_ON_EMPTY: '1' };

  const first = await startServer(env);
  assert.match(first.output, /SEED_ON_EMPTY: demo data loaded \(12 products/);
  assert.ok(fs.existsSync(path.join(dir, 'samo.db')), 'database is created inside DATA_DIR');
  assert.ok(fs.statSync(path.join(dir, 'uploads')).isDirectory(), 'uploads directory is created inside DATA_DIR');
  assert.equal((await (await fetch(`${first.url}/healthz`)).json()).ok, true);
  const catalogPage = await (await fetch(`${first.url}/catalog`)).text();
  assert.match(catalogPage, /Эфиопия Иргачефф/);

  // a file in DATA_DIR/uploads is served at the public /uploads URL
  fs.writeFileSync(path.join(dir, 'uploads', 'probe.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const upload = await fetch(`${first.url}/uploads/probe.png`);
  assert.equal(upload.status, 200);
  assert.equal(upload.headers.get('content-type'), 'image/png');
  assert.equal(await first.stop(), 0);

  // the owner works with the shop, then the service is redeployed
  const counts = (db) => db.prepare('SELECT (SELECT COUNT(*) FROM products) AS products, (SELECT COUNT(*) FROM orders) AS orders, (SELECT COUNT(*) FROM customers) AS customers, (SELECT COUNT(*) FROM content_blocks) AS blocks').get();
  let db = new DatabaseSync(path.join(dir, 'samo.db'));
  db.prepare("UPDATE products SET title = 'Товар владельца' WHERE slug = 'ethiopia-yirgacheffe'").run();
  db.prepare("DELETE FROM products WHERE slug = 'v60-dripper'").run();
  const before = { ...counts(db) };
  db.close();

  const second = await startServer(env);
  assert.match(second.output, /SEED_ON_EMPTY: the database already has data — nothing was changed/);
  assert.match(await (await fetch(`${second.url}/catalog`)).text(), /Товар владельца/);
  assert.equal((await fetch(`${second.url}/uploads/probe.png`)).status, 200, 'uploads survive the restart');
  assert.equal(await second.stop(), 0);
  db = new DatabaseSync(path.join(dir, 'samo.db'), { readOnly: true });
  assert.deepEqual({ ...counts(db) }, before, 'no rows were added or removed');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM products WHERE slug = 'v60-dripper'").get().n, 0, 'a deleted demo product does not come back');
  db.close();
});

test('without SEED_ON_EMPTY a new database stays empty and the site still works', async () => {
  const dir = path.join(tmp, 'clean-volume');
  const server = await startServer({ DATA_DIR: dir });
  assert.doesNotMatch(server.output, /SEED_ON_EMPTY/);
  for (const page of ['/', '/catalog', '/subscriptions', '/blog', '/faq', '/cart', '/admin/login', '/tma/']) {
    assert.equal((await fetch(`${server.url}${page}`)).status, 200, `${page} renders on an empty database`);
  }
  assert.equal(await server.stop(), 0);
  const db = new DatabaseSync(path.join(dir, 'samo.db'), { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM products').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM admins').get().n, 1, 'the first admin is created');
  db.close();
});

test('the container entry script starts the server (Dockerfile CMD)', async () => {
  const dir = path.join(tmp, 'container-volume');
  // RUN_AS_USER points to a user that does not exist, so the script keeps the current user here;
  // the privilege drop itself needs root and a real "node" user (the Docker image has both).
  const server = await startServer({ DATA_DIR: dir, RUN_AS_USER: 'no-such-user-for-tests' }, 'scripts/container-start.mjs');
  assert.equal((await (await fetch(`${server.url}/healthz`)).json()).ok, true);
  assert.ok(fs.existsSync(path.join(dir, 'samo.db')));
  assert.equal(await server.stop(), 0);
});
