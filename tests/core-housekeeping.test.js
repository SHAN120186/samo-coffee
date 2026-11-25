import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { get, run } from '../src/db/index.js';
import { config } from '../src/config.js';
import * as analytics from '../src/services/analytics.js';
import * as auth from '../src/services/auth.js';

test('pruneOldPageViews removes only page views older than the retention window', () => {
  run('DELETE FROM page_views');
  const old = new Date(Date.now() - 500 * 86400000).toISOString();
  const recent = new Date(Date.now() - 10 * 86400000).toISOString();
  run("INSERT INTO page_views (session_id, path, created_at) VALUES ('s1', '/', ?)", old);
  run("INSERT INTO page_views (session_id, path, created_at) VALUES ('s2', '/', ?)", recent);
  assert.equal(analytics.pruneOldPageViews(400), 1);
  assert.equal(get('SELECT COUNT(*) AS n FROM page_views').n, 1);
  assert.equal(analytics.pruneOldPageViews(0), 0, '0 keeps everything');
  assert.equal(get('SELECT COUNT(*) AS n FROM page_views').n, 1);
});

test('the first admin is not created from an ADMIN_PASSWORD shorter than the minimum', () => {
  run('DELETE FROM admin_sessions');
  run('DELETE FROM admins');
  const saved = config.admin.password;
  try {
    config.admin.password = 'short';
    assert.equal(auth.ensureDefaultAdmin(), null);
    assert.equal(get('SELECT COUNT(*) AS n FROM admins').n, 0);
    config.admin.password = 'long-enough-password';
    assert.ok(auth.ensureDefaultAdmin());
    assert.equal(get('SELECT COUNT(*) AS n FROM admins').n, 1);
  } finally {
    config.admin.password = saved;
  }
});
