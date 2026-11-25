// Open-redirect protection for "return to" values that come from the client.
//
// A string check ("starts with one slash") is not enough: browsers normalise the target before
// following it — "/.//evil.example/" and "/a/..//evil.example" both become "//evil.example/",
// "/\evil.example" is read as "//evil.example". So the candidate is resolved the same way a browser
// does it (WHATWG URL) and must still point at our own origin afterwards.

/**
 * Resolve `candidate` against `base` and return the URL only when it stays on the origin of `base`.
 * @param {unknown} candidate path ("/cart?x=1") or absolute URL
 * @param {string} base absolute URL of our own site
 * @returns {URL|null}
 */
export function resolveSameOrigin(candidate, base) {
  const c = String(candidate ?? '');
  // control characters and backslashes never appear in our own links
  // eslint-disable-next-line no-control-regex
  if (!c || c.length > 2000 || /[\u0000-\u001f\u007f\\]/.test(c)) return null;
  let origin;
  let url;
  try {
    origin = new URL(base);
    url = new URL(c, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin.origin || url.username || url.password) return null;
  // "//host/…" as a path would be a protocol-relative URL as soon as it is used as a relative link
  if (url.pathname.startsWith('//')) return null;
  return url;
}

/**
 * Same-site path for a redirect: "/path?query#hash" re-serialised from the parsed URL, or null.
 * Only values that start with "/" are considered.
 */
export function localPath(candidate, maxLength = 500) {
  const c = String(candidate ?? '');
  if (!c.startsWith('/') || c.length > maxLength) return null;
  const url = resolveSameOrigin(c, 'http://local.invalid/');
  return url ? `${url.pathname}${url.search}${url.hash}` : null;
}
