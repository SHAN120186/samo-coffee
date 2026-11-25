// Environment of the browser E2E test: the app must generate absolute URLs (payment redirects)
// that point at the port the test server really listens on. Import FIRST.
export const E2E_PORT = 21000 + (process.pid % 20000);
process.env.BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
// (helpers/env.js keeps a BASE_URL that is already set)
