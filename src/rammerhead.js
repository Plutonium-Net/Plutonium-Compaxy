// Rammerhead bridge.
//
// Rammerhead is not a service-worker proxy: it rewrites pages server-side and
// keeps per-session cookie/localStorage state, with its routes at the root of
// the origin (/newsession, /hammerhead.js, /<session>/<url>). Its client scripts
// are root-relative, so rather than rewrite every path we mount it at the root
// behind an explicit path guard that the router consults before anything else.
//
// It is constructed with `dontListen`, so it never opens a socket of its own:
// its internal http.Server is driven from the one listening server, which keeps
// the whole thing to a single port and a single process.

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

// Rammerhead's config module builds its default disk JS cache at import time and
// throws if that folder is missing - and the folder only exists after its own
// build step, which a git dependency does not run. The cache we actually hand to
// the proxy is in memory, so the folder only has to exist.
function ensureScratchDirectory() {
  try {
    const root = path.dirname(path.dirname(require.resolve("rammerhead")));
    mkdirSync(path.join(root, "cache-js"), { recursive: true });
  } catch {
    /* a missing scratch folder surfaces again as a clear import error below */
  }
}

// Root paths Rammerhead and testcafe-hammerhead serve themselves.
const SERVICE_PATHS = new Set([
  "/rammerhead.js",
  "/hammerhead.js",
  "/transport-worker.js",
  "/task.js",
  "/iframe-task.js",
  "/worker-hammerhead.js",
  "/messaging",
  "/sessionexists",
  "/deletesession",
  "/newsession",
  "/editsession",
  "/needpassword",
  "/syncLocalStorage",
  "/api/shuffleDict",
  "/mainport"
]);

// /<sessionId>/<target address> - Rammerhead session ids are 32 characters.
const SESSION_PATH = /^\/[a-z0-9]{32}(\/|$)/;

export function isRammerheadPath(pathname) {
  return SERVICE_PATHS.has(pathname) || SESSION_PATH.test(pathname);
}

export function createRammerhead({ accessLog = false } = {}) {
  ensureScratchDirectory();

  const RammerheadProxy = require("rammerhead/src/classes/RammerheadProxy.js");
  const RammerheadLogging = require("rammerhead/src/classes/RammerheadLogging.js");
  const RammerheadJSMemCache = require("rammerhead/src/classes/RammerheadJSMemCache.js");
  const RammerheadSessionMemoryStore = require("rammerhead/src/classes/RammerheadSessionMemoryStore.js");
  const setupRoutes = require("rammerhead/src/server/setupRoutes.js");
  const config = require("rammerhead/src/config.js");

  // The router is the only front door, so Rammerhead's own password gate and
  // its per-IP session pinning (which would break sharing inside one browser
  // session across tabs) are both turned off here.
  config.password = null;
  config.restrictSessionToIP = false;

  const logger = new RammerheadLogging({
    logLevel: accessLog ? "info" : "disabled"
  });

  const getServerInfo = (req) => {
    const host = req.headers.host || "localhost";
    let hostname = "localhost";
    let port = null;
    try {
      const parsed = new URL(`http://${host}`);
      hostname = parsed.hostname;
      port = parsed.port ? Number(parsed.port) : null;
    } catch {
      /* keep the fallback */
    }
    const protocol = req.socket.encrypted ? "https:" : "http:";
    return {
      hostname,
      port: port ?? (protocol === "https:" ? 443 : 80),
      protocol
    };
  };

  const proxy = new RammerheadProxy({
    logger,
    loggerGetIP: (req) => req.socket.remoteAddress,
    bindingAddress: "127.0.0.1",
    port: 0,
    crossDomainPort: null,
    dontListen: true,
    ssl: null,
    getServerInfo,
    disableLocalStorageSync: false,
    jsCache: new RammerheadJSMemCache(50 * 1024 * 1024),
    disableHttp2: false
  });

  // Sessions live in memory: this process owns no database, and persisting a
  // proxied browser's cookies to disk is not something a local proxy should do
  // by default.
  const sessions = new RammerheadSessionMemoryStore({
    logger,
    staleTimeout: 1000 * 60 * 60,
    maxToLive: 1000 * 60 * 60 * 6,
    cleanupInterval: 1000 * 60 * 5
  });
  sessions.attachToProxy(proxy);
  setupRoutes(proxy, sessions, logger);

  const server = proxy.server1;
  if (!server) {
    throw new Error("Rammerhead did not create a request server.");
  }

  return {
    handle(req, res) {
      server.emit("request", req, res);
    },
    handleUpgrade(req, socket, head) {
      server.emit("upgrade", req, socket, head);
    },
    clientScript() {
      return require.resolve("rammerhead/src/client/rammerhead.js");
    }
  };
}
