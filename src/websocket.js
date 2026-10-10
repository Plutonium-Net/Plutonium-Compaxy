// WebSocket (and generic Upgrade) relay.
//
// The shim rewrites page WebSocket URLs to /proxy/ws/... or /proxy/wss/... .
// We open a raw upstream connection and pipe bytes both ways, so no WebSocket
// framing is parsed here.

import http from "node:http";
import https from "node:https";
import { fromProxyRequest, assertPublicDestination } from "./urls.js";
import { blockedMessageForUrl } from "./blocklist.js";

export async function handleUpgrade(req, socket, head, resolvedTarget) {
  let target = resolvedTarget;
  if (!target) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      target = fromProxyRequest(url.pathname, url.search);
    } catch {
      socket.destroy();
      return;
    }
  }

  let parsed;
  try {
    parsed = new URL(target);
    await assertPublicDestination(parsed);
  } catch {
    socket.destroy();
    return;
  }

  // A raw Upgrade carries no response body to explain itself, so a blocked
  // domain is simply refused here; the page that opened it will see the
  // WebSocket close.
  if (blockedMessageForUrl(parsed)) {
    socket.destroy();
    return;
  }

  const secure = parsed.protocol === "wss:";
  const lib = secure ? https : http;

  const headers = { ...req.headers };
  delete headers.host;
  delete headers["content-length"];
  delete headers["sec-websocket-extensions"];
  if (!headers.cookie) delete headers.cookie;

  const upstream = lib.request({
    hostname: parsed.hostname,
    port: parsed.port || (secure ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: req.method,
    headers
  });

  upstream.on("upgrade", (upgradeResponse, upstreamSocket, upstreamHead) => {
    // Both ends can vanish at any moment - a page navigating away closes its
    // socket mid-relay. Every socket needs an error listener *before* the first
    // write, and a write to an already-dead socket reports its failure through
    // an 'error' event: unlistened, that event takes the whole process down and
    // with it every other proxied tab.
    upstreamSocket.on("error", () => socket.destroy());
    socket.on("error", () => upstreamSocket.destroy());

    socket.write(headResponse(upgradeResponse));
    if (upstreamHead?.length) socket.write(upstreamHead);
    if (head?.length) upstreamSocket.write(head);

    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
    const shutdown = () => {
      upstreamSocket.destroy();
      socket.destroy();
    };
    socket.on("close", shutdown);
    upstreamSocket.on("close", shutdown);
  });

  upstream.on("response", (response) => {
    // Upstream declined the upgrade; relay the plain response. The same hazard
    // applies here, and it is the common case: sites that answer an upgrade
    // request with an ordinary page (Discord's gateway handshake, for one) hit
    // this path constantly, so a client that disconnects mid-body must not be
    // able to kill the process.
    socket.on("error", () => response.destroy());
    response.on("error", () => socket.destroy());
    socket.on("close", () => response.destroy());
    response.on("close", () => socket.destroy());
    socket.write(headResponse(response));
    response.pipe(socket);
  });

  upstream.on("error", () => socket.destroy());
  upstream.end();
}

function headResponse(response) {
  const lines = [`HTTP/1.1 ${response.statusCode} ${response.statusMessage || ""}`.trim()];
  for (const [key, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${key}: ${item}`);
    } else if (value !== undefined) {
      lines.push(`${key}: ${value}`);
    }
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}
