// Small in-memory response cache.
//
// Every navigation re-fetches every subresource, and that upstream latency
// dominates page load time - the proxy's own overhead is only a few
// milliseconds. This caches cacheable GET responses (no request cookies, no
// Set-Cookie, explicit freshness, bounded body) so repeat loads and assets
// shared between pages are served straight from memory.

const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** @type {Map<string, {status:number, headers:object, body:Buffer, expires:number, size:number}>} */
const store = new Map();
let totalBytes = 0;

export function cacheKey(method, targetUrl) {
  return `${method} ${targetUrl}`;
}

export function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expires <= Date.now()) {
    store.delete(key);
    totalBytes -= entry.size;
    return null;
  }
  // Refresh recency for LRU eviction.
  store.delete(key);
  store.set(key, entry);
  return entry;
}

export function set(key, entry) {
  const size = entry.body.length;
  if (size > MAX_ENTRY_BYTES) return;
  const existing = store.get(key);
  if (existing) {
    store.delete(key);
    totalBytes -= existing.size;
  }
  store.set(key, { ...entry, size });
  totalBytes += size;
  while (totalBytes > MAX_TOTAL_BYTES && store.size > 1) {
    const oldest = store.keys().next().value;
    const evicted = store.get(oldest);
    store.delete(oldest);
    totalBytes -= evicted.size;
  }
}