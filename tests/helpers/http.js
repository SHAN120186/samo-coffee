// Tiny HTTP test client with a cookie jar (no redirects followed unless asked) + app bootstrap.
//   const { client, close, baseUrl } = await startTestApp();
//   const page = await client.get('/');            → { status, headers, text, json(), location }
//   await client.postForm('/contacts', { name: 'A' })   // adds the CSRF token automatically
import { createApp } from '../../src/app.js';

export function createClient(baseUrl) {
  const jar = new Map();
  let csrf = null;

  async function request(method, path, { headers = {}, body, follow = false } = {}) {
    // Absolute URLs built from config.baseUrl (redirects, payment links) are replayed against the test server.
    if (/^https?:\/\//.test(path)) {
      const u = new URL(path);
      path = `${u.pathname}${u.search}`;
    }
    const res = await fetch(new URL(path, baseUrl), {
      method,
      redirect: 'manual',
      headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) SamoTest/1.0 Chrome/120 Safari/537.36', cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...headers },
      body,
    });
    for (const line of res.headers.getSetCookie?.() || []) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(line)) jar.delete(name);
      else jar.set(name, value);
    }
    const text = await res.text();
    const m = /name="_csrf" value="([^"]+)"/.exec(text);
    if (m) csrf = m[1];
    const location = res.headers.get('location');
    if (follow && location && res.status >= 300 && res.status < 400) {
      return request('GET', location, { follow: true });
    }
    return {
      status: res.status, headers: res.headers, text, location,
      json: () => JSON.parse(text),
    };
  }

  return {
    jar,
    get csrfToken() { return csrf; },
    get: (path, options) => request('GET', path, options),
    /** POST application/x-www-form-urlencoded; `_csrf` is filled from the last page that contained a form. */
    postForm: (path, fields = {}, options = {}) => request('POST', path, {
      ...options,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(options.headers || {}) },
      body: new URLSearchParams({ ...(csrf ? { _csrf: csrf } : {}), ...fields }).toString(),
    }),
    postJson: (path, data = {}, options = {}) => request('POST', path, {
      ...options,
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers || {}) },
      body: JSON.stringify(data),
    }),
    request,
  };
}

/** Boot the app on a random port. Returns { app, server, baseUrl, client, close }. */
export async function startTestApp(options = { bot: false }) {
  const app = await createApp(options);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    app, server, baseUrl,
    client: createClient(baseUrl),
    newClient: () => createClient(baseUrl),
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
