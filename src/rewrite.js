// Server-owned document rewriting.
//
// The proxy is the single owner of rewriting: the browser only ever sees proxy
// paths, and there is no frontend to keep in sync. This module rewrites HTML
// and CSS, decodes upstream bytes using their declared charset, and injects the
// runtime shim that the server also owns.

import { proxifyReference } from "./urls.js";
import { buildShim } from "./shim.js";

const URL_ATTRS = [
  "href",
  "src",
  "action",
  "poster",
  "formaction",
  "background",
  "cite",
  "longdesc",
  "manifest",
  "usemap",
  "icon",
  "data",
  "data-src",
  "data-href",
  "data-poster",
  "data-original",
  "data-background",
  "data-url",
  "data-video",
  "data-thumb"
];

const URL_ATTR_RE = new RegExp(
  `\\s(${URL_ATTRS.join("|")})\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`,
  "gi"
);

const TARGET_RE = /\starget\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const SRCSET_RE = /\s(srcset|imagesrcset)\s*=\s*("([^"]*)"|'([^']*)')/gi;
const STYLE_ATTR_RE = /\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi;
const STYLE_BLOCK_RE = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
const INTEGRITY_RE = /\sintegrity\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const BASE_RE = /<base\b[^>]*>/gi;
const CSP_META_RE =
  /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy[^>]*>/gi;
const REFRESH_META_RE = /<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi;
const HEAD_OPEN_RE = /<head\b[^>]*>/i;

export function decodeText(buffer, contentType) {
  let charset = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || "")?.[1];
  if (!charset) {
    const head = buffer.subarray(0, 4096).toString("latin1");
    charset =
      /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ||
      /<meta[^>]+content\s*=\s*["'][^"']*charset=([\w-]+)/i.exec(head)?.[1];
  }
  return decodeWith(buffer, charset || "utf-8");
}

function decodeWith(buffer, charset) {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  }
}

export function rewriteCss(css, pageUrl) {
  let output = css.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (match, quote, value) => {
      if (/^(data:|blob:|#|about:)/i.test(value.trim())) return match;
      const rewritten = proxifyReference(value.trim(), pageUrl);
      return `url(${quote}${rewritten}${quote})`;
    }
  );

  output = output.replace(
    /(@import\s+)(['"])([^'"]+)\2/gi,
    (_match, prefix, quote, value) =>
      `${prefix}${quote}${proxifyReference(value, pageUrl)}${quote}`
  );

  return output;
}

// Inline <script> bodies routinely contain JSON/JS with attribute-looking text
// ("href=\"...\""). Rewriting inside them corrupts pages, so script *bodies*
// are masked while attributes are rewritten and restored afterwards. The
// opening tag stays visible so <script src> is still rewritten.
function maskScriptBodies(html) {
  const bodies = [];
  const masked = html.replace(
    /(<script\b[^>]*>)([\s\S]*?)(<\/script)/gi,
    (_match, open, body, close) => {
      const token = `\u0000COMPAXY_SCRIPT_${bodies.length}\u0000`;
      bodies.push(body);
      return `${open}${token}${close}`;
    }
  );
  return { masked, restore: (value) => restoreScriptBodies(value, bodies) };
}

function restoreScriptBodies(value, bodies) {
  return value.replace(/\u0000COMPAXY_SCRIPT_(\d+)\u0000/g, (_match, index) =>
    bodies[Number(index)]
  );
}

export function rewriteHtml(html, pageUrl) {
  let output = html
    .replace(CSP_META_RE, "")
    .replace(REFRESH_META_RE, (match) => rewriteRefreshMeta(match, pageUrl))
    .replace(INTEGRITY_RE, "")
    .replace(BASE_RE, (match) => rewriteBase(match, pageUrl));

  const scripts = maskScriptBodies(output);
  output = scripts.masked;

  output = output.replace(
    URL_ATTR_RE,
    (match, attr, _raw, doubleValue, singleValue, bareValue) => {
      const value = decodeEntities(doubleValue ?? singleValue ?? bareValue ?? "");
      if (/^(#|data:|blob:|javascript:|mailto:|tel:|about:)/i.test(value)) {
        return match;
      }
      return ` ${attr}="${escapeAttr(proxifyReference(value, pageUrl))}"`;
    }
  );

  // Frame busting: a link, form or <base> that targets _top or _parent would
  // navigate the whole browser tab - and, when the proxy is embedded, the host
  // page around it. Collapse those targets so the page stays in its frame.
  output = output.replace(TARGET_RE, (match, _raw, doubleValue, singleValue, bareValue) => {
    const value = doubleValue ?? singleValue ?? bareValue ?? "";
    const mapped = remapTarget(value);
    return mapped === value ? match : ` target="${escapeAttr(mapped)}"`;
  });

  output = output.replace(SRCSET_RE, (_match, attr, _raw, doubleValue, singleValue) => {
    const value = decodeEntities(doubleValue ?? singleValue ?? "");
    return ` ${attr}="${escapeAttr(rewriteSrcset(value, pageUrl))}"`;
  });

  output = output.replace(STYLE_ATTR_RE, (match, _raw, doubleValue, singleValue) => {
    const value = doubleValue ?? singleValue;
    if (value === undefined) return match;
    return ` style="${rewriteCss(value, pageUrl).replaceAll('"', "&quot;")}"`;
  });

  output = output.replace(STYLE_BLOCK_RE, (match, attrs, css) =>
    `<style${attrs}>${rewriteCss(css, pageUrl)}</style>`
  );

  return injectShim(scripts.restore(output), pageUrl);
}

/**
 * Collapse navigation targets that would escape the proxy viewport. `_top` and
 * `_parent` both resolve to the browser tab the proxied document lives in.
 */
function remapTarget(value) {
  const lower = String(value ?? "").trim().toLowerCase();
  return lower === "_top" || lower === "_parent" ? "_self" : value;
}

function decodeEntities(value) {
  return String(value)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function escapeAttr(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

// Follows the HTML spec's srcset tokenising: a URL runs until whitespace (so
// commas inside a URL, e.g. Cloudflare "q=78,scq=50,..." image paths, are
// preserved), then an optional descriptor runs until the next comma.
function rewriteSrcset(value, pageUrl) {
  const out = [];
  const input = String(value);
  let i = 0;
  while (i < input.length) {
    while (i < input.length && (input[i] === "," || /\s/.test(input[i]))) i++;
    if (i >= input.length) break;
    const start = i;
    while (i < input.length && !/\s/.test(input[i])) i++;
    let url = input.slice(start, i);
    while (url.endsWith(",")) url = url.slice(0, -1);
    const descriptorStart = i;
    while (i < input.length && input[i] !== ",") i++;
    const descriptor = input.slice(descriptorStart, i).trim();
    if (i < input.length && input[i] === ",") i++;
    if (!url) continue;
    out.push(`${proxifyReference(url, pageUrl)}${descriptor ? ` ${descriptor}` : ""}`);
  }
  return out.join(", ");
}

function rewriteBase(match, pageUrl) {
  const hrefMatch = /\shref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match);
  if (!hrefMatch) return match;
  const value = hrefMatch[2] ?? hrefMatch[3] ?? hrefMatch[4] ?? "";
  if (!value) return match;
  return `<base href="${escapeAttr(proxifyReference(value, pageUrl))}">`;
}

function rewriteRefreshMeta(match, pageUrl) {
  return match.replace(
    /content\s*=\s*("([^"]*)"|'([^']*)')/i,
    (attr, _raw, doubleValue, singleValue) => {
      const value = doubleValue ?? singleValue ?? "";
      const rewritten = value.replace(/url\s*=\s*([^;\s]+)/i, (m, url) => {
        try {
          return `url=${proxifyReference(url, pageUrl)}`;
        } catch {
          return m;
        }
      });
      return `content="${escapeAttr(rewritten)}"`;
    }
  );
}

function injectShim(html, pageUrl) {
  const shim = `<script>${buildShim(pageUrl)}</script>`;
  if (HEAD_OPEN_RE.test(html)) {
    return html.replace(HEAD_OPEN_RE, (match) => `${match}${shim}`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b[^>]*>/i, (match) => `${match}${shim}`);
  }
  return `${shim}${html}`;
}
