// Pages that are not proxied content: the engine bootstrappers.
//
// A service-worker engine cannot be entered by a plain redirect into its prefix:
// the worker has to be installed and controlling before the navigation happens,
// or the first request reaches this server, which does not speak that engine's
// URL format. So every engine gets a small page here that prepares the engine
// and then navigates into its route.

/** Shared look for the bootstrapper screens. */
function shell(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<link rel="icon" type="image/png" href="/favicon.png" />
<style>
  html, body { margin: 0; height: 100%; background: #050508; color: #f5f5f7;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  body { display: grid; place-items: center; }
  .boot { max-width: 46ch; padding: 24px 28px; text-align: center; line-height: 1.6; }
  .boot h1 { font-size: 1.05rem; font-weight: 600; margin: 0 0 6px; }
  .boot p { margin: 0; color: #9b9ba4; font-size: 0.9rem; }
  .boot pre { margin: 14px 0 0; padding: 12px; text-align: left; white-space: pre-wrap;
    font-size: 0.78rem; color: #f2555a; background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; }
  .boot[hidden] { display: none; }
  iframe { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; background: #050508; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

/**
 * Scramjet v2 host page.
 *
 * Scramjet v2's controller drives a frame rather than a top-level navigation, so
 * this page is a full-viewport frame plus the controller that owns it. The
 * target arrives in the hash, which keeps it client-side and out of this page's
 * own request.
 */
export function scramjetPage() {
  return shell(
    "Compaxy · Scramjet v2",
    `<iframe id="frame" allow="clipboard-read; clipboard-write; fullscreen; autoplay; encrypted-media"></iframe>
<div class="boot" id="boot">
  <h1>Starting Scramjet v2</h1>
  <p>Installing the service worker and opening the Wisp transport…</p>
  <pre id="error" hidden></pre>
</div>
<script src="/sj/scramjet.js"></script>
<script src="/sj/controller.api.js"></script>
<script>
// The server-side engine serves a site at a path that mirrors the site's own
// path; this is src/urls.js's toProxyUrl, written for the browser.
function baseProxyUrl(target) {
  var url = new URL(target);
  return '/proxy/' + url.protocol.slice(0, -1) + '/' + url.host + url.pathname + url.search;
}

// navigator.serviceWorker.ready resolves against the current page's scope, and
// these bootstrapper pages deliberately sit outside the worker's scope, so wait
// on the registration's own worker instead.
function whenActivated(registration) {
  var worker = registration.installing || registration.waiting || registration.active;
  if (!worker) return Promise.reject(new Error('The service worker did not install.'));
  if (worker.state === 'activated') return Promise.resolve(worker);
  return new Promise(function (resolve, reject) {
    worker.addEventListener('statechange', function () {
      if (worker.state === 'activated') resolve(worker);
      if (worker.state === 'redundant') reject(new Error('The service worker was discarded.'));
    });
  });
}

(async function () {
  var boot = document.getElementById('boot');
  var errorBox = document.getElementById('error');
  function fail(message) {
    boot.hidden = false;
    boot.querySelector('h1').textContent = 'Scramjet could not start';
    errorBox.hidden = false;
    errorBox.textContent = message;
  }

  try {
    var target = new URLSearchParams(location.search).get('url') ||
      decodeURIComponent(location.hash.slice(1) || '');
    if (!target) throw new Error('No target site was given.');
    // The Wisp transport needs SharedArrayBuffer, which only a cross-origin
    // isolated document has. A frame is never isolated (see src/embed.js), so
    // serve the site from the engine that works there instead of showing a boot
    // error the frame could never get past.
    if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
      location.replace(baseProxyUrl(target));
      return;
    }
    if (!('serviceWorker' in navigator)) {
      throw new Error(
        'Service workers need https or localhost; this page is not on an origin that allows them.'
      );
    }

    var EpoxyTransport = (await import('/epoxy3/index.mjs')).default;
    var socket = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/wisp/scram/';
    var transport = new EpoxyTransport({ wisp: socket });

    var registration = await navigator.serviceWorker.register('/scram/sw.js', { scope: '/scram/' });
    var worker = await whenActivated(registration);

    var controller = new $scramjetController.Controller({
      serviceworker: worker,
      transport: transport,
      config: {
        prefix: '/scram/',
        scramjetPath: '/sj/scramjet.js',
        injectPath: '/sj/controller.inject.js',
        wasmPath: '/sj/scramjet.wasm'
      }
    });
    await controller.wait();

    var frame = controller.createFrame(document.getElementById('frame'));
    frame.go(target);
    boot.hidden = true;
  } catch (error) {
    console.error(error);
    fail(error && error.message ? error.message : String(error));
  }
})();
</script>`
  );
}

/**
 * The service-worker blocklist. Both worker engines share it: the rule list is
 * fetched once from the proxy, and the matching rules are the same ones
 * src/blocklist.js applies on the server.
 */
const SW_BLOCKLIST = `
var blockRules = null;

async function loadBlockRules() {
  if (blockRules) return blockRules;
  try {
    var response = await fetch('/blocked-hosts.json', { cache: 'no-store' });
    blockRules = response.ok ? await response.json() : [];
  } catch (error) {
    blockRules = [];
  }
  return blockRules;
}

function blockedMessageFor(hostname, rules) {
  var host = String(hostname || '').toLowerCase().replace(/\\.+$/, '');
  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    if (host === rule.name) {
      if (!rule.subdomainsOnly) return rule.message;
    } else if (host.endsWith('.' + rule.name)) {
      return rule.message;
    }
  }
  return null;
}

function blockedPage(message) {
  return '<!doctype html><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Blocked</title>' +
    '<main style="font-family:system-ui;padding:32px;line-height:1.5;max-width:60ch">' +
    '<h1>Blocked</h1><p>' + String(message).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    }) + '</p></main>';
}

function blockedResponse(message) {
  return new Response(blockedPage(message), {
    status: 403,
    headers: { 'content-type': 'text/html; charset=utf-8' }
  });
}

/** Find the target address inside an engine URL, or null. */
function targetOf(encoded) {
  if (!encoded) return null;
  var parts = encoded.split('/');
  for (var i = 0; i < parts.length; i++) {
    var value = parts[i];
    try { value = decodeURIComponent(value); } catch (error) { continue; }
    if (/^https?:\\/\\//i.test(value)) return value;
  }
  return null;
}
`;

/** The Scramjet service worker itself. */
export const SCRAMJET_SW = `/* Compaxy - Scramjet v2 service worker. */
importScripts("/sj/controller.sw.js");
${SW_BLOCKLIST}
self.addEventListener("fetch", (event) => {
  if (!$scramjetController.shouldRoute(event)) return;

  event.respondWith((async () => {
    // Scramjet encodes the target address into the frame's path, so a document
    // request can be refused with the configured message before it is fetched.
    var target = targetOf(new URL(event.request.url).pathname.slice('/scram/'.length));
    if (target) {
      var message = blockedMessageFor(new URL(target).hostname, await loadBlockRules());
      if (message) return blockedResponse(message);
    }
    return $scramjetController.route(event);
  })());
});
`;

/**
 * Ultraviolet bootstrapper.
 *
 * Ultraviolet is entered by a top-level navigation after its worker is in
 * control, so this page installs the worker, points bare-mux at the Wisp
 * transport, and only then replaces itself with the proxied address.
 */
export function ultravioletPage() {
  return shell(
    "Compaxy · Ultraviolet",
    `<div class="boot" id="boot">
  <h1>Starting Ultraviolet</h1>
  <p>Installing the service worker and opening the Wisp transport…</p>
  <pre id="error" hidden></pre>
</div>
<script src="/uv/uv.bundle.js"></script>
<script src="/uv/uv.config.js"></script>
<script src="/baremux/index.js"></script>
<script>
// See the Scramjet page: this page is outside the worker's scope, so the ready
// promise would never resolve here.
function whenActivated(registration) {
  var worker = registration.installing || registration.waiting || registration.active;
  if (!worker) return Promise.reject(new Error('The service worker did not install.'));
  if (worker.state === 'activated') return Promise.resolve(worker);
  return new Promise(function (resolve, reject) {
    worker.addEventListener('statechange', function () {
      if (worker.state === 'activated') resolve(worker);
      if (worker.state === 'redundant') reject(new Error('The service worker was discarded.'));
    });
  });
}

(async function () {
  var boot = document.getElementById('boot');
  var errorBox = document.getElementById('error');
  function fail(message) {
    boot.querySelector('h1').textContent = 'Ultraviolet could not start';
    errorBox.hidden = false;
    errorBox.textContent = message;
  }

  try {
    var target = new URLSearchParams(location.search).get('url');
    if (!target) throw new Error('No target site was given.');
    // See the Scramjet page: SharedArrayBuffer needs an isolated document, and a
    // frame is never isolated, so serve the site from the server-side engine.
    if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
      var url = new URL(target);
      location.replace('/proxy/' + url.protocol.slice(0, -1) + '/' + url.host + url.pathname + url.search);
      return;
    }
    if (!('serviceWorker' in navigator)) {
      throw new Error(
        'Service workers need https or localhost; this page is not on an origin that allows them.'
      );
    }

    var socket = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/wisp/uv/';
    var connection = new BareMux.BareMuxConnection('/baremux/worker.js');
    await connection.setTransport('/epoxy/index.mjs', [{ wisp: socket }]);

    var registration = await navigator.serviceWorker.register('/uv/sw.js', { scope: '/uv/' });
    await whenActivated(registration);

    location.replace(__uv$config.prefix + __uv$config.encodeUrl(target));
  } catch (error) {
    console.error(error);
    fail(error && error.message ? error.message : String(error));
  }
})();
</script>`
  );
}

/** Ultraviolet's runtime config, served at /uv/uv.config.js. */
export const UV_CONFIG = `/* Compaxy - Ultraviolet config. */
self.__uv$config = {
  prefix: '/uv/service/',
  encodeUrl: Ultraviolet.codec.xor.encode,
  decodeUrl: Ultraviolet.codec.xor.decode,
  handler: '/uv/uv.handler.js',
  client: '/uv/uv.client.js',
  bundle: '/uv/uv.bundle.js',
  config: '/uv/uv.config.js',
  sw: '/uv/uv.sw.js'
};
`;

/**
 * Ultraviolet's service worker.
 *
 * The stock worker is wrapped so proxied documents carry the cross-origin
 * isolation headers the Wisp transport needs for SharedArrayBuffer. `credentialless`
 * keeps third-party subresources and frames loading, which `require-corp` would
 * block - this proxy has to stay embeddable.
 */
export const UV_SW = `/* Compaxy - Ultraviolet service worker. */
importScripts('/uv/uv.bundle.js');
importScripts('/uv/uv.config.js');
importScripts(__uv$config.sw);
${SW_BLOCKLIST}
const uv = new UVServiceWorker();

async function handle(event) {
  if (!uv.route(event)) return fetch(event.request);

  // Ultraviolet's own codec decodes the target, so a blocked domain can be
  // answered with the configured message before any connection is made.
  var blocked = null;
  try {
    var encoded = new URL(event.request.url).pathname.slice(__uv$config.prefix.length);
    var target = __uv$config.decodeUrl(decodeURIComponent(encoded));
    if (/^https?:\\/\\//i.test(target)) {
      blocked = blockedMessageFor(new URL(target).hostname, await loadBlockRules());
    }
  } catch (error) {
    blocked = null;
  }
  if (blocked) return blockedResponse(blocked);

  const response = await uv.fetch(event);
  const headers = new Headers(response.headers);
  headers.set('cross-origin-opener-policy', 'same-origin');
  headers.set('cross-origin-embedder-policy', 'credentialless');
  headers.set('cross-origin-resource-policy', 'cross-origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

self.addEventListener('fetch', (event) => {
  event.respondWith(handle(event));
});
`;

/**
 * Rammerhead bootstrapper.
 *
 * Rammerhead needs a session before it can serve anything, and sessions are
 * created by its own /newsession route, so this page asks for one and then
 * navigates to /<session>/<target>.
 */
export function rammerheadPage() {
  return shell(
    "Compaxy · Rammerhead",
    `<div class="boot" id="boot">
  <h1>Starting Rammerhead</h1>
  <p>Creating a proxy session…</p>
  <pre id="error" hidden></pre>
</div>
<script>
(async function () {
  var boot = document.getElementById('boot');
  var errorBox = document.getElementById('error');
  function fail(message) {
    boot.querySelector('h1').textContent = 'Rammerhead could not start';
    errorBox.hidden = false;
    errorBox.textContent = message;
  }

  try {
    var target = new URLSearchParams(location.search).get('url');
    if (!target) throw new Error('No target site was given.');

    var response = await fetch('/newsession', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('Rammerhead refused to create a session (' + response.status + ').');
    }
    var session = (await response.text()).trim();
    if (!/^[a-z0-9]{32}$/.test(session)) {
      throw new Error('Rammerhead returned an unexpected session id.');
    }
    location.replace('/' + session + '/' + target);
  } catch (error) {
    console.error(error);
    fail(error && error.message ? error.message : String(error));
  }
})();
</script>`
  );
}
