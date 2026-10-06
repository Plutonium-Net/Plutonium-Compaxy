// Core proxy request handler: fetch upstream, translate headers/cookies,
// rewrite text responses and stream everything else.
//
// Upstream latency dominates every request (the proxy's own work is a couple of
// milliseconds), so cacheable GET responses are served from an in-memory cache
// and the upstream connection is kept alive across requests.

import { Readable } from "node:stream";
import { assertPublicDestination } from "./urls.js";
import { upstreamRequestHeaders, downstreamResponseHeaders } from "./headers.js";
import { rewriteHtml, rewriteCss, decodeText } from "./rewrite.js";
import { cacheKey, get as cacheGet, set as cacheSet } from "./cache.js";

const MAX_TEXT_BYTES = 16 * 1024 * 1024;
// Cap on a body we are willing to buffer purely to cache it.
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;

const TEXTUAL = (type) =>
  type.includes("text/html") ||
  type.includes("application/xhtml+xml") ||
  type.includes("text/css");

const MEDIA = (type) => /^(video|audio)\/|event-stream/.test(type);

/**
 * Cacheable freshness in seconds, from the upstream Cache-Control header.
 * Anything explicitly private or unshareable returns 0.
 */
function freshnessSeconds(headers) {
  const control = headers.get("cache-control") || "";
  if (/(?:^|,)\s*(?:no-store|private|no-cache)\b/i.test(control)) return 0;
  const shared = /s-maxage\s*=\s*(\d+)/i.exec(control);
  if (shared) return Number(shared[1]);
  const max = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(control);
  if (max) return Number(max[1]);
  return 0;
}

/**
 * Whether a response may be reused for another request: only unauthenticated,
 * uncookied, non-range GETs, with explicit freshness and no Set-Cookie, and
 * never media (which is large and often streamed once).
 */
function storableTtl(req, upstream, contentType) {
  if (upstream.status !== 200) return 0;
  if (req.headers.authorization || req.headers.range) return 0;
  if (upstream.headers.has("set-cookie")) return 0;
  // Only reuse a response whose Vary is limited to what the proxy itself
  // fixes per request, so a cached entry can never answer a request that
  // should have received something personalised (cookie, origin, language...).
  const vary = (upstream.headers.get("vary") || "").toLowerCase();
  if (vary) {
    const fields = vary.split(",").map((field) => field.trim()).filter(Boolean);
    if (!fields.every((field) => field === "accept-encoding")) return 0;
  }
  if (MEDIA(contentType)) return 0;
  return freshnessSeconds(upstream.headers);
}

export async function handleProxy(req, res, targetUrl) {
  // Fast path: a cache hit never touches the network.
  const cacheableRequest =
    req.method === "GET" && !req.headers.authorization && !req.headers.range;
  const key = cacheableRequest ? cacheKey(req.method, targetUrl) : null;
  if (key) {
    const hit = cacheGet(key);
    if (hit) {
      res.writeHead(hit.status, hit.headers);
      res.end(hit.body);
      return;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  // Only abort when the client actually bailed out before the response was
  // fully written. Aborting after a normal finish would tear down the upstream
  // connection and force a fresh TLS handshake on the next request.
  const onClose = () => {
    if (!res.writableFinished) controller.abort();
  };
  res.on("close", onClose);

  try {
    await assertPublicDestination(targetUrl);

    const init = {
      method: req.method,
      redirect: "manual",
      signal: controller.signal,
      headers: upstreamRequestHeaders(req.headers, targetUrl, req.headers.cookie)
    };

    if (!["GET", "HEAD"].includes(req.method)) {
      init.body = Readable.toWeb(req);
      init.duplex = "half";
    }

    const upstream = await fetch(targetUrl, init);
    const entry = await sendResponse(req, res, upstream, targetUrl);
    if (key && entry) cacheSet(key, entry);
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendError(res, error);
  } finally {
    clearTimeout(timer);
    res.off("close", onClose);
  }
}

/**
 * Send the upstream response downstream. Returns a cache entry when the
 * response may be reused, otherwise null.
 */
async function sendResponse(req, res, upstream, targetUrl) {
  const headers = downstreamResponseHeaders(upstream.headers, targetUrl);
  const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
  const ttl = storableTtl(req, upstream, contentType);

  // Redirects: hand the rewritten Location back to the browser so the frame
  // follows it through the proxy.
  if (upstream.status >= 300 && upstream.status < 400 && headers.location) {
    res.writeHead(upstream.status, headers);
    res.end();
    return null;
  }

  if (req.method === "HEAD" || upstream.status === 204 || upstream.status === 304) {
    res.writeHead(upstream.status, headers);
    res.end();
    return null;
  }

  // Textual content: buffer, decode with the declared charset, rewrite and
  // re-emit as UTF-8. Ranges are ignored for these.
  if (TEXTUAL(contentType)) {
    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.byteLength > MAX_TEXT_BYTES) {
      throw new Error("Response is too large to rewrite.");
    }

    let body;
    if (contentType.includes("text/css")) {
      body = rewriteCss(decodeText(buffer, contentType), targetUrl);
      headers["content-type"] = "text/css; charset=utf-8";
    } else {
      body = rewriteHtml(decodeText(buffer, contentType), targetUrl);
      headers["content-type"] = "text/html; charset=utf-8";
    }
    const out = Buffer.from(body);
    headers["content-length"] = out.length;
    // Rewritten HTML embeds the injected shim, so it is never left in the
    // *browser* cache - only in ours. Other assets keep the upstream freshness
    // so the browser can reuse them.
    if (!ttl || contentType.includes("text/html") || contentType.includes("xhtml")) {
      headers["cache-control"] = "no-store";
    }
    res.writeHead(upstream.status, headers);
    res.end(out);
    if (ttl && out.length <= MAX_CACHE_BYTES) {
      return { status: upstream.status, headers, body: out, expires: Date.now() + ttl * 1000 };
    }
    return null;
  }

  // Everything else (JS, JSON, images, fonts, wasm, media) streams through
  // byte-for-byte. Small cacheable bodies are buffered once so later requests
  // skip the network entirely; everything else is streamed without buffering.
  // content-length is the compressed size for encoded responses, so cap it
  // lower there: decompression can expand text several-fold.
  const declared = Number(upstream.headers.get("content-length") || 0);
  const bufferLimit = upstream.headers.has("content-encoding")
    ? MAX_CACHE_BYTES / 16
    : MAX_CACHE_BYTES;
  if (ttl && upstream.body && declared && declared <= bufferLimit) {
    const buffer = Buffer.from(await upstream.arrayBuffer());
    headers["content-length"] = buffer.length;
    res.writeHead(upstream.status, headers);
    res.end(buffer);
    if (buffer.length <= MAX_CACHE_BYTES) {
      return { status: upstream.status, headers, body: buffer, expires: Date.now() + ttl * 1000 };
    }
    return null;
  }

  res.writeHead(upstream.status, headers);
  if (upstream.body) {
    Readable.fromWeb(upstream.body).pipe(res);
  } else {
    res.end();
  }
  return null;
}

function sendError(res, error) {
  const message = String(error?.message || error);
  const body = `<!doctype html><meta charset="utf-8">
<main style="font-family:system-ui;padding:32px;line-height:1.5;max-width:60ch">
  <h1>Proxy could not load this page</h1>
  <pre style="white-space:pre-wrap">${escapeHtml(message)}</pre>
</main>`;
  res.writeHead(502, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
