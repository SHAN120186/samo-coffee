// Paging of product lists (no imports: the same code runs in the browser and in the API tests).
// GET /api/tma/products returns at most 60 items per request together with `total`; the lists the
// app shows are loaded page by page: offset = number of items already loaded.

/** Query string of a list request; `offset` > 0 asks for the next page. It is also the cache key (offset 0). */
export function listQuery(params = {}, offset = 0) {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== '' && v !== undefined && v !== null && v !== false) query.set(k, v === true ? '1' : String(v));
  }
  if (offset > 0) query.set('offset', String(offset));
  return query.toString();
}

/** Has the list more items on the server than are loaded? */
export const hasMore = (list) => Boolean(list) && list.items.length < list.total;

/**
 * Add a page to a loaded list (products that moved between pages meanwhile are not duplicated).
 * A page that brings nothing new ends the list, so "show more" can never loop.
 * @param {{ items: object[], total: number }} list
 * @param {{ items: object[], total: number }} page API response
 * @returns {{ items: object[], total: number }} the same list object
 */
export function appendPage(list, page) {
  const seen = new Set(list.items.map((p) => p.id));
  const fresh = (page.items || []).filter((p) => !seen.has(p.id));
  list.items.push(...fresh);
  list.total = fresh.length ? Math.max(Number(page.total) || 0, list.items.length) : list.items.length;
  return list;
}
