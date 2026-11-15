// Which engine can actually serve a request that arrives inside someone else's
// page.
//
// Scramjet and Ultraviolet reach the proxy over Wisp, and that transport needs
// SharedArrayBuffer, which browsers only expose to a cross-origin isolated
// document. Isolation belongs to the whole frame tree: a document framed by a
// page that is not isolated can never be isolated itself, however it sets its own
// COOP/COEP. A host page usually cannot be isolated either, because COEP would
// stop it framing anything at all - so inside a frame those two engines can never
// start, and the frame sits on the bootstrapper's error screen forever.
//
// The routing table still decides which engine owns a site. This decides which
// engine can run where the request came from: the rewrite engine is server-side,
// needs no isolation, and works in a frame.

import { ENGINES } from "./engines.js";

/** Engines that need SharedArrayBuffer, and therefore an isolated document. */
export const NEEDS_ISOLATION = new Set(["scramjet", "ultraviolet"]);

/** True when a document request came from a frame rather than a tab of its own. */
export function isFramedRequest(headers = {}) {
  const destination = String(headers["sec-fetch-dest"] || "").toLowerCase();
  return destination === "iframe" || destination === "frame";
}

/**
 * The engine to serve `engine` with, given where the request came from. A worker
 * engine asked for by a frame is answered by the server-side engine instead.
 */
export function embedCapableEngine(engine, framed) {
  if (framed && NEEDS_ISOLATION.has(engine.id)) return ENGINES.base;
  return engine;
}
