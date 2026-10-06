// URL scheme, normalisation and SSRF protection.
//
// A target is served at a path that mirrors the target's own path:
//
//     https://example.com/a/b.css   ->   /proxy/https/example.com/a/b.css
//
// Mirroring the path - instead of carrying the target in a query string on
// every request - is what makes a pure fetch-and-rewrite proxy behave like the
// real site: a relative reference "c.png" inside that document resolves to
// /proxy/https/example.com/a/c.png in the browser itself, with no parsing on
// our side, and client-side routers keep seeing the paths they expect.
//
// /?url=<target> is the entry point (an iframe src or a typed address);
// server.js immediately turns it into the path form above.

import net from "node:net";
import dns from "node:dns/promises";

export const PROXY_PREFIX = "/proxy/";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

/**
 * Turn an absolute target URL into the proxy path it is served under.
 * Returns the input unchanged when it is not a proxiable URL.
 */
export function toProxyUrl(target) {
  let url;
  try {
    url = target instanceof URL ? target : new URL(String(target));
  } catch {
    return String(target);
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return url.href;
  const scheme = url.protocol.slice(0, -1);
  return `${PROXY_PREFIX}${scheme}/${url.host}${url.pathname}${url.search}`;
}

/**
 * Rebuild the absolute target URL from a /proxy/... request path.
 * Throws on malformed or disallowed targets.
 */
export function fromProxyRequest(pathname, search = "") {
  if (!pathname.startsWith(PROXY_PREFIX)) {
    throw new Error("Not a proxy request.");
  }
  const rest = pathname.slice(PROXY_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash === -1) throw new Error("Malformed proxy URL.");
  const scheme = rest.slice(0, slash);
  const hostAndPath = rest.slice(slash + 1);
  if (!["http", "https", "ws", "wss"].includes(scheme)) {
    throw new Error(`Unsupported protocol "${scheme}".`);
  }
  if (!hostAndPath) throw new Error("Malformed proxy URL.");
  return `${scheme}://${hostAndPath}${search}`;
}

/**
 * Resolve a relative reference against the page it appeared on, and return the
 * address the browser should request instead. Used while rewriting document
 * attributes and stylesheet bodies.
 */
export function proxifyReference(reference, pageUrl) {
  const value = String(reference ?? "").trim();
  if (!value) return reference;
  if (/^(#|data:|blob:|javascript:|mailto:|tel:|about:|filesystem:)/i.test(value)) {
    return reference;
  }
  try {
    const absolute = new URL(value, pageUrl);
    if (!ALLOWED_PROTOCOLS.has(absolute.protocol)) return reference;
    return toProxyUrl(absolute);
  } catch {
    return reference;
  }
}

/**
 * Resolve the ?url= entry point value into an absolute URL.
 */
export function normalizeTargetUrl(input) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) throw new Error("No address given.");

  let url;
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)) {
    url = new URL(trimmed);
  } else if (trimmed.startsWith("//")) {
    url = new URL(`https:${trimmed}`);
  } else {
    url = new URL(`https://${trimmed}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs can be proxied.");
  }
  if (isBlockedHost(url.hostname)) {
    throw new Error("That host is blocked to protect private networks.");
  }
  return url.href;
}

export function isBlockedHost(hostname) {
  const lower = String(hostname).toLowerCase();
  if (["localhost", "localhost.localdomain"].includes(lower)) return true;
  if (lower.endsWith(".local") || lower.endsWith(".internal")) return true;
  return isBlockedIp(lower);
}

export function isBlockedIp(value) {
  const ipType = net.isIP(value);
  if (ipType === 6) {
    const lower = value.toLowerCase();
    return (
      lower === "::1" ||
      lower === "::" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe80")
    );
  }
  if (ipType === 4) {
    const [a, b] = value.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return false;
}

/**
 * Refuse to fetch private-network destinations, including hostnames that
 * resolve to private addresses.
 */
// Hostname -> resolved verdict, so the guard does not re-resolve DNS on every
// subresource of every page.
const DNS_TTL_MS = 60_000;
const DNS_CACHE_MAX = 1024;
const dnsVerdicts = new Map();

function rememberVerdict(host, ok) {
  if (dnsVerdicts.size >= DNS_CACHE_MAX) {
    dnsVerdicts.delete(dnsVerdicts.keys().next().value);
  }
  dnsVerdicts.set(host, { expires: Date.now() + DNS_TTL_MS, ok });
}

export async function assertPublicDestination(target) {
  const url = target instanceof URL ? target : new URL(String(target));
  if (isBlockedHost(url.hostname)) {
    throw new Error("That host is blocked to protect private networks.");
  }
  if (net.isIP(url.hostname)) return;

  const host = url.hostname;
  const cached = dnsVerdicts.get(host);
  if (cached && cached.expires > Date.now()) {
    if (!cached.ok) {
      throw new Error("That host resolves to a private network address.");
    }
    return;
  }

  const addresses = await dns.lookup(host, { all: true, verbatim: true });
  const ok = !addresses.some((entry) => isBlockedIp(entry.address));
  rememberVerdict(host, ok);
  if (!ok) {
    throw new Error("That host resolves to a private network address.");
  }
}
