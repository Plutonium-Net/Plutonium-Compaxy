// Which proxy engine serves which site.
//
// The routing table is data, not code: sites.json at the project root (override
// the path with COMPAXY_SITES). Each entry names hosts and exactly one engine,
// because a site is served by one engine and one engine only - a routed site is
// never retried on a different engine.
//
//     { "hosts": ["netflix.com"], "engine": "base" }
//
// A bare host matches that domain and all of its subdomains; a "*.example.com"
// entry matches subdomains only. Entries are tried in order, so put specific
// hosts before broad ones.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const TABLE_PATH = process.env.COMPAXY_SITES
  ? path.resolve(process.env.COMPAXY_SITES)
  : path.join(HERE, "..", "sites.json");

// Each engine's route is the prefix it serves proxied pages from, which is also
// what the entry point redirects into.
export const ENGINES = {
  base: {
    id: "base",
    label: "Compaxy base",
    kind: "rewrite",
    route: "/proxy/",
    blurb: "Server-side fetch and rewrite"
  },
  scramjet: {
    id: "scramjet",
    label: "Scramjet v2",
    kind: "service-worker",
    route: "/scram/",
    blurb: "Service worker over Wisp"
  },
  ultraviolet: {
    id: "ultraviolet",
    label: "Ultraviolet",
    kind: "service-worker",
    route: "/uv/service/",
    blurb: "Service worker over Wisp"
  }
};

export const ENGINE_IDS = Object.keys(ENGINES);
export const DEFAULT_ENGINE = "scramjet";

function hostMatches(pattern, hostname) {
  const value = String(pattern).toLowerCase().trim();
  if (!value) return false;
  if (value === "*") return true;
  if (value.startsWith("*.")) {
    return hostname.endsWith(`.${value.slice(2)}`);
  }
  return hostname === value || hostname.endsWith(`.${value}`);
}

function loadTable() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(TABLE_PATH, "utf8"));
  } catch (error) {
    console.warn(
      `Routing table ${TABLE_PATH} could not be read (${error.message}); ` +
        `every site will use ${DEFAULT_ENGINE}.`
    );
    return { fallback: DEFAULT_ENGINE, entries: [], problem: error.message };
  }

  const fallback = ENGINES[raw?.default] ? raw.default : DEFAULT_ENGINE;
  if (raw?.default && raw.default !== fallback) {
    console.warn(`Unknown default engine "${raw.default}"; using ${DEFAULT_ENGINE}.`);
  }

  const entries = [];
  for (const entry of Array.isArray(raw?.sites) ? raw.sites : []) {
    const hosts = Array.isArray(entry?.hosts) ? entry.hosts.filter(Boolean) : [];
    if (!hosts.length) {
      console.warn("Routing table entry without hosts was ignored.");
      continue;
    }
    if (!ENGINES[entry?.engine]) {
      console.warn(
        `Routing table entry for ${hosts.join(", ")} names unknown engine ` +
          `"${entry?.engine}" and was ignored.`
      );
      continue;
    }
    entries.push({ hosts, engine: entry.engine });
  }

  return { fallback, entries, problem: null };
}

const table = loadTable();

export function engineForUrl(target) {
  let hostname = "";
  try {
    hostname = new URL(String(target)).hostname.toLowerCase();
  } catch {
    return { engine: ENGINES[table.fallback], entry: null };
  }
  for (const entry of table.entries) {
    if (entry.hosts.some((pattern) => hostMatches(pattern, hostname))) {
      return { engine: ENGINES[entry.engine], entry };
    }
  }
  return { engine: ENGINES[table.fallback], entry: null };
}

export function defaultEngine() {
  return ENGINES[table.fallback];
}

export function tableProblem() {
  return table.problem;
}

/** The table as rows, for the entry page. */
export function routingSummary() {
  return table.entries.map((entry) => ({
    hosts: entry.hosts,
    engine: ENGINES[entry.engine]
  }));
}
