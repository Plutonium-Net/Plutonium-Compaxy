// Domain blocklist.
//
// Each entry names one or more domains and the message the proxy shows when a
// request tries to reach them. Edit BLOCKLIST below, or point COMPAXY_BLOCKLIST
// at a JSON file with the same shape (an array of { domains, message }).
//
// Matching rules:
//
//   "example.com"    blocks example.com and every subdomain (www.example.com)
//   "*.example.com"  blocks subdomains only, not example.com itself
//
// A bare domain never matches a different domain that merely ends in the same
// letters: "notexample.com" is not a subdomain of "example.com".
//
// The message is rendered as plain text inside the block page, so it does not
// need escaping and cannot inject markup.

import fs from "node:fs";

// Reserved TLDs (.example) are used as placeholders so the feature is visible
// and testable without ever blocking a real site. Replace these with your own.

/**
 * Build the matcher list once: { name, subdomainsOnly, message }.
 * Entries without a usable domain or message are ignored.
 */
function compile(entries) {
  const matchers = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const message = String(entry.message ?? "").trim();
    if (!message) continue;
    for (const value of entry.domains ?? []) {
      const raw = String(value).trim().toLowerCase().replace(/\.+$/, "");
      if (!raw) continue;
      const subdomainsOnly = raw.startsWith("*.");
      const name = subdomainsOnly ? raw.slice(2) : raw;
      if (!name || !name.includes(".")) continue;
      matchers.push({ name, subdomainsOnly, message });
    }
  }
  return matchers;
}

// Optional override: a JSON file whose path is in COMPAXY_BLOCKLIST. A broken
// or missing file is reported and the built-in list is used instead, so a bad
// config can never take the whole proxy down.
function loadEntries() {
  const file = process.env.COMPAXY_BLOCKLIST;
  if (!file) return BLOCKLIST;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(parsed)) return parsed;
    console.error(`Blocklist ${file} must be a JSON array; ignoring it.`);
  } catch (error) {
    console.error(`Could not read blocklist ${file}: ${error.message}`);
  }
  return BLOCKLIST;
}

const matchers = compile(loadEntries());

function matches(host, matcher) {
  if (host === matcher.name) return !matcher.subdomainsOnly;
  return host.endsWith(`.${matcher.name}`);
}

/**
 * The message configured for a blocked hostname, or null when it is allowed.
 */
export function blockedMessage(hostname) {
  const host = String(hostname ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "")
    .replace(/:\d+$/, "");
  if (!host) return null;
  for (const matcher of matchers) {
    if (matches(host, matcher)) return matcher.message;
  }
  return null;
}

/**
 * The message for a target URL (or URL string), or null when it is allowed.
 */
export function blockedMessageForUrl(target) {
  let url;
  try {
    url = target instanceof URL ? target : new URL(String(target));
  } catch {
    return null;
  }
  return blockedMessage(url.hostname);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * The page shown when a blocked domain is requested. The configured message is
 * the body; the wrapper just gives it a readable frame.
 */
export function renderBlockedPage(message) {
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blocked</title>
<main style="font-family:system-ui;padding:32px;line-height:1.5;max-width:60ch">
  <h1>Blocked</h1>
  <p>${escapeHtml(message)}</p>
</main>`;
}
