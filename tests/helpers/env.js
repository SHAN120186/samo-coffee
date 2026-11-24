// Import this FIRST in every test file (before anything from src/):
//   import './helpers/env.js';
// It isolates the test process: in-memory SQLite, no .env, fixed secrets, bot disabled.
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.SKIP_DOTENV = '1';
process.env.DATABASE_PATH = process.env.TEST_DATABASE_PATH || ':memory:';
process.env.SESSION_SECRET ||= 'test-secret-test-secret-test-secret';
process.env.BASE_URL ||= 'http://localhost:3000';
process.env.ADMIN_EMAIL ||= 'admin@samo.coffee';
process.env.ADMIN_PASSWORD ||= 'admin12345';
process.env.UPLOAD_DIR ||= path.join(os.tmpdir(), `samo-test-uploads-${process.pid}`);
process.env.PAYMENT_PROVIDER ||= 'mock';
// The bot is disabled unless a test imports ./env-telegram.js instead.
for (const key of ['BOT_TOKEN', 'ADMIN_CHAT_ID', 'TELEGRAM_API_ROOT', 'BOT_USERNAME']) delete process.env[key];
