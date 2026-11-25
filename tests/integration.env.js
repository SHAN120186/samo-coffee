// Environment of the integration tests: the common isolated test env + the Mini App "dev preview"
// login, so the Mini App API can be called without building Telegram initData.
// Import FIRST (before anything from src/). No top-level await here (see helpers/env-telegram.js).
import './helpers/env.js';

process.env.TMA_DEV_AUTH = '1';
