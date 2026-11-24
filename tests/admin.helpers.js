// Shared helpers of the admin test files (not a test file itself). Import AFTER ./helpers/env.js.

export const ADMIN = { email: 'admin@samo.coffee', password: 'admin12345' };

/** Log a test client in through the real login form. Returns the login response. */
export async function login(client, creds = ADMIN, extra = {}) {
  await client.get('/admin/login');
  return client.postForm('/admin/login', { ...creds, ...extra });
}

/** POST a urlencoded form with repeated keys (images[], attr_key[] …). pairs: [[name, value], …] */
export function postPairs(client, path, pairs) {
  const body = new URLSearchParams();
  body.append('_csrf', client.csrfToken || '');
  for (const [k, v] of pairs) body.append(k, String(v));
  return client.request('POST', path, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
}

/** Multipart upload to the media library; answers JSON. files: [{ name, type, data: Buffer }] */
export function upload(client, files, { csrf = client.csrfToken, path = '/admin/media/upload' } = {}) {
  const form = new FormData();
  for (const f of files) form.append('files', new Blob([f.data], { type: f.type }), f.name);
  return client.request('POST', path, { headers: { accept: 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: form });
}

/** A valid 1×1 PNG. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** Wait until fn() returns a truthy value (polling), or fail after timeoutMs. */
export async function waitFor(fn, timeoutMs = 4000) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}
