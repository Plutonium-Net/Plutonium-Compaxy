// Build Rammerhead's client bundles.
//
// Rammerhead is installed straight from git, and that repository ships source
// only: the minified client scripts its proxy serves (/hammerhead.js and
// friends) are produced by its own src/build.js. Its build resolves
// testcafe-hammerhead from a nested node_modules path that npm's hoisting does
// not create, so the package is linked there for the build and the generated
// files are left in place for the server to serve.
//
// A failure here is reported but not fatal: the other three engines do not
// depend on Rammerhead, and the server says plainly at startup if it is
// unavailable.

import { existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

function packageRoot(name) {
  return path.dirname(path.dirname(require.resolve(name)));
}

let root;
try {
  root = packageRoot("rammerhead");
} catch {
  console.log("Rammerhead is not installed; skipping its client build.");
  process.exit(0);
}

const output = path.join(root, "src", "client", "hammerhead.min.js");
if (existsSync(output)) {
  process.exit(0);
}

let hammerhead;
try {
  hammerhead = packageRoot("testcafe-hammerhead");
} catch {
  console.warn("testcafe-hammerhead is missing; Rammerhead cannot be built.");
  process.exit(0);
}

// The build reads ../node_modules/testcafe-hammerhead relative to its own src.
const linkDirectory = path.join(root, "node_modules");
const link = path.join(linkDirectory, "testcafe-hammerhead");
let createdLink = false;
try {
  mkdirSync(linkDirectory, { recursive: true });
  if (lstatSync(link)) {
    /* already there */
  }
} catch {
  try {
    symlinkSync(hammerhead, link, "dir");
    createdLink = true;
  } catch (error) {
    console.warn(`Could not link testcafe-hammerhead for the Rammerhead build: ${error.message}`);
  }
}

try {
  const build = spawnSync(process.execPath, [path.join(root, "src", "build.js")], {
    cwd: root,
    stdio: "inherit"
  });
  if (build.status !== 0) {
    console.warn(`Rammerhead's client build exited with status ${build.status}.`);
  }
} finally {
  if (createdLink) {
    try {
      unlinkSync(link);
    } catch {
      /* the link is harmless if it stays */
    }
  }
}

if (!existsSync(output)) {
  console.warn(
    "Rammerhead's client bundle was not produced; the Rammerhead engine will be unavailable."
  );
}
