// Pages that are not proxied content: the engine bootstrappers.
//
// A service-worker engine cannot be entered by a plain redirect into its prefix:
// the worker has to be installed and controlling before the navigation happens,
// or the first request reaches this server, which does not speak that engine's
// URL format. So every engine gets a small page here that prepares the engine
// and then navigates into its route.
//
// Each page opens with the same overlay: a full-screen black veil that hides the
// document (and the Scramjet frame) until the engine is live, and reports the
// boot as a monospace tree. Every step is a dot on a branch, so the shape of the
// tree is the shape of the startup: what runs, what waits, and where it stopped.

/**
 * Shared page chrome for the bootstrapper screens: the black veil, the dot tree
 * and the small API the page scripts drive it with.
 */
function shell({ title, engine, markup = "", script = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<link rel="icon" type="image/png" href="/favicon.png" />
<style>
  :root { color-scheme: dark; }
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #000; }
  body {
    color: #fff;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
      "Liberation Mono", "Courier New", monospace;
    font-size: 13px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  iframe { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; background: #000; }

  /* The veil owns the whole viewport: nothing of the page behind it shows. */
  .veil {
    position: fixed; inset: 0; z-index: 2147483647;
    background: #000; color: #fff;
    display: flex; align-items: center; justify-content: center;
    padding: 40px 24px; overflow: auto;
    opacity: 1; transition: opacity 240ms ease;
  }
  .veil[hidden] { display: none; }
  .veil.gone { opacity: 0; pointer-events: none; }
  .panel { width: min(100%, 44rem); }

  .bar {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: .55em;
    padding-bottom: .85rem; margin-bottom: 1.15rem;
    border-bottom: 1px solid rgba(255,255,255,.14);
    font-size: .72rem; letter-spacing: .2em; text-transform: uppercase;
    color: rgba(255,255,255,.45);
  }
  .bar .engine { color: #fff; }

  /* The tree: one dot per step, branches drawn as hairlines. */
  .tree, .tree ul { list-style: none; margin: 0; padding: 0; }
  .tree li { position: relative; }
  .tree li > .row {
    display: flex; align-items: center; gap: .7em;
    min-height: 1.9em; padding-left: 1.5em;
    animation: fade 260ms ease both;
  }
  .tree > li > .row { padding-left: .95em; letter-spacing: .06em; }
  .tree li > ul { padding-left: 1.3em; }
  .tree > li > ul { padding-left: .75em; }
  .tree li::before {
    content: ""; position: absolute; left: .5em; top: 0; height: 100%;
    border-left: 1px solid rgba(255,255,255,.16);
  }
  .tree li:last-child::before { height: .95em; }
  .tree li::after {
    content: ""; position: absolute; left: .5em; top: .95em; width: 1em;
    border-top: 1px solid rgba(255,255,255,.16);
  }
  .tree > li::before { top: .95em; height: auto; bottom: 0; left: 1.25em; }
  .tree > li::after { display: none; }

  .dot {
    flex: none; width: 8px; height: 8px; border-radius: 50%;
    border: 1px solid rgba(255,255,255,.35); background: transparent;
    transition: background-color 160ms ease, border-color 160ms ease,
      box-shadow 160ms ease;
  }
  .label { color: rgba(255,255,255,.4); transition: color 160ms ease; }
  li[data-state="active"] > .row .dot {
    background: #fff; border-color: #fff;
    animation: halo 1200ms ease-in-out infinite;
  }
  li[data-state="done"] > .row .dot { background: #fff; border-color: #fff; }
  li[data-state="error"] > .row .dot {
    background: #000; border-color: #fff;
    box-shadow: 0 0 0 2px rgba(255,255,255,.25);
  }
  li[data-state="active"] > .row .label,
  li[data-state="error"] > .row .label { color: #fff; }
  li[data-state="done"] > .row .label { color: rgba(255,255,255,.9); }

  .foot {
    display: flex; align-items: center; gap: .55em;
    margin-top: 1.35rem; padding-top: .9rem;
    border-top: 1px solid rgba(255,255,255,.14);
    font-size: .72rem; letter-spacing: .18em; text-transform: uppercase;
    color: rgba(255,255,255,.5);
  }
  .foot .caret {
    width: .5em; height: .95em; background: #fff;
    animation: blink 1000ms steps(1) infinite;
  }
  .foot[data-state="halted"] .caret { animation: none; opacity: .2; }
  .foot[data-state="live"] { color: #fff; }

  #error {
    margin: 1.1rem 0 0; padding: .85rem 1rem;
    white-space: pre-wrap; word-break: break-word;
    font-size: .78rem; line-height: 1.65; color: #fff;
    border: 1px solid rgba(255,255,255,.3); background: rgba(255,255,255,.04);
  }
  #error[hidden] { display: none; }

  @keyframes halo {
    0%, 100% { box-shadow: 0 0 0 3px rgba(255,255,255,.14); }
    50% { box-shadow: 0 0 0 7px rgba(255,255,255,.03); }
  }
  @keyframes blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
  @keyframes fade {
    from { opacity: 0; transform: translateY(-2px); }
    to { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; transition: none !important; }
  }
</style>
<script>
// The boot tree. Pages describe the shape of their startup once, then mark the
// node they are working on; the tree is the only progress indicator.
(function () {
  var treeEl = null, statusEl = null, errorEl = null, veilEl = null, footEl = null;
  var nodes = {};

  function ready() {
    if (!treeEl) treeEl = document.getElementById('tree');
    if (!statusEl) statusEl = document.getElementById('status');
    if (!errorEl) errorEl = document.getElementById('error');
    if (!veilEl) veilEl = document.getElementById('veil');
    if (!footEl) footEl = document.getElementById('foot');
  }

  function build(spec) {
    var li = document.createElement('li');
    li.setAttribute('data-state', 'pending');

    var row = document.createElement('span');
    row.className = 'row';

    var dot = document.createElement('span');
    dot.className = 'dot';

    var label = document.createElement('span');
    label.className = 'label';
    label.textContent = spec.label;

    row.appendChild(dot);
    row.appendChild(label);
    li.appendChild(row);

    if (spec.id) {
      nodes[spec.id] = li;
      li.setAttribute('data-id', spec.id);
    }

    if (spec.children && spec.children.length) {
      var ul = document.createElement('ul');
      for (var i = 0; i < spec.children.length; i++) {
        ul.appendChild(build(spec.children[i]));
      }
      li.appendChild(ul);
    }
    return li;
  }

  window.CompaxyBoot = {
    render: function (spec) {
      ready();
      nodes = {};
      if (!treeEl) return;
      treeEl.textContent = '';
      for (var i = 0; i < spec.length; i++) treeEl.appendChild(build(spec[i]));
      this.status('starting');
    },
    mark: function (id, state) {
      ready();
      var li = nodes[id];
      if (li) li.setAttribute('data-state', state);
    },
    status: function (text) {
      ready();
      if (statusEl) statusEl.textContent = text;
    },
    fail: function (id, message) {
      ready();
      var li = nodes[id];
      if (li) {
        li.setAttribute('data-state', 'error');
        // A branch cannot still be "working" if a step under it stopped.
        var parent = li.parentNode && li.parentNode.parentNode;
        while (parent && parent.tagName === 'LI') {
          if (parent.getAttribute('data-state') === 'active') {
            parent.setAttribute('data-state', 'error');
          }
          parent = parent.parentNode && parent.parentNode.parentNode;
        }
      }
      if (statusEl) statusEl.textContent = 'halted';
      if (footEl) footEl.setAttribute('data-state', 'halted');
      if (errorEl) {
        errorEl.hidden = false;
        errorEl.textContent = String(message);
      }
    },
    hide: function () {
      ready();
      if (statusEl) statusEl.textContent = 'live';
      if (footEl) footEl.setAttribute('data-state', 'live');
      if (!veilEl) return;
      veilEl.classList.add('gone');
      window.setTimeout(function () {
        veilEl.hidden = true;
      }, 240);
    }
  };
})();
</script>
</head>
<body>
${markup}
<div class="veil" id="veil">
  <div class="panel">
    <div class="bar">
      <span>compaxy</span>
      <span class="engine">${engine}</span>
    </div>
    <ul class="tree" id="tree"></ul>
    <div class="foot" id="foot" data-state="running">
      <span class="caret"></span>
      <span id="status">starting</span>
    </div>
    <pre id="error" hidden></pre>
  </div>
</div>
<script>
function whenActivated(registration) {
  var worker = registration.installing || registration.waiting || registration.active;
  if (!worker) return Promise.reject(new Error('The service worker did not install.'));
  if (worker.state === 'activated') return Promise.resolve(worker);
  return new Promise(function (resolve, reject) {
    worker.addEventListener('statechange', function () {
      if (worker.state === 'activated') resolve(worker);
      if (worker.state === 'redundant') {
        reject(new Error('The service worker was discarded.'));
      }
    });
  });
}
</script>
${script}
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
  return shell({
    title: "Compaxy · Scramjet v2",
    engine: "scramjet v2",
    markup:
      `<iframe id="frame" allow="clipboard-read; clipboard-write; fullscreen; autoplay; encrypted-media"></iframe>`,
    script: `<script src="/sj/scramjet.js"></script>
<script src="/sj/controller.api.js"></script>
<script>
// The server-side engine serves a site at a path that mirrors the site's own
// path; this is src/urls.js's toProxyUrl, written for the browser.
function baseProxyUrl(target) {
  var url = new URL(target);
  return '/proxy/' + url.protocol.slice(0, -1) + '/' + url.host + url.pathname + url.search;
}

(async function () {
  var tree = window.CompaxyBoot;
  tree.render([
    { id: 'transport', label: 'transport', children: [
      { id: 'transport-epoxy', label: 'epoxy transport' },
      { id: 'transport-wisp', label: 'wisp socket /wisp/scram/' }
    ] },
    { id: 'worker', label: 'service worker', children: [
      { id: 'worker-register', label: 'register /scram/sw.js' },
      { id: 'worker-activate', label: 'activate scope /scram/' }
    ] },
    { id: 'controller', label: 'controller', children: [
      { id: 'controller-ready', label: 'load bundle + wasm' }
    ] },
    { id: 'frame', label: 'frame', children: [
      { id: 'frame-navigate', label: 'navigate to target' }
    ] }
  ]);

  var step = 'transport';
  try {
    var target = new URLSearchParams(location.search).get('url') ||
      decodeURIComponent(location.hash.slice(1) || '');
    if (!target) throw new Error('No target site was given.');
    // The Wisp transport needs SharedArrayBuffer, which only a cross-origin
    // isolated document has. A frame is never isolated (see src/embed.js), so
    // serve the site from the engine that works there instead of showing a boot
    // error the frame could never get past.
    if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
      tree.status('falling back to the base engine');
      location.replace(baseProxyUrl(target));
      return;
    }
    if (!('serviceWorker' in navigator)) {
      step = 'worker';
      throw new Error(
        'Service workers need https or localhost; this page is not on an origin that allows them.'
      );
    }

    tree.mark('transport', 'active');
    tree.mark('transport-epoxy', 'active');
    var EpoxyTransport = (await import('/epoxy3/index.mjs')).default;
    tree.mark('transport-epoxy', 'done');

    tree.mark('transport-wisp', 'active');
    var socket = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/wisp/scram/';
    var transport = new EpoxyTransport({ wisp: socket });
    tree.mark('transport-wisp', 'done');
    tree.mark('transport', 'done');

    step = 'worker-register';
    tree.status('installing service worker');
    tree.mark('worker', 'active');
    tree.mark('worker-register', 'active');
    var registration = await navigator.serviceWorker.register('/scram/sw.js', { scope: '/scram/' });
    tree.mark('worker-register', 'done');

    step = 'worker-activate';
    tree.mark('worker-activate', 'active');
    var worker = await whenActivated(registration);
    tree.mark('worker-activate', 'done');
    tree.mark('worker', 'done');

    step = 'controller-ready';
    tree.status('starting controller');
    tree.mark('controller', 'active');
    tree.mark('controller-ready', 'active');
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
    tree.mark('controller-ready', 'done');
    tree.mark('controller', 'done');

    step = 'frame-navigate';
    tree.status('opening frame');
    tree.mark('frame', 'active');
    tree.mark('frame-navigate', 'active');
    var frame = controller.createFrame(document.getElementById('frame'));
    frame.go(target);
    tree.mark('frame-navigate', 'done');
    tree.mark('frame', 'done');

    tree.hide();
  } catch (error) {
    console.error(error);
    tree.fail(step, error && error.message ? error.message : String(error));
  }
})();
</script>`
  });
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
  var host = String(hostname || '').toLowerCase().replace(/\\\\.+$/, '');
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
    '<h1>Blocked</h1><p>' + String(message).replace(/[&<>\"]/g, function (c) {
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
    if (/^https?:\\\\/\\\\//i.test(value)) return value;
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
  return shell({
    title: "Compaxy · Ultraviolet",
    engine: "ultraviolet",
    script: `<script src="/uv/uv.bundle.js"></script>
<script src="/uv/uv.config.js"></script>
<script src="/baremux/index.js"></script>
<script>
(async function () {
  var tree = window.CompaxyBoot;
  tree.render([
    { id: 'transport', label: 'transport', children: [
      { id: 'transport-mux', label: 'bare-mux worker' },
      { id: 'transport-epoxy', label: 'epoxy /wisp/uv/' }
    ] },
    { id: 'worker', label: 'service worker', children: [
      { id: 'worker-register', label: 'register /uv/sw.js' },
      { id: 'worker-activate', label: 'activate scope /uv/' }
    ] },
    { id: 'navigate', label: 'navigate', children: [
      { id: 'navigate-encode', label: 'encode target into /uv/service/' }
    ] }
  ]);

  var step = 'transport';
  try {
    var target = new URLSearchParams(location.search).get('url');
    if (!target) throw new Error('No target site was given.');
    // See the Scramjet page: SharedArrayBuffer needs an isolated document, and a
    // frame is never isolated, so serve the site from the server-side engine.
    if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
      tree.status('falling back to the base engine');
      var url = new URL(target);
      location.replace('/proxy/' + url.protocol.slice(0, -1) + '/' + url.host + url.pathname + url.search);
      return;
    }
    if (!('serviceWorker' in navigator)) {
      step = 'worker';
      throw new Error(
        'Service workers need https or localhost; this page is not on an origin that allows them.'
      );
    }

    tree.mark('transport', 'active');
    tree.mark('transport-mux', 'active');
    var socket = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/wisp/uv/';
    var connection = new BareMux.BareMuxConnection('/baremux/worker.js');
    tree.mark('transport-mux', 'done');

    tree.mark('transport-epoxy', 'active');
    await connection.setTransport('/epoxy/index.mjs', [{ wisp: socket }]);
    tree.mark('transport-epoxy', 'done');
    tree.mark('transport', 'done');

    step = 'worker-register';
    tree.status('installing service worker');
    tree.mark('worker', 'active');
    tree.mark('worker-register', 'active');
    var registration = await navigator.serviceWorker.register('/uv/sw.js', { scope: '/uv/' });
    tree.mark('worker-register', 'done');

    step = 'worker-activate';
    tree.mark('worker-activate', 'active');
    await whenActivated(registration);
    tree.mark('worker-activate', 'done');
    tree.mark('worker', 'done');

    step = 'navigate-encode';
    tree.status('entering /uv/service/');
    tree.mark('navigate', 'active');
    tree.mark('navigate-encode', 'active');
    location.replace(__uv$config.prefix + __uv$config.encodeUrl(target));
  } catch (error) {
    console.error(error);
    tree.fail(step, error && error.message ? error.message : String(error));
  }
})();
</script>`
  });
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
    if (/^https?:\\\\/\\\\//i.test(target)) {
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
  return shell({
    title: "Compaxy · Rammerhead",
    engine: "rammerhead",
    script: `<script>
(async function () {
  var tree = window.CompaxyBoot;
  tree.render([
    { id: 'session', label: 'session', children: [
      { id: 'session-request', label: 'GET /newsession' },
      { id: 'session-parse', label: 'read session id' }
    ] },
    { id: 'verify', label: 'verify', children: [
      { id: 'verify-shape', label: 'id shape [a-z0-9]{32}' }
    ] },
    { id: 'navigate', label: 'navigate', children: [
      { id: 'navigate-replace', label: 'replace /<session>/<target>' }
    ] }
  ]);

  var step = 'session-request';
  try {
    var target = new URLSearchParams(location.search).get('url');
    if (!target) throw new Error('No target site was given.');

    tree.mark('session', 'active');
    tree.mark('session-request', 'active');
    var response = await fetch('/newsession', { cache: 'no-store' });
    tree.mark('session-request', 'done');

    tree.mark('session-parse', 'active');
    if (!response.ok) {
      throw new Error('Rammerhead refused to create a session (' + response.status + ').');
    }
    var session = (await response.text()).trim();
    tree.mark('session-parse', 'done');
    tree.mark('session', 'done');

    step = 'verify-shape';
    tree.mark('verify', 'active');
    tree.mark('verify-shape', 'active');
    if (!/^[a-z0-9]{32}$/.test(session)) {
      throw new Error('Rammerhead returned an unexpected session id.');
    }
    tree.mark('verify-shape', 'done');
    tree.mark('verify', 'done');

    step = 'navigate-replace';
    tree.status('entering session');
    tree.mark('navigate', 'active');
    tree.mark('navigate-replace', 'active');
    location.replace('/' + session + '/' + target);
  } catch (error) {
    console.error(error);
    tree.fail(step, error && error.message ? error.message : String(error));
  }
})();
</script>`
  });
}
