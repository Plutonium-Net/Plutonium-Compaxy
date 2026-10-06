// Conformance check for a running Compaxy instance.
//
// For every site in SITES it does what a browser would do:
//
//   1. GET /?url=<site>            (the entry point) and follow the redirect
//      chain to the mirrored /proxy/<scheme>/<host>/<path> address;
//   2. read the final document, confirm it was rewritten (the injected shim is
//      present) and that it is not a bot challenge or an error page;
//   3. pull the rewritten subresource URLs out of that document and fetch a
//      sample of them, checking status and that the content type matches the
//      file extension.
//
// Usage:
//
//   npm start &                                  # or: PORT=... npm start
//   BASE=http://127.0.0.1:5221 node tools/check-sites.js
//   node tools/check-sites.js --json             # machine-readable stdout

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.BASE || "http://127.0.0.1:5201";
const SITES = [
  { id: "youtube", name: "YouTube", url: "https://www.youtube.com/" },
  { id: "twitch", name: "Twitch", url: "https://www.twitch.tv/" },
  { id: "netflix", name: "Netflix", url: "https://www.netflix.com/" },
  { id: "disneyplus", name: "Disney+", url: "https://www.disneyplus.com/" },
  { id: "spotify", name: "Spotify", url: "https://open.spotify.com/" },
  { id: "applemusic", name: "Apple Music", url: "https://music.apple.com/" },
  { id: "soundcloud", name: "SoundCloud", url: "https://soundcloud.com/" },
  { id: "discord", name: "Discord", url: "https://discord.com/app" },
  { id: "reddit", name: "Reddit", url: "https://www.reddit.com/" },
  { id: "x", name: "X", url: "https://x.com/" },
  { id: "instagram", name: "Instagram", url: "https://www.instagram.com/" },
  { id: "tiktok", name: "TikTok", url: "https://www.tiktok.com/" },
  { id: "pinterest", name: "Pinterest", url: "https://www.pinterest.com/" },
  { id: "github", name: "GitHub", url: "https://github.com/" },
  { id: "roblox", name: "Roblox", url: "https://www.roblox.com/" },
  { id: "google", name: "Google", url: "https://www.google.com/" },
  { id: "duckduckgo", name: "DuckDuckGo", url: "https://duckduckgo.com/" },
  { id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/" },
  { id: "duckai", name: "Duck.ai", url: "https://duck.ai/" },
  { id: "claude", name: "Claude", url: "https://claude.ai/" },
  { id: "wikipedia", name: "Wikipedia", url: "https://www.wikipedia.org/" },
  { id: "steam", name: "Steam", url: "https://store.steampowered.com/" },
  { id: "gforcenow", name: "GeForce NOW", url: "https://play.geforcenow.com/" }
];

// What a real browser tab sends. Some sites answer a bare request (no Accept,
// no Accept-Language) with a bot wall or a 403 while serving the same URL
// normally to a browser, so the check has to look like the browser it stands in
// for or it reports failures no user would ever see.
const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9"
};

const DOC_TIMEOUT_MS = 30_000;
const ASSET_TIMEOUT_MS = 20_000;
const MAX_HOPS = 6;
const MAX_ASSETS = 8;
const SITE_CONCURRENCY = 4;

// Signatures of pages that render "fine" but are not the site: interstitial bot
// walls, captcha gates and the like. A 200 alone is not proof of anything.
const CHALLENGES = [
  [/just a moment/i, "Cloudflare JS challenge"],
  [/cf-chl-|__cf_chl|cdn-cgi\/challenge/i, "Cloudflare challenge"],
  [/attention required.*cloudflare/i, "Cloudflare block"],
  [/enable javascript and cookies to continue/i, "Cloudflare cookies/JS wall"],
  [/\/sorry\/index|id="captcha-form"/i, "Google bot challenge (/sorry/index)"],
  [/unusual traffic from your computer/i, "Google rate-limit page"],
  [/g-recaptcha|hcaptcha|recaptcha\/api/i, "captcha gate"],
  [/<title>\s*access denied/i, "access denied"],
  [/<title>\s*403 forbidden/i, "403 page"],
  [/request blocked/i, "request blocked"]
];

const EXPECTED_TYPE = [
  [/\.m?js(\?|$)/i, /javascript/i],
  [/\.css(\?|$)/i, /text\/css/i],
  [/\.(png|jpe?g|gif|webp|avif)(\?|$)/i, /^image\//i],
  [/\.svg(\?|$)/i, /svg/],
  [/\.woff2?(\?|$)/i, /font|woff/i]
];

async function timedFetch(url, options = {}, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Follow the entry point and any proxy-side redirects to the final document. */
async function loadDocument(target) {
  const hops = [];
  let current = `${BASE}/?url=${encodeURIComponent(target)}`;

  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const res = await timedFetch(
      current,
      { redirect: "manual", headers: BROWSER_HEADERS },
      DOC_TIMEOUT_MS
    );
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      hops.push({ url: current, status: res.status, location });
      current = new URL(location, current).href;
      continue;
    }
    return { res, finalUrl: current, hops };
  }
  throw new Error(`too many redirects (>${MAX_HOPS})`);
}

/**
 * Load a document, retrying once on an error status. Bot walls and rate limits
 * are often momentary upstream, and a single bare HTTP request is exactly the
 * shape they reject while a browser session sails through.
 */
async function loadDocumentWithRetry(target) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const loaded = await loadDocument(target);
      if (loaded.res.status < 400) return loaded;
      last = loaded;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  if (last instanceof Error) throw last;
  return last;
}

function extractAssetPaths(html) {
  const found = new Set();
  // Mirrored paths are /proxy/<scheme>/<host>/<path>: slash-separated, with no
  // colon after the scheme.
  for (const match of html.matchAll(/\/proxy\/[a-z]+\/[^\s"'`<>)\\]+/gi)) {
    const value = match[0];
    if (value.startsWith("/proxy/")) found.add(value);
  }
  return [...found];
}

async function checkAsset(assetPath, docHref) {
  const url = new URL(assetPath, docHref).href;
  const res = await timedFetch(
    url,
    { redirect: "manual", headers: BROWSER_HEADERS },
    ASSET_TIMEOUT_MS
  );
  const contentType = res.headers.get("content-type") || "";
  try {
    await res.arrayBuffer();
  } catch {
    /* body not needed */
  }
  if (res.status >= 400) {
    return { url: assetPath, ok: false, why: `HTTP ${res.status}` };
  }
  // A CDN that labels a font or image "binary/octet-stream" is not a failure:
  // browsers sniff those happily. Only a type that positively contradicts the
  // extension (an error page served as .js, say) is worth reporting.
  const genericType = !contentType || /application\/octet-stream|binary\//i.test(contentType);
  for (const [ext, expected] of EXPECTED_TYPE) {
    if (ext.test(assetPath) && !genericType && !expected.test(contentType)) {
      return {
        url: assetPath,
        ok: false,
        why: `wrong type for extension (${contentType || "none"})`
      };
    }
  }
  return { url: assetPath, ok: true, why: `${res.status} ${contentType}` };
}

async function checkSite(site) {
  const result = {
    id: site.id,
    name: site.name,
    target: site.url,
    verdict: "unknown",
    document: null,
    assets: { tried: 0, ok: 0, failures: [] },
    note: ""
  };

  try {
    const { res, finalUrl, hops } = await loadDocumentWithRetry(site.url);
    const contentType = res.headers.get("content-type") || "";
    result.document = {
      status: res.status,
      contentType,
      finalUrl,
      redirects: hops.length
    };

    if (res.status >= 400) {
      result.verdict = "error";
      result.note = `entry document returned HTTP ${res.status}`;
      return result;
    }
    if (!/text\/html|application\/xhtml/i.test(contentType)) {
      result.verdict = "error";
      result.note = `root returned ${contentType || "no content type"}`;
      return result;
    }

    const html = await res.text();
    result.document.bytes = Buffer.byteLength(html);
    result.document.rewritten = html.includes("__compaxyShim");

    for (const [pattern, label] of CHALLENGES) {
      if (pattern.test(html)) {
        result.verdict = "challenge";
        result.note =
          `${label} - a real browser may still clear this, since the challenge ` +
          `is solved by JavaScript that only the browser runs`;
        return result;
      }
    }

    if (!result.document.rewritten) {
      result.verdict = "error";
      result.note = "document was served without the proxy rewriting it";
      return result;
    }

    // Prefer a sample whose extension lets us verify the content type, so a
    // 200 that is really an error page cannot pass as a working asset.
    const candidates = extractAssetPaths(html);
    const typeCheckable = candidates.filter((a) => EXPECTED_TYPE.some(([ext]) => ext.test(a)));
    const rest = candidates.filter((a) => !typeCheckable.includes(a));
    const assets = [...typeCheckable, ...rest].slice(0, MAX_ASSETS);
    result.assets.tried = assets.length;
    const checked = await Promise.all(assets.map((a) => checkAsset(a, finalUrl)));
    for (const asset of checked) {
      if (asset.ok) result.assets.ok++;
      else result.assets.failures.push(asset);
    }

    if (assets.length === 0) {
      result.verdict = "ok";
      result.note =
        "document rewritten; no subresources in the markup (a JS-built page " +
        "still fetches them at runtime)";
    } else if (result.assets.failures.length === 0) {
      result.verdict = "ok";
    } else {
      result.verdict = "partial";
      result.note = `${result.assets.failures.length}/${assets.length} sampled assets failed`;
    }
  } catch (error) {
    result.verdict = "error";
    result.note = error.name === "AbortError" ? "timed out" : error.message;
  }
  return result;
}

async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

function renderTable(results) {
  const order = { challenge: 0, error: 1, partial: 2, ok: 3, unknown: 4 };
  const rows = [...results].sort((a, b) => order[a.verdict] - order[b.verdict]);
  const lines = [];
  lines.push("site          verdict  doc      rewritten  assets     note");
  lines.push("-".repeat(78));
  for (const r of rows) {
    const doc = r.document ? String(r.document.status) : "-";
    const rewritten = r.document ? (r.document.rewritten ? "yes" : "no") : "-";
    const assets = r.assets.tried
      ? `${r.assets.ok}/${r.assets.tried}`
      : "-";
    lines.push(
      [
        r.name.padEnd(13),
        r.verdict.padEnd(8),
        doc.padEnd(8),
        rewritten.padEnd(10),
        assets.padEnd(10),
        r.note
      ].join(" ")
    );
  }
  return lines.join("\n");
}

function renderReport(results) {
  const stamp = new Date().toISOString();
  const counts = results.reduce((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] || 0) + 1;
    return acc;
  }, {});
  const out = [];
  out.push("# Compaxy site conformance check");
  out.push("");
  out.push(`Base: \`${BASE}\`  `);
  out.push(`Run: ${stamp}`);
  out.push("");
  out.push(
    `Verdicts: ` +
      Object.entries(counts)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ")
  );
  out.push("");
  out.push("```text");
  out.push(renderTable(results));
  out.push("```");
  out.push("");
  for (const r of results) {
    out.push(`## ${r.name} — ${r.verdict}`);
    out.push("");
    out.push(`- target: ${r.target}`);
    if (r.document) {
      out.push(
        `- document: HTTP ${r.document.status}, ${
          r.document.contentType || "no content type"
        }, ${r.document.bytes ?? "?"} bytes, ${r.document.redirects} redirect hop(s)`
      );
      out.push(`- mirrored at: \`${r.document.finalUrl}\``);
    }
    if (r.note) out.push(`- note: ${r.note}`);
    if (r.assets.failures.length) {
      out.push(`- failed assets:`);
      for (const f of r.assets.failures.slice(0, 8)) {
        out.push(`  - \`${f.url}\` — ${f.why}`);
      }
    }
    out.push("");
  }
  return out.join("\n");
}

const results = await mapWithLimit(SITES, SITE_CONCURRENCY, checkSite);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log(renderTable(results));
}

const reportPath = path.join("reports", "compaxy-sites.md");
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, renderReport(results) + "\n");
console.log(`\nFull report: ${reportPath}`);
