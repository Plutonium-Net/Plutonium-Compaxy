// Compaxy - server only.
//
// Four proxy engines share this one origin, and the routing table in sites.json
// decides which one serves which site:
//
//     base        fetch, rewrite and re-emit here          /proxy/<scheme>/<host>/<path>
//     scramjet    Scramjet v2 in a service worker          /scram/...
//     ultraviolet Ultraviolet in a service worker          /uv/service/...
//     rammerhead  Hammerhead sessions, server-side         /<session>/<url>
//
// Ask it for a site and it redirects to the engine that owns it:
//
//     http://127.0.0.1:5201/?url=https://example.com/
//
// That address is the whole interface, so the proxy drops straight into an
// iframe on any page:
//
//     <iframe src="http://127.0.0.1:5201/?url=https://example.com/"></iframe>
//
// The base engine hands the browser a path-form address that mirrors the target
// (/proxy/<scheme>/<host>/<path>). That is what keeps a rewrite-only proxy
// correct: the browser's own URL keeps the upstream site's real path, so
// relative references, forms and client-side routers resolve exactly as they do
// on the original site, and no rewrite has to guess what a URL meant. The other
// engines have their own URL formats and are entered through /go/<engine>, which
// installs the engine before navigating.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeTargetUrl,
  toProxyUrl,
  fromProxyRequest,
  PROXY_PREFIX
} from "./src/urls.js";
import { handleProxy } from "./src/proxy.js";
import { handleUpgrade } from "./src/websocket.js";
import { stats as cacheStats } from "./src/cache.js";
import {
  blockedMessageForUrl,
  blockedHostPatterns,
  blockedHostRules,
  renderBlockedPage
} from "./src/blocklist.js";
import {
  ENGINES,
  ENGINE_IDS,
  engineForUrl,
  defaultEngine,
  routingSummary,
  tableProblem
} from "./src/engines.js";
import { directoryMount } from "./src/static-files.js";
import {
  scramjetPage,
  ultravioletPage,
  rammerheadPage,
  SCRAMJET_SW,
  UV_CONFIG,
  UV_SW
} from "./src/pages.js";
import { createRammerhead, isRammerheadPath } from "./src/rammerhead.js";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";

// PORT is only honoured when it is an actual port: environments that set PORT
// to an empty string or 0 ("pick anything") must still land on the default,
// because nothing could discover the random one.
const requestedPort = Number(process.env.PORT);
const usingEnvPort =
  Number.isInteger(requestedPort) && requestedPort > 0;
const port = usingEnvPort ? requestedPort : 5201;

// Platforms such as Render inject PORT and probe 0.0.0.0 for a listening
// socket, so once a usable port comes from the environment we must bind every
// interface; a loopback-only bind is invisible to that probe and the deploy
// never finalizes. A plain local run (no usable PORT) stays on loopback.
const host =
  process.env.HOST || (usingEnvPort ? "0.0.0.0" : "127.0.0.1");
const accessLog = process.env.COMPAXY_LOG === "1";

// Wisp settings are global to the server module. These caps bound how many
// streams one browser can fan out through the transport; the default IP guards
// (private and loopback addresses refused) are deliberately left alone.
wisp.options.stream_limit_per_host = 64;
wisp.options.stream_limit_total = 512;
wisp.options.send_buffer_size = 32;

// The domain blocklist is enforced here too, and this is the important one for
// the service-worker engines: Scramjet and Ultraviolet open raw connections
// through Wisp, so refusing the destination host is what stops a blocked site
// loading through them. The engines' workers also refuse with the configured
// message; this is the backstop that does not depend on decoding their URLs.
const blockedHosts = blockedHostPatterns();
if (blockedHosts.length) {
  wisp.options.hostname_blacklist = blockedHosts;
}

function logAccess(req, res, target) {
  if (!accessLog) return;
  res.on("finish", () => console.log(`${req.method} ${res.statusCode} ${target}`));
}

function sendText(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

function sendJson(res, status, value) {
  sendText(res, status, JSON.stringify(value), "application/json; charset=utf-8");
}

// The brand artwork sits next to this file and is served by name index only, so
// no part of the request path ever reaches the filesystem. Each file is read
// once and held: the background alone is ~414 KB.
const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const ASSET_FILES = new Map([
  ["/background.png", "background.png"],
  ["/logo.png", "logo.png"],
  ["/favicon.png", "favicon.png"]
]);
const assetBodies = new Map();

// ---- engines ---------------------------------------------------------------
//
// Four engines are mounted side by side. Only the base engine lives in this
// repository; the other three are vendored from node_modules and served by
// name, so no request path ever reaches those directories directly.

const MODULES = path.join(PROJECT_ROOT, "node_modules");
const scramjetDist = path.join(MODULES, "@mercuryworkshop", "scramjet", "dist");
const controllerDist = path.join(MODULES, "@mercuryworkshop", "scramjet-controller", "dist");
const uvDist = path.join(MODULES, "@titaniumnetwork-dev", "ultraviolet", "dist");
const baremuxDist = path.join(MODULES, "@mercuryworkshop", "bare-mux", "dist");
const epoxyScramjetDist = path.join(MODULES, "@mercuryworkshop", "epoxy-transport", "dist");
const epoxyUltravioletDist = path.join(MODULES, "epoxy-uv", "dist");
const rammerheadClient = path.join(MODULES, "rammerhead", "src", "client", "rammerhead.js");

// Long-lived engine code may be cached; a worker or config that changes must be
// revalidated, because a stale service worker is worse than a slow one.
const ENGINE_CACHE = "public, max-age=3600";
const VOLATILE_CACHE = "no-cache";

const sjFiles = directoryMount(scramjetDist, {
  cacheControl: ENGINE_CACHE,
  only: new Set(["scramjet.js", "scramjet.wasm"])
});
const controllerFiles = directoryMount(controllerDist, {
  cacheControl: ENGINE_CACHE,
  only: new Set(["controller.api.js", "controller.inject.js", "controller.sw.js"])
});
const uvFiles = directoryMount(uvDist, {
  cacheControl: ENGINE_CACHE,
  only: new Set(["uv.bundle.js", "uv.client.js", "uv.handler.js", "uv.sw.js"])
});
const baremuxFiles = directoryMount(baremuxDist, {
  cacheControl: ENGINE_CACHE,
  only: new Set(["index.js", "index.mjs", "worker.js"])
});
const epoxyScramjetFiles = directoryMount(epoxyScramjetDist, {
  cacheControl: ENGINE_CACHE,
  only: new Set(["index.js", "index.mjs"])
});
const epoxyUltravioletFiles = directoryMount(epoxyUltravioletDist, {
  cacheControl: ENGINE_CACHE,
  only: new Set(["index.js", "index.mjs"])
});
const rammerheadFiles = directoryMount(path.dirname(rammerheadClient), {
  cacheControl: ENGINE_CACHE,
  only: new Set([path.basename(rammerheadClient)])
});

// Service-worker engines need SharedArrayBuffer for their Wisp transport, so
// their own surfaces are cross-origin isolated. `credentialless` (rather than
// require-corp) keeps third-party subresources and frames working, which matters
// because this proxy is meant to be embeddable.
function isolate(res) {
  res.setHeader("cross-origin-opener-policy", "same-origin");
  res.setHeader("cross-origin-embedder-policy", "credentialless");
  res.setHeader("cross-origin-resource-policy", "cross-origin");
}

// A broken Rammerhead install must not take the other three engines down.
let rammerhead = null;
let rammerheadProblem = null;
try {
  rammerhead = createRammerhead({ accessLog });
} catch (error) {
  rammerheadProblem = error.message;
  console.error(`Rammerhead is unavailable: ${error.message}`);
}

function assetBody(file) {
  if (!assetBodies.has(file)) {
    try {
      assetBodies.set(file, fs.readFileSync(path.join(PROJECT_ROOT, file)));
    } catch (error) {
      console.error(`Brand asset ${file} is missing: ${error.message}`);
      return null;
    }
  }
  return assetBodies.get(file);
}

// A blocked domain gets its configured message, not a generic error, so the
// operator can explain why the site is unavailable.
function sendBlocked(res, message) {
  sendText(res, 403, renderBlockedPage(message), "text/html; charset=utf-8");
}

// Rammerhead's session URLs carry the target after the session id:
// /<session>/https://site/<path>. Requests without an absolute address are
// subresources the session's page resolved, so the referer names the site.
function rammerheadTargetFromPath(pathname) {
  const session = /^\/[a-z0-9]{32}\/(.+)$/.exec(pathname);
  if (!session) return null;
  const match = /^https?:\/\/[^/]+/i.exec(session[1]);
  return match ? match[0] : null;
}

function rammerheadBlocked(pathname, referer) {
  const direct = rammerheadTargetFromPath(pathname);
  if (direct) return blockedMessageForUrl(direct);
  if (!referer) return null;
  try {
    const fromReferer = rammerheadTargetFromPath(new URL(referer).pathname);
    return fromReferer ? blockedMessageForUrl(fromReferer) : null;
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

// The default screen: the brand splash, then the one field this proxy exists
// for. Everything is sized in vh so the stack shrinks with the window and the
// cards always clear the wordmark baked into background.png.
function entryPage(host, routing) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Plutonium Compaxy</title>
<meta name="description" content="A server-side fetch-and-rewrite web proxy. Ask for a site with ?url= and it fetches, rewrites and serves it." />
<meta name="theme-color" content="#050508" />
<meta property="og:title" content="Plutonium Compaxy" />
<meta property="og:description" content="A server-side fetch-and-rewrite web proxy." />
<meta property="og:image" content="/background.png" />
<link rel="icon" type="image/png" href="/favicon.png" />
<link rel="apple-touch-icon" href="/favicon.png" />
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --text:   #f5f5f7;
    --muted:  #9b9ba4;
    --accent: #e8175d;
    --ok:     #3ecf8e;
    --warn:   #f5a524;
    --err:    #f2555a;
    --card:   rgba(6, 6, 10, 0.72);
    --line:   rgba(255, 255, 255, 0.10);
    --mono:   ui-monospace, "SF Mono", "Fira Code", Menlo, monospace;
  }

  html { background: #000; }

  body {
    min-height: 100%;
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }

  /* Fixed so the artwork stays put while short screens scroll; bottom-anchored
     so the brand wordmark always sits on the bottom edge, never half-cropped.
     Untinted: the image is drawn exactly as supplied. */
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: -2;
    background: #000 url("/background.png") center bottom / cover no-repeat;
  }

  .stage {
    min-height: 100svh;
    display: grid;
    align-content: safe center;
    justify-items: center;
    gap: clamp(7px, 1vh, 11px);
    /* background.png is exactly 2:1 and its Plutonium wordmark fills the lower
       third. Under cover the image is max(50vw, 100svh) tall and the artwork
       starts 34.8% of that above the bottom edge, so that band is reserved:
       the cards sit above the brand instead of on top of it. */
    padding:
      clamp(28px, 5vh, 74px)
      clamp(18px, 2vw, 28px)
      calc(max(50vw, 100svh) * 0.348 + 4px)
      clamp(18px, 2vw, 28px);
  }

  .card {
    width: min(100%, 1160px);
    padding: clamp(10px, 1.7vh, 20px) clamp(12px, 2.2vh, 24px);
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 22px;
    backdrop-filter: blur(22px) saturate(130%);
    -webkit-backdrop-filter: blur(22px) saturate(130%);
    box-shadow:
      0 30px 80px -32px rgba(0, 0, 0, 0.95),
      inset 0 1px 0 rgba(255, 255, 255, 0.06);
  }

  /* ---- 1. title ---------------------------------------------------------- */

  .card--title {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: clamp(14px, 1.8vw, 24px);
  }
  .card__mark {
    flex: none;
    width: clamp(38px, 5.4vh, 60px);
    height: auto;
    filter: drop-shadow(0 0 20px rgba(232, 23, 93, 0.3));
  }
  .card__eyebrow {
    font-family: var(--mono);
    font-size: clamp(0.76rem, 1.8vh, 0.98rem);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: rgba(232, 23, 93, 0.95);
    margin-bottom: clamp(2px, 0.7vh, 6px);
  }
  .card__title {
    font-size: clamp(1.5rem, 5.2vh, 3.2rem);
    font-weight: 650;
    letter-spacing: -0.03em;
    line-height: 1.05;
  }

  /* ---- 2. search --------------------------------------------------------- */

  .search__label {
    display: block;
    font-family: var(--mono);
    font-size: clamp(0.6rem, 1.35vh, 0.7rem);
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.34);
    margin-bottom: clamp(5px, 1vh, 9px);
  }
  .search__row { display: flex; gap: clamp(8px, 1vw, 12px); }
  .search__input {
    flex: 1 1 auto;
    min-width: 0;
    padding: clamp(9px, 1.6vh, 15px) clamp(12px, 1.2vw, 18px);
    font: inherit;
    font-size: clamp(0.84rem, 1.9vh, 1rem);
    color: var(--text);
    background: rgba(0, 0, 0, 0.45);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 14px;
    outline: none;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .search__input::placeholder { color: rgba(255, 255, 255, 0.28); }
  .search__input:focus-visible {
    border-color: rgba(232, 23, 93, 0.75);
    box-shadow: 0 0 0 4px rgba(232, 23, 93, 0.14);
  }
  .search__go {
    flex: none;
    padding: 0 clamp(16px, 2vw, 26px);
    font: inherit;
    font-size: clamp(0.84rem, 1.9vh, 1rem);
    font-weight: 600;
    color: #fff;
    cursor: pointer;
    background: linear-gradient(180deg, #ef2a6b, #cf0f4e);
    border: 0;
    border-radius: 14px;
    box-shadow: 0 12px 30px -14px rgba(232, 23, 93, 0.9);
    transition: filter 0.15s ease, transform 0.1s ease;
  }
  .search__go:hover { filter: brightness(1.08); }
  .search__go:active { transform: translateY(1px); }
  .search__go:focus-visible {
    outline: 2px solid rgba(232, 23, 93, 0.9);
    outline-offset: 3px;
  }

  /* ---- 3. status -------------------------------------------------------- */

  .status__head {
    display: flex;
    align-items: center;
    gap: 11px;
  }
  .status__dot {
    width: clamp(7px, 1.1vh, 9px);
    height: clamp(7px, 1.1vh, 9px);
    flex: none;
    border-radius: 50%;
    background: var(--warn);
    box-shadow: 0 0 0 5px rgba(245, 165, 36, 0.14);
  }
  .status__state {
    font-size: clamp(0.92rem, 2vh, 1.22rem);
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .status__latency {
    font-family: var(--mono);
    font-size: 0.76rem;
    color: var(--muted);
  }
  .status__latency:empty { display: none; }
  .status__link {
    margin-left: auto;
    font-family: var(--mono);
    font-size: 0.74rem;
    color: rgba(255, 255, 255, 0.34);
    text-decoration: none;
    transition: color 0.15s ease;
  }
  .status__link:hover,
  .status__link:focus-visible { color: var(--accent); }

  .status[data-state="ok"] .status__dot {
    background: var(--ok);
    box-shadow: 0 0 0 5px rgba(62, 207, 142, 0.16);
    animation: pulse 2.6s ease-in-out infinite;
  }
  .status[data-state="error"] .status__dot {
    background: var(--err);
    box-shadow: 0 0 0 5px rgba(242, 85, 90, 0.16);
  }

  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 5px rgba(62, 207, 142, 0.16); }
    50%      { box-shadow: 0 0 0 8px rgba(62, 207, 142, 0.05); }
  }
  @media (prefers-reduced-motion: reduce) {
    .status[data-state="ok"] .status__dot { animation: none; }
  }

  .checks {
    display: grid;
    /* One column per check, however many /healthz reports: two fill the row,
       more wrap instead of leaving a bare track. */
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 140px), 1fr));
    gap: clamp(4px, 0.9vh, 8px) 26px;
    margin-top: clamp(7px, 1.5vh, 12px);
    padding-top: clamp(7px, 1.4vh, 11px);
    border-top: 1px solid rgba(255, 255, 255, 0.07);
    list-style: none;
  }
  .checks[hidden] { display: none; }
  .checks li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    font-size: clamp(0.72rem, 1.6vh, 0.84rem);
  }
  .checks__name { color: rgba(245, 245, 247, 0.74); }
  .checks__val {
    font-family: var(--mono);
    font-size: 0.72rem;
    color: var(--muted);
    white-space: nowrap;
  }
  .checks li[data-ok="true"] .checks__val  { color: rgba(62, 207, 142, 0.92); }
  .checks li[data-ok="false"] .checks__val { color: rgba(242, 85, 90, 0.95); }

  .status__foot {
    margin-top: clamp(6px, 1.2vh, 10px);
    font-family: var(--mono);
    font-size: clamp(0.6rem, 1.25vh, 0.68rem);
    color: rgba(255, 255, 255, 0.3);
  }

  /* ---- 4. routing ------------------------------------------------------- */

  .card--routing { display: grid; gap: clamp(6px, 1.2vh, 10px); }
  .routes {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 8px;
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .routes li {
    display: flex;
    align-items: baseline;
    gap: 7px;
    padding: 4px 9px;
    font-size: clamp(0.66rem, 1.45vh, 0.76rem);
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 999px;
  }
  .routes__host { font-family: var(--mono); color: rgba(245, 245, 247, 0.8); }
  .routes__engine { color: rgba(232, 23, 93, 0.92); }

  /* ---- 5. description --------------------------------------------------- */

  .card__desc {
    max-width: 68ch;
    margin-inline: auto;
    text-align: center;
    color: var(--muted);
    font-size: clamp(0.8rem, 1.7vh, 0.96rem);
    line-height: 1.65;
  }
  .card__desc strong { color: rgba(245, 245, 247, 0.88); font-weight: 550; }

  /* Short, wide windows (a 768p laptop minus browser chrome): cover would blow
     the artwork up to nearly half the height, so scale the image by height
     instead and reserve the correspondingly smaller band. */
  @media (max-height: 700px) {
    .backdrop {
      background-size: auto 72%;
      background-position: left bottom;
    }
    .stage { padding-bottom: calc(72vh * 0.348 + 8px); }
  }

  /* Portrait phones: cover would blow the wordmark up to a third of the screen
     and crop it, so size the image by width instead and reserve 17.4vw. */
  @media (max-width: 700px) {
    .backdrop {
      background-size: 100% auto;
      background-position: left bottom;
    }
    .stage { padding-bottom: calc(50vw * 0.348 + 8px); }
    /* vh-driven type would run enormous on a tall phone, so scale by width. */
    .card__title { font-size: clamp(1.5rem, 7vw, 2.3rem); }
    .card__eyebrow { font-size: clamp(0.62rem, 2.7vw, 0.82rem); letter-spacing: 0.1em; }
    .search__row { flex-wrap: wrap; }
    .search__go { flex: 1 1 auto; min-height: 44px; }
  }

</style>
</head>
<body>
<div class="backdrop" aria-hidden="true"></div>

<main class="stage">
  <section class="card card--title">
    <img class="card__mark" src="/logo.png" alt="" width="58" height="58" />
    <div>
      <p class="card__eyebrow">${escapeHtml(host)}</p>
      <h1 class="card__title">Plutonium Compaxy</h1>
    </div>
  </section>

  <section class="card card--search">
    <form onsubmit="location.replace('/?url=' + encodeURIComponent(this.q.value)); return false">
      <label class="search__label" for="target">Proxy a site</label>
      <div class="search__row">
        <input class="search__input" id="target" name="q" type="text"
               placeholder="https://example.com" autofocus required
               autocomplete="off" spellcheck="false" />
        <button class="search__go" type="submit">Go</button>
      </div>
    </form>
  </section>

  <section class="card status" data-state="checking" role="status" aria-live="polite">
    <div class="status__head">
      <span class="status__dot" aria-hidden="true"></span>
      <span class="status__state">Checking status</span>
      <span class="status__latency"></span>
      <a class="status__link" href="/healthz">/healthz</a>
    </div>
    <ul class="checks" hidden></ul>
    <p class="status__foot">Contacting the proxy\u2026</p>
  </section>
  <noscript><style>.status { display: none; }</style></noscript>

  <section class="card card--desc">
    <p class="card__desc">
    Compaxy is a four-engine web proxy. Supply a site with
    <strong>?url=&lt;address&gt;</strong> and it picks the engine that site is
    assigned to, then serves the page through it.
    </p>
  </section>

  <section class="card card--routing">
    <p class="search__label">Routing</p>
    <ul class="routes">
${routing.rows
  .map(
    (row) =>
      `      <li><span class="routes__host">${escapeHtml(row.hosts.join(", "))}</span>` +
      `<span class="routes__engine">${escapeHtml(row.engine.label)}</span></li>`
  )
  .join("\n")}
    </ul>
    <p class="status__foot">Unlisted sites use ${escapeHtml(routing.fallback.label)} · edit sites.json${
      routing.problem ? ` · table could not be read: ${escapeHtml(routing.problem)}` : ""
    }</p>
  </section>
</main>

<script>
  (function () {
    var card    = document.querySelector('.status');
    var state   = card.querySelector('.status__state');
    var latency = card.querySelector('.status__latency');
    var list    = card.querySelector('.checks');
    var foot    = card.querySelector('.status__foot');
    var started = Date.now();

    function settle(mode, label, ms, body) {
      card.dataset.state = mode;
      state.textContent  = label;
      latency.textContent = ms ? Math.max(1, Math.round(ms)) + ' ms' : '';

      if (body && Array.isArray(body.components) && body.components.length) {
        list.innerHTML = body.components.map(function (c) {
          return '<li data-ok="' + (c.ok ? 'true' : 'false') + '">' +
                   '<span class="checks__name">' + c.name + '</span>' +
                   '<span class="checks__val">' + (c.ok ? 'ok' : 'down') + '</span>' +
                 '</li>';
        }).join('');
        list.hidden = false;
      }

      var at = new Date();
      foot.textContent = 'Checked ' + at.toISOString().slice(11, 19) + ' UTC · GET /healthz';
    }

    fetch('/healthz', { cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (res) {
        var ms = Date.now() - started;
        return res.json().catch(function () { return null; }).then(function (body) {
          if (!body) return settle('error', 'No response', ms, null);
          settle(body.status === 'ok' ? 'ok' : 'error',
                 body.status === 'ok' ? 'Operational' : 'Degraded', ms, body);
        });
      })
      .catch(function () {
        card.dataset.state = 'error';
        state.textContent  = 'Unreachable';
        latency.textContent = '';
        foot.textContent = 'No response from /healthz';
      });
  })();
</script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  try {
    // Brand artwork for the entry screen, addressed by name only.
    const assetFile = ASSET_FILES.get(requestUrl.pathname);
    if (assetFile) {
      const body = assetBody(assetFile);
      if (!body) return sendText(res, 500, "Brand asset unavailable.\n");
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": body.length,
        "cache-control": "public, max-age=86400"
      });
      return res.end(body);
    }

    // What the entry screen's status card asks: the proxy answering this very
    // request, and the response cache still inside its budget.
    if (requestUrl.pathname === "/healthz") {
      const cache = cacheStats();
      return sendJson(res, 200, {
        status: "ok",
        uptime: Math.round(process.uptime()),
        components: [
          { name: "proxy", ok: true },
          { name: "cache", ok: cache.bytes <= cache.budget },
          { name: "rammerhead", ok: Boolean(rammerhead) }
        ],
        engines: ENGINE_IDS,
        defaultEngine: defaultEngine().id,
        cache
      });
    }

    // The engine service workers fetch this to refuse a blocked site with the
    // configured message rather than a transport error.
    if (requestUrl.pathname === "/blocked-hosts.json") {
      return sendJson(res, 200, blockedHostRules());
    }

    // ---- engine surfaces ---------------------------------------------------

    const sendScript = (body) => {
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": VOLATILE_CACHE
      });
      res.end(body);
    };

    // Worker and config scripts are generated here so their prefixes always
    // match the routes this server actually serves.
    if (requestUrl.pathname === "/scram/sw.js") {
      isolate(res);
      return sendScript(SCRAMJET_SW);
    }
    if (requestUrl.pathname === "/uv/sw.js") {
      isolate(res);
      return sendScript(UV_SW);
    }
    if (requestUrl.pathname === "/uv/uv.config.js") {
      isolate(res);
      return sendScript(UV_CONFIG);
    }

    if (requestUrl.pathname === "/scram/") {
      isolate(res);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      });
      return res.end(scramjetPage());
    }

    // A request arriving under an engine's prefix means that engine's worker was
    // not in control of it. Send the visitor back through the bootstrapper
    // instead of guessing what the engine's URL format means.
    if (requestUrl.pathname.startsWith(ENGINES.scramjet.route)) {
      const encoded = requestUrl.pathname.slice(ENGINES.scramjet.route.length);
      res.writeHead(302, {
        location: `/go/scramjet#${encoded}`,
        "cache-control": "no-store"
      });
      return res.end();
    }

    // Same contract for Ultraviolet: its encoded path cannot be decoded here
    // (the codec lives in its client bundle), so say what happened instead of
    // answering a bare 404.
    if (requestUrl.pathname.startsWith(ENGINES.ultraviolet.route)) {
      return sendText(
        res,
        404,
        "Ultraviolet is not controlling this request. Open the site again from /.\n"
      );
    }

    const bootstrappers = new Map([
      ["/go/scramjet", scramjetPage],
      ["/go/ultraviolet", ultravioletPage],
      ["/go/rammerhead", rammerheadPage]
    ]);
    const bootstrapper = bootstrappers.get(requestUrl.pathname);
    if (bootstrapper) {
      // The entry point already refuses a blocked site, but a bootstrapper is
      // reachable directly, so it checks too.
      const requested = requestUrl.searchParams.get("url");
      const message = requested ? blockedMessageForUrl(requested) : null;
      if (message) return sendBlocked(res, message);

      isolate(res);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      });
      return res.end(bootstrapper());
    }

    // Vendored engine code, addressed by prefix and served by name only.
    const engineMounts = [
      ["/sj/", [sjFiles, controllerFiles]],
      ["/uv/", [uvFiles]],
      ["/baremux/", [baremuxFiles]],
      ["/epoxy/", [epoxyUltravioletFiles]],
      ["/epoxy3/", [epoxyScramjetFiles]]
    ];
    for (const [prefix, mounts] of engineMounts) {
      if (!requestUrl.pathname.startsWith(prefix)) continue;
      isolate(res);
      const rest = requestUrl.pathname.slice(prefix.length);
      for (const mount of mounts) {
        if (mount(req, res, rest)) return;
      }
      return sendText(res, 404, "No such engine file.\n");
    }

    // Rammerhead's own client script, which its rewritten pages ask for.
    if (requestUrl.pathname === "/rammerhead.js") {
      if (!rammerhead) {
        return sendText(res, 501, `Rammerhead is unavailable: ${rammerheadProblem}\n`);
      }
      if (rammerheadFiles(req, res, "rammerhead.js")) return;
    }

    // Rammerhead keeps its client routes and session URLs at the root of the
    // origin, so it is mounted here behind a path guard rather than under a
    // prefix its scripts do not use.
    if (isRammerheadPath(requestUrl.pathname)) {
      if (!rammerhead) {
        return sendText(res, 501, `Rammerhead is unavailable: ${rammerheadProblem}\n`);
      }
      // Rammerhead fetches upstream itself, so its pages and subresources need
      // the same gate as the base engine.
      const blocked = rammerheadBlocked(
        requestUrl.pathname,
        req.headers.referer
      );
      if (blocked) return sendBlocked(res, blocked);

      logAccess(req, res, requestUrl.pathname);
      rammerhead.handle(req, res);
      return;
    }

    if (requestUrl.pathname.startsWith("/wisp/")) {
      return sendText(res, 426, "Wisp is a WebSocket endpoint; upgrade to connect.\n");
    }

    // Entry point: /?url=<address>. Resolve it, then serve the site from its
    // own mirrored path so the browser's URL stays meaningful.
    if (requestUrl.pathname === "/") {
      if (!requestUrl.search) {
        return sendText(
          res,
          200,
          entryPage(requestUrl.host, {
            rows: routingSummary(),
            fallback: defaultEngine(),
            problem: tableProblem()
          }),
          "text/html; charset=utf-8"
        );
      }
      const raw = requestUrl.searchParams.get("url");
      if (raw === null) {
        return sendText(res, 400, "Missing ?url=<address>.\n");
      }
      let target;
      try {
        target = normalizeTargetUrl(raw);
      } catch (error) {
        return sendText(res, 400, `Cannot proxy that: ${error.message}\n`);
      }
      const blocked = blockedMessageForUrl(target);
      if (blocked) {
        return sendBlocked(res, blocked);
      }

      // The routing table decides, once, which engine serves this site. There is
      // no fallback: a site that does not work on its engine is a table edit.
      const { engine } = engineForUrl(target);
      let location;
      if (engine.id === "base") {
        location = toProxyUrl(target);
      } else if (engine.id === "rammerhead") {
        location = `/go/rammerhead?url=${encodeURIComponent(target)}`;
      } else if (engine.id === "ultraviolet") {
        location = `/go/ultraviolet?url=${encodeURIComponent(target)}`;
      } else {
        // The target travels in the query so the bootstrapper's own request can
        // be checked against the blocklist before the engine starts.
        location = `/go/scramjet?url=${encodeURIComponent(target)}`;
      }
      res.writeHead(302, { location, "cache-control": "no-store" });
      return res.end();
    }

    if (requestUrl.pathname.startsWith(PROXY_PREFIX)) {
      let target;
      try {
        target = fromProxyRequest(requestUrl.pathname, requestUrl.search);
      } catch (error) {
        return sendText(res, 400, error.message);
      }
      logAccess(req, res, target);
      await handleProxy(req, res, target);
      return;
    }

    sendText(res, 404, "Not found. Use /?url=<address> to proxy a site.\n");  } catch (error) {
    if (!res.headersSent) {
      sendText(res, 500, `Server error: ${error.message}\n`);
    } else {
      res.destroy();
    }
  }
});

server.on("upgrade", (req, socket, head) => {
  // An upgrade hijacks this socket out of Node's HTTP machinery, so nothing
  // else is listening for its errors. A client that drops mid-handshake must
  // end its own connection only - never the process that serves every tab.
  socket.on("error", () => socket.destroy());

  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  // Wisp: one endpoint per service-worker engine, both backed by the one Wisp
  // server. A Wisp connection is a raw byte stream to a host and port, so the
  // transport's own guards (no private or loopback addresses) stay on.
  if (requestUrl.pathname.startsWith("/wisp/")) {
    try {
      wisp.routeRequest(req, socket, head);
    } catch {
      socket.destroy();
    }
    return;
  }

  // Rammerhead carries its proxied WebSockets down the same root paths as its
  // pages, so the guard is the same one the request router uses.
  if (isRammerheadPath(requestUrl.pathname)) {
    if (!rammerhead) {
      socket.destroy();
      return;
    }
    // A raw upgrade has no body to explain itself, so a blocked destination is
    // simply refused and the page sees its socket close.
    if (rammerheadBlocked(requestUrl.pathname, req.headers.referer)) {
      socket.destroy();
      return;
    }
    try {
      rammerhead.handleUpgrade(req, socket, head);
    } catch {
      socket.destroy();
    }
    return;
  }

  if (!requestUrl.pathname.startsWith(PROXY_PREFIX)) {
    socket.destroy();
    return;
  }
  let target;
  try {
    target = fromProxyRequest(requestUrl.pathname, requestUrl.search);
  } catch {
    socket.destroy();
    return;
  }
  logAccess(req, { on() {} }, target);
  handleUpgrade(req, socket, head, target).catch(() => socket.destroy());
});

server.on("error", (error) => {
  console.error(`Server failed to start: ${error.message}`);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`Compaxy running at http://${host}:${port}`);
  console.log(`Embed it:  <iframe src="http://${host}:${port}/?url=https://example.com/"></iframe>`);
});
