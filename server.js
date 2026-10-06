// Plutonium proxy - server only.
//
// There is no frontend and no build step: this process is the whole proxy. Ask
// it for a site and it fetches, rewrites and serves that site:
//
//     http://127.0.0.1:5201/?url=https://example.com/
//
// That address is the whole interface, so the proxy drops straight into an
// iframe on any page:
//
//     <iframe src="http://127.0.0.1:5201/?url=https://example.com/"></iframe>
//
// The ?url= entry point resolves the target and hands the browser a path-form
// address (/proxy/<scheme>/<host>/<path>). That extra hop is what keeps the
// proxy correct: the browser's own URL keeps the upstream site's real path, so
// relative references, forms and client-side routers resolve exactly as they do
// on the original site, and no rewrite has to guess what a URL meant.

import http from "node:http";

import {
  normalizeTargetUrl,
  toProxyUrl,
  fromProxyRequest,
  PROXY_PREFIX
} from "./src/urls.js";
import { handleProxy } from "./src/proxy.js";
import { handleUpgrade } from "./src/websocket.js";

// PORT is only honoured when it is an actual port: environments that set PORT
// to an empty string or 0 ("pick anything") must still land on the default,
// because nothing could discover the random one.
const requestedPort = Number(process.env.PORT);
const port =
  Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 5201;
// Platforms such as Render inject PORT and probe 0.0.0.0 for a listening
// socket, so when a port is supplied from the environment we must bind every
// interface; a loopback-only bind is invisible to that probe and the deploy
// never finalizes. With no PORT (plain local run) stay on loopback.
const host = process.env.HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const accessLog = process.env.PLUT_LOG === "1";

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

// The only markup this server owns: a one-field entry form, for when the
// address above is opened directly instead of embedded.
function entryPage() {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Plutonium proxy</title>
<style>
  :root{color-scheme:dark light}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e8eaf0;font:15px/1.5 system-ui,sans-serif}
  form{display:flex;gap:8px;width:min(92vw,44rem)}
  input{flex:1;padding:12px 14px;font:inherit;border-radius:8px;border:1px solid #333a48;background:#171a21;color:inherit}
  button{padding:12px 18px;font:inherit;border-radius:8px;border:0;background:#4f7cff;color:#fff;cursor:pointer}
</style>
<form onsubmit="location.replace('/?url='+encodeURIComponent(this.q.value));return false">
  <input name="q" placeholder="https://example.com" autofocus autocomplete="off" spellcheck="false">
  <button>Go</button>
</form>`;
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  try {
    // Entry point: /?url=<address>. Resolve it, then serve the site from its
    // own mirrored path so the browser's URL stays meaningful.
    if (requestUrl.pathname === "/") {
      if (!requestUrl.search) {
        return sendText(res, 200, entryPage(), "text/html; charset=utf-8");
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
      res.writeHead(302, { location: toProxyUrl(target), "cache-control": "no-store" });
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

    sendText(res, 404, "Not found. Use /?url=<address> to proxy a site.\n");
  } catch (error) {
    if (!res.headersSent) {
      sendText(res, 500, `Server error: ${error.message}\n`);
    } else {
      res.destroy();
    }
  }
});

server.on("upgrade", (req, socket, head) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
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
  console.log(`Plutonium proxy running at http://${host}:${port}`);
  console.log(`Embed it:  <iframe src="http://${host}:${port}/?url=https://example.com/"></iframe>`);
});
