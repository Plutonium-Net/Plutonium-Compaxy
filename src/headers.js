// Request/response header and cookie translation for the proxy.
//
// Everything here is server-owned: the browser only ever talks to this origin,
// so upstream security headers that assume a different origin (CSP, X-Frame-
// Options, HSTS, cross-origin isolation) must be dropped, redirects and cookies
// must be re-scoped to our proxy paths, and content-encoding must be dropped
// because fetch has already decoded the body.
//
// Dropping X-Frame-Options/frame-ancestors is also what makes the proxy
// embeddable in someone else's page.

import { toProxyUrl, PROXY_PREFIX } from "./urls.js";

const DROP_RESPONSE_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "frame-options",
  "strict-transport-security",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "permissions-policy",
  "report-to",
  "reporting-endpoints",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "alt-svc"
]);

// Hop-by-hop headers must not be forwarded from the client either.
const DROP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "content-length",
  "accept-encoding",
  "cookie"
]);

/**
 * Build the upstream request headers from an incoming proxy request.
 */
export function upstreamRequestHeaders(incoming, targetUrl, cookieHeader) {
  const headers = {};
  for (const [key, value] of Object.entries(incoming)) {
    const lower = key.toLowerCase();
    if (DROP_REQUEST_HEADERS.has(lower)) continue;
    if (
      lower.startsWith("sec-") &&
      lower !== "sec-fetch-dest" &&
      lower !== "sec-ch-prefers-color-scheme"
    ) {
      continue;
    }
    if (value === undefined) continue;
    headers[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  headers["user-agent"] = headers["user-agent"] || UA;
  headers["accept-language"] = headers["accept-language"] || "en-US,en;q=0.9";
  // Compressed upstream transfers cut the dominant cost: bytes over the
  // network. fetch decompresses transparently (the content-encoding header is
  // dropped downstream anyway). Range requests must stay identity so byte
  // offsets keep meaning.
  headers["accept-encoding"] = headers.range ? "identity" : "gzip, deflate, br";
  const target = new URL(targetUrl);
  headers["host"] = target.host;
  // The browser's Origin/Referer name our proxy address. Upstream checks (and
  // YouTube's stream protection in particular) validate that a request comes
  // from the page that made it, so each value is mapped back to the real site
  // it stands for - not to whatever host this particular request targets.
  const page = unproxyUrl(headers.referer);
  const pageOrigin = page ? new URL(page).origin : null;
  if (page) {
    // Chrome's default referrer policy sends the whole URL only for same-site
    // requests, and just the origin for cross-site ones. Mirror that, so a
    // cross-site request looks exactly like the one the real page makes.
    headers.referer =
      pageOrigin === target.origin ? page : `${pageOrigin}/`;
  } else if (headers.referer) {
    headers.referer = targetUrl;
  }
  if (headers.origin) {
    const realOrigin = unproxyUrl(headers.origin);
    headers.origin = realOrigin ? new URL(realOrigin).origin : target.origin;
  } else if (pageOrigin && pageOrigin !== target.origin) {
    // The browser only sends Origin for cross-origin requests. From its point
    // of view every proxy path is same-origin, so the header is missing and
    // has to be reconstructed for the cross-site requests the real page makes.
    headers.origin = pageOrigin;
  }
  if (cookieHeader) headers.cookie = cookieHeader;
  return headers;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/**
 * Map an address the browser used for a proxied page back to the real URL it
 * stands for. Returns null when the value is not a proxied address (e.g. a
 * genuine third-party URL).
 */
function unproxyUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.pathname.startsWith(PROXY_PREFIX)) return null;

  const rest = url.pathname.slice(PROXY_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash === -1) return null;
  const scheme = rest.slice(0, slash);
  if (scheme !== "http" && scheme !== "https") return null;
  return `${scheme}://${rest.slice(slash + 1)}${url.search}`;
}

/**
 * Rewrite upstream response headers for delivery to the browser.
 * `targetUrl` is the URL the response actually came from (post-redirect).
 */
export function downstreamResponseHeaders(upstreamHeaders, targetUrl) {
  const headers = {};
  for (const [key, value] of upstreamHeaders.entries()) {
    const lower = key.toLowerCase();
    if (DROP_RESPONSE_HEADERS.has(lower)) continue;
    if (lower === "set-cookie") continue;
    if (lower === "location") {
      headers.location = mapReference(value, targetUrl);
      continue;
    }
    if (lower === "refresh") {
      headers.refresh = rewriteRefresh(value, targetUrl);
      continue;
    }
    if (lower === "link") {
      headers.link = rewriteLinkHeader(value, targetUrl);
      continue;
    }
    headers[lower] = value;
  }

  const cookies = upstreamHeaders.getSetCookie
    ? upstreamHeaders.getSetCookie()
    : [];
  const rewritten = cookies
    .map((cookie) => rewriteSetCookie(cookie, targetUrl))
    .filter(Boolean);
  if (rewritten.length) headers["set-cookie"] = rewritten;

  return headers;
}

/** Map a URL reference to the address the browser should request next. */
function mapReference(value, targetUrl) {
  try {
    return toProxyUrl(new URL(value, targetUrl));
  } catch {
    return value;
  }
}

function rewriteRefresh(value, targetUrl) {
  return String(value).replace(/url\s*=\s*([^;\s]+)/i, (match, url) => {
    try {
      return `url=${mapReference(url, targetUrl)}`;
    } catch {
      return match;
    }
  });
}

function rewriteLinkHeader(value, targetUrl) {
  return String(value).replace(/<([^>]+)>/g, (match, url) => {
    try {
      return `<${mapReference(url, targetUrl)}>`;
    } catch {
      return match;
    }
  });
}

/**
 * Re-scope a Set-Cookie header so it is stored for the proxied origin only.
 * Domain is dropped (cookies must stay host-only per proxied site) and the
 * upstream SameSite value is preserved, because SameSite=None is what lets a
 * cookie be sent when the proxy is embedded in a third-party page. Secure is
 * kept only where the browser requires it (SameSite=None, and the __Secure-/
 * __Host- name prefixes); a plain cookie stays non-secure so it is accepted
 * even where the proxy host is not treated as a secure context.
 */
function rewriteSetCookie(cookie, targetUrl) {
  const url = new URL(targetUrl);
  const semi = cookie.indexOf(";");
  const pair = (semi === -1 ? cookie : cookie.slice(0, semi)).trim();
  if (!pair || !pair.includes("=")) return "";
  const attrs = [];

  const rest = semi === -1 ? "" : cookie.slice(semi + 1);
  // Scope the cookie to this origin's /proxy/... path so the browser only ever
  // sends it back for this origin's requests - the upstream path is not ours
  // to use, and Path=/ would leak one proxied site's cookies to another.
  const path = `${PROXY_PREFIX}${url.protocol.replace(":", "")}/${url.host}/`;
  let sameSite = null;
  for (const raw of rest.split(";")) {
    const part = raw.trim();
    if (!part) continue;
    const eq = part.indexOf("=");
    const name = (eq === -1 ? part : part.slice(0, eq)).trim().toLowerCase();
    if (name === "domain" || name === "path" || name === "secure") continue;
    if (name === "samesite") {
      sameSite = part.slice(eq + 1).trim().toLowerCase();
      continue;
    }
    attrs.push(part);
  }
  const samesite =
    sameSite === "none" ? "None" : sameSite === "strict" ? "Strict" : "Lax";
  // Secure is only kept where it is mandatory, so plain cookies stay as
  // permissive as before: SameSite=None is only valid with Secure, and the
  // __Secure-/__Host- name prefixes are rejected without it. Otherwise it is
  // dropped (the proxy does not serve HTTPS).
  const prefixed = /^__(?:secure|host)-/i.test(pair);
  const secure = samesite === "None" || prefixed;
  const out = [`${pair}; Path=${path}`, ...attrs];
  if (secure) out.push("Secure");
  out.push(`SameSite=${samesite}`);
  return out.join("; ");
}
