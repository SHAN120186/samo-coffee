// Gives the test process its own temporary SQLite FILE (never the default database, never shared
// between test files). Must be evaluated BEFORE ./helpers/env.js, which reads TEST_DATABASE_PATH.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEST_DB_FILE = path.join(os.tmpdir(), `samo-payments-test-${process.pid}-${Date.now()}.db`);
process.env.TEST_DATABASE_PATH = TEST_DB_FILE;
process.on('exit', () => {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(`${TEST_DB_FILE}${suffix}`, { force: true });
    } catch { /* best effort */ }
  }
});
