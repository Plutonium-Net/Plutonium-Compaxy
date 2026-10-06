# Plutonium Proxy

A server-side fetch-and-rewrite web proxy. There is no frontend: this Node
process *is* the proxy. Ask it for a site with a query parameter and it fetches,
rewrites and serves that site, with every URL the page emits mapped back onto
its own origin.

```text
iframe / browser  ->  this process  ->  upstream site
   ?url=...            fetch, rewrite, cookies, redirects, WebSocket
                       <- rewritten page and assets
```

## Run it

```bash
npm start                # http://127.0.0.1:5201
PORT=8080 npm start      # pick a port
HOST=0.0.0.0 npm start   # bind elsewhere (read the security note first)
PLUT_LOG=1 npm start     # log each proxied request
```

## Use it

Point an iframe at the `?url=` address. That is the entire interface:

```html
<iframe src="http://127.0.0.1:5201/?url=https://duckduckgo.com/?q=plutonium"></iframe>
```

The target is normalised for you, so `?url=example.com` means
`https://example.com/`, and the entry point works from an address bar too.
Opening `http://127.0.0.1:5201/` without a query gives a one-field form for
testing.

`?url=` answers with a redirect to the address the site is actually served
from:

```text
http://127.0.0.1:5201/?url=https://poki.com/en/g/subway-surfers
  ->  http://127.0.0.1:5201/proxy/https/poki.com/en/g/subway-surfers
```

## Why the redirect

The proxy serves each target at a path that *mirrors the target's own path*
(`/proxy/https/<host>/<path>`), rather than carrying the target in the query
string on every request. That matters for correctness:

- a relative reference `c.png` on `/proxy/https/example.com/a/b` resolves to
  `/proxy/https/example.com/a/c.png` in the browser itself, so nothing has to
  parse or guess it;
- a form with no `action` posts back to the right place, and a client-side
  router reading `location.pathname` sees the paths it expects;
- anything the rewriter happens not to know about still resolves correctly,
  because the shape of the URL is unchanged.

With the target in the query string only, the browser's path would always be
`/` and every one of those cases would break. So `?url=` is the entry point and
the mirrored path is the canonical form.

## What the process owns

- `server.js` — routing: the `?url=` entry point, `/proxy/...`, WebSocket
  upgrade, and the single entry form.
- `src/urls.js` — the `/proxy/...` scheme, `?url=` normalisation, and SSRF
  protection (private/loopback ranges are refused, including via DNS).
- `src/headers.js` — request/response header and cookie translation. Strips CSP,
  X-Frame-Options, HSTS and cross-origin isolation (which is also what makes the
  proxy embeddable); re-scopes `Set-Cookie` to the proxied origin; rewrites
  `Location`, `Refresh` and `Link`; rewrites `Origin`/`Referer` back to the real
  target.
- `src/rewrite.js` — HTML and CSS rewriting with correct charset decoding.
  Rewrites URL attributes, `srcset`/`imagesrcset` (spec tokeniser, so commas
  inside Cloudflare image URLs survive), inline `style`, `<style>`, `<base>` and
  `<meta refresh>`. Inline `<script>` bodies are masked so rewriting never
  corrupts embedded JSON/JS, and `target="_top"/"_parent"` is collapsed so a page
  cannot navigate the host page around it.
- `src/shim.js` — the runtime shim injected into every proxied document (owned
  and emitted by the server). It maps URLs built at runtime back onto the proxy:
  `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `Worker`, `sendBeacon`,
  `window.open`, `history.pushState/replaceState`, the reflected
  `src`/`href`/`srcset` setters and `setAttribute`, plus namespaced
  `localStorage`/`sessionStorage`. It also buffers streamed request bodies,
  because Chromium refuses an unknown-length body over cleartext HTTP/1.1.
- `src/proxy.js` — upstream fetch with manual redirects, text buffering for
  rewriteable types, byte streaming for everything else, range passthrough.
- `src/websocket.js` — raw Upgrade relay (no WebSocket framing parsed).
- `src/cache.js` — LRU response cache (4 MB entry / 64 MB total caps).

## Verified

Checked by following every asset URL a page emits, plus a real browser session:

- **duckduckgo.com** — search results render fully; scripts, styles, fonts,
  images and XHR all load through the proxy.
- **poki.com** — homepage and game pages render; icons, thumbnails, CSS, JS
  bundles and fonts all load.
- **embedded** — a page on a different origin frames the proxy and the site
  inside it renders and navigates normally.
- **google.com** — redirects and rewriting work, but Google serves a bot
  challenge (`/sorry/index`) to this network, so search results do not appear.

## Known limits

- YouTube plays only the first ~60 s of a video. Media is a stateful SABR POST
  stream to `googlevideo.com`, whose Stream Protection Service starts answering
  the proxied connection with control-only frames (~a few MB in) regardless of
  the client hints, address family or body framing sent; the player then stalls
  and never recovers. Unproxied playback of the same video is unaffected.
- Poki's playable game does not finish booting: its SDK performs domain-lock
  checks against `poki.com/sitelock`, so some resource loads are deliberately
  aborted. Assets themselves load.
- Worker-internal requests are only partially shimmed; service workers are
  disabled on purpose (they cannot be scoped per proxied origin).
- Cookies: each proxied site gets host-only cookies scoped to its
  `/proxy/<scheme>/<host>/` path, with the upstream `SameSite` value preserved.
  Embedding the proxy in a third-party page therefore sends a site's `Lax`/
  `Strict` cookies only where the browser allows it.
- A fetch-and-rewrite proxy cannot render a site that refuses non-browser
  clients, and it has no JS engine of its own — it relies on the browser's.

## Security

Do not expose this unauthenticated on the internet. There is no password gate
any more: bind it to loopback (the default), or put authentication in front of
it. Private networks are already blocked from being proxied.
