// Serve one file out of an allowlisted directory.
//
// The engine bundles (Scramjet, Ultraviolet, bare-mux, Epoxy) live inside
// node_modules, so their directories are mounted at fixed URL prefixes. Nothing
// outside the mounted directory can be reached: the request path is resolved
// against it and must still be inside it afterwards, and a caller can restrict
// a mount to an explicit set of file names.

import { createReadStream, statSync } from "node:fs";
import path from "node:path";

const TYPES = new Map([
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".cjs", "text/javascript; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".css", "text/css; charset=utf-8"]
]);

/**
 * Build a responder for one directory.
 *
 * Returns a function (req, res, relativePath) that answers the request and
 * returns true, or returns false when the file is not served by this mount.
 */
export function directoryMount(
  root,
  { cacheControl = "public, max-age=3600", only = null } = {}
) {
  const base = path.resolve(root);

  return function send(req, res, relativePath) {
    let relative;
    try {
      relative = decodeURIComponent(relativePath);
    } catch {
      return false;
    }
    relative = relative.replace(/^\/+/, "");
    if (!relative || relative.includes("\0")) return false;
    if (only && !only.has(relative)) return false;

    const file = path.resolve(base, relative);
    if (file !== base && !file.startsWith(base + path.sep)) return false;

    let stat;
    try {
      stat = statSync(file);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;

    res.writeHead(200, {
      "content-type": TYPES.get(path.extname(file).toLowerCase()) || "application/octet-stream",
      "content-length": stat.size,
      "cache-control": cacheControl,
      "last-modified": stat.mtime.toUTCString()
    });
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    createReadStream(file)
      .on("error", () => res.destroy())
      .pipe(res);
    return true;
  };
}
