/**
 * next.config.ts ↔ Cloudflare Pages' public/_headers and public/_redirects.
 *
 * A static export (KLORN_STATIC_EXPORT=1) cannot run headers() or
 * redirects(), so Cloudflare Pages serves the same rules from two plain files
 * (docs/deploy/cloudflare-pages.md). This module translates the config into
 * what those files must say, parses the files the way Cloudflare documents
 * them, and diffs the two. Used by cloudflare-pages.test.mjs (CI, against the
 * committed files) and check-static-export.mjs (after every static build,
 * against the build's own environment).
 *
 * Cloudflare syntax and limits, as documented on 2026-11-12:
 *   https://developers.cloudflare.com/pages/configuration/headers/
 *   https://developers.cloudflare.com/pages/configuration/redirects/
 *   https://developers.cloudflare.com/pages/platform/limits/
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONFIG_URL = new URL("../next.config.ts", import.meta.url).href;

/** Pages limits: 100 header rules, 2,000 chars per _headers line; 2,000 static + 100 dynamic redirects, 1,000 chars each. */
export const LIMITS = Object.freeze({
  headerRules: 100,
  headerLineChars: 2000,
  staticRedirects: 2000,
  dynamicRedirects: 100,
  redirectLineChars: 1000,
});

/** The id the static export prerenders each dynamic route's shell under (src/lib/route-param.ts). */
export const SHELL_PARAM = "_";

const REDIRECT_STATUSES = new Set([200, 301, 302, 303, 307, 308]);
const BUILD_SWITCHES = [
  "NEXT_PUBLIC_API_URL",
  "NEXT_PUBLIC_GOOGLE_DRIVE_PICKER",
  "KLORN_STATIC_EXPORT",
  "NEXT_DEV_DIST",
];

export function withoutKeys(env, keys) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !keys.includes(key)));
}

/**
 * The environment app.klorn.ai is built with: production, default API origin,
 * no Google Picker. Inferred from the CSP it served on 2026-11-12, which
 * connects to https://klorn-api.onrender.com and allows no apis.google.com.
 */
export const PRODUCTION_BUILD_ENV = Object.freeze({
  ...withoutKeys(process.env, BUILD_SWITCHES),
  NODE_ENV: "production",
});

const READ_CONFIG = `
const config = (await import(process.env.CF_PAGES_CONFIG_URL)).default;
process.stdout.write(JSON.stringify({
  output: config.output ?? null,
  headers: typeof config.headers === "function" ? await config.headers() : null,
  redirects: typeof config.redirects === "function" ? await config.redirects() : null,
}));
`;

/** The real next.config.ts, loaded in a fresh process (it reads env at import) with exactly `env`. */
export function loadNextConfig(env) {
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", READ_CONFIG],
    { env: { ...env, CF_PAGES_CONFIG_URL: CONFIG_URL }, encoding: "utf8", cwd: WEB_ROOT },
  );
  if (run.status !== 0) {
    throw new Error(`could not load next.config.ts: ${run.error?.message ?? run.stderr}`);
  }
  return JSON.parse(run.stdout);
}

// ---------------------------------------------------------------- _headers

const ALTERNATION = "([a-z0-9-]+(?:\\|[a-z0-9-]+)*)";
const ONE_OF = new RegExp(`^/:\\w+\\(${ALTERNATION}\\)$`);
const ONE_OF_AND_BELOW = new RegExp(`^/:\\w+\\(${ALTERNATION}\\)/:\\w+\\*$`);
const ONE_OF_PAYLOAD = new RegExp(`^/:\\w+\\(${ALTERNATION}\\)\\.txt$`);
const STATIC_PATH = /^\/[A-Za-z0-9\-._~/]*$/;
const STATIC_PREFIX_AND_BELOW = /^(\/[A-Za-z0-9\-._~/]*[A-Za-z0-9\-._~])\/:\w+\*$/;

/**
 * The Cloudflare paths that match exactly what a Next `source` matches. Only
 * the shapes next.config.ts uses are known; any other shape throws, so a new
 * rule cannot reach production without a reviewed translation.
 */
export function cloudflarePathsFor(source) {
  if (source === "/(.*)") return ["/*"];
  const oneOf = ONE_OF.exec(source);
  if (oneOf) return oneOf[1].split("|").map((name) => `/${name}`);
  // `/:rest*` is zero or more segments, so the bare prefix matches too.
  const andBelow = ONE_OF_AND_BELOW.exec(source);
  if (andBelow) return andBelow[1].split("|").flatMap((name) => [`/${name}`, `/${name}/*`]);
  const payload = ONE_OF_PAYLOAD.exec(source);
  if (payload) return payload[1].split("|").map((name) => `/${name}.txt`);
  const prefixAndBelow = STATIC_PREFIX_AND_BELOW.exec(source);
  if (prefixAndBelow) return [prefixAndBelow[1], `${prefixAndBelow[1]}/*`];
  if (STATIC_PATH.test(source)) return [source];
  throw new Error(
    `next.config.ts header source "${source}" has no Cloudflare translation — extend cloudflarePathsFor() and public/_headers together`,
  );
}

function assertUnconditional(rule, kind) {
  for (const key of ["has", "missing", "basePath", "locale"]) {
    if (rule[key] !== undefined) {
      throw new Error(
        `next.config.ts ${kind} "${rule.source}" uses "${key}", which _headers/_redirects cannot express`,
      );
    }
  }
}

/**
 * What _headers must hold: one block per Cloudflare path, later Next rules
 * overriding earlier ones per header (Next's behaviour). An empty value is how
 * next.config.ts suppresses a header; Cloudflare's equivalent is a detach
 * (`! Name`), represented here as value null.
 */
export function expectedHeaderBlocks(nextRules) {
  const byPath = new Map();
  for (const rule of nextRules) {
    assertUnconditional(rule, "header");
    for (const path of cloudflarePathsFor(rule.source)) {
      const headers = new Map(byPath.get(path) ?? []);
      for (const { key, value } of rule.headers) {
        headers.set(key.toLowerCase(), { name: key, value: value === "" ? null : value });
      }
      byPath.set(path, headers);
    }
  }
  return [...byPath].map(([path, headers]) => ({ path, headers: [...headers.values()] }));
}

const HEADER_LINE = /^([A-Za-z0-9-]+):\s*(.*)$/;
const DETACH_LINE = /^!\s+([A-Za-z0-9-]+)$/;

/** public/_headers as Cloudflare reads it: a path line, then indented `Name: value` / `! Name` lines. */
export function parseHeadersFile(text) {
  const blocks = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.replace(/\r$/, "");
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const where = `_headers line ${index + 1}`;
    if (!/^\s/.test(line)) {
      if (trimmed.startsWith("/") || trimmed.startsWith("https://")) {
        blocks.push({ path: trimmed, headers: [] });
        continue;
      }
      if (blocks.length === 0) throw new Error(`${where}: header "${trimmed}" before any path`);
      throw new Error(`${where}: header lines must be indented: "${trimmed}"`);
    }
    const block = blocks.at(-1);
    if (!block) throw new Error(`${where}: header "${trimmed}" before any path`);
    const detach = DETACH_LINE.exec(trimmed);
    if (detach) {
      block.headers.push({ name: detach[1], value: null });
      continue;
    }
    const header = HEADER_LINE.exec(trimmed);
    if (!header) throw new Error(`${where}: expected "name: value" or "! name", got "${trimmed}"`);
    block.headers.push({ name: header[1], value: header[2].trim() });
  }
  return blocks;
}

function describeValue(value) {
  return value === null ? "(detached)" : JSON.stringify(value);
}

/** Every way `actual` differs from `expected`; empty when they say the same thing. */
export function diffHeaderBlocks(expected, actual) {
  const differences = [];
  const actualByPath = new Map();
  for (const block of actual) {
    if (actualByPath.has(block.path)) differences.push(`${block.path}: appears twice in _headers`);
    actualByPath.set(block.path, block);
  }
  const expectedPaths = new Set(expected.map((block) => block.path));
  for (const block of actual) {
    if (!expectedPaths.has(block.path)) differences.push(`${block.path}: not in next.config.ts`);
  }
  for (const want of expected) {
    const have = actualByPath.get(want.path);
    if (!have) {
      differences.push(`${want.path}: missing from _headers`);
      continue;
    }
    const haveByName = new Map();
    for (const header of have.headers) {
      const name = header.name.toLowerCase();
      if (haveByName.has(name)) differences.push(`${want.path}: sets ${header.name} twice`);
      haveByName.set(name, header.value);
    }
    const wantNames = new Set(want.headers.map((header) => header.name.toLowerCase()));
    for (const header of have.headers) {
      if (!wantNames.has(header.name.toLowerCase())) {
        differences.push(`${want.path}: ${header.name} is not in next.config.ts`);
      }
    }
    for (const header of want.headers) {
      const name = header.name.toLowerCase();
      if (!haveByName.has(name)) {
        differences.push(
          `${want.path}: ${header.name} missing (want ${describeValue(header.value)})`,
        );
      } else if (haveByName.get(name) !== header.value) {
        differences.push(
          `${want.path}: ${header.name} is ${describeValue(haveByName.get(name))}, want ${describeValue(header.value)}`,
        );
      }
    }
  }
  return differences;
}

/** A Cloudflare path pattern as a RegExp: `*` greedy splat, `:name` one segment, the rest literal. */
export function cloudflarePattern(pattern) {
  const literal = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("(?<splat>.*)");
  return new RegExp(`^${literal.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`);
}

function sortedObject(entries) {
  return Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b)));
}

/** The headers Cloudflare attaches to `path`: every matching block in order, repeats joined with ", ". */
export function cloudflareHeadersFor(blocks, path) {
  const result = new Map();
  for (const block of blocks) {
    if (!cloudflarePattern(block.path).test(path)) continue;
    for (const { name, value } of block.headers) {
      const key = name.toLowerCase();
      if (value === null) result.delete(key);
      else result.set(key, result.has(key) ? `${result.get(key)}, ${value}` : value);
    }
  }
  return sortedObject(result);
}

const requireFromWeb = createRequire(join(WEB_ROOT, "package.json"));
const NEXT_PATH_MATCH = "next/dist/shared/lib/router/utils/path-match.js";

/** Next's own source matcher — an internal module, so a move gets a clear error. */
function nextPathMatch() {
  try {
    return requireFromWeb(NEXT_PATH_MATCH);
  } catch (error) {
    throw new Error(
      `${NEXT_PATH_MATCH} moved in this Next version; update nextHeadersFor(): ${error.message}`,
    );
  }
}

/** The headers next.config.ts gives `path`, matched by Next's own path matcher; later rules win, "" removes. */
export function nextHeadersFor(nextRules, path) {
  const { getPathMatch } = nextPathMatch();
  const result = new Map();
  for (const rule of nextRules) {
    const match = getPathMatch(rule.source, { strict: true, removeUnnamedParams: true });
    if (match(path) === false) continue;
    for (const { key, value } of rule.headers) {
      if (value === "") result.delete(key.toLowerCase());
      else result.set(key.toLowerCase(), value);
    }
  }
  return sortedObject(result);
}

// -------------------------------------------------------------- _redirects

/** public/_redirects as Cloudflare reads it; this repo always writes the status explicitly. */
export function parseRedirectsFile(text) {
  const rules = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.replace(/\r$/, "").trim();
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const where = `_redirects line ${index + 1}`;
    if (parts.length !== 3)
      throw new Error(`${where}: expected "source destination status", got "${line}"`);
    const status = Number(parts[2]);
    if (!REDIRECT_STATUSES.has(status)) throw new Error(`${where}: unsupported status ${parts[2]}`);
    rules.push({ from: parts[0], to: parts[1], status, line });
  }
  return rules;
}

/** next.config.ts redirects() as _redirects rules: Next answers 307/308 unless statusCode says otherwise. */
export function expectedRedirects(nextRedirects) {
  return nextRedirects.map((rule) => {
    assertUnconditional(rule, "redirect");
    for (const path of [rule.source, rule.destination]) {
      if (!STATIC_PATH.test(path)) {
        throw new Error(
          `next.config.ts redirect "${path}" is not a plain path — translate it into _redirects by hand`,
        );
      }
    }
    const status = rule.statusCode ?? (rule.permanent ? 308 : 307);
    return { from: rule.source, to: rule.destination, status };
  });
}

// ------------------------------------------------------------- app routes

const PAGE_FILES = ["page.tsx", "page.ts", "page.jsx", "page.js"];
const STATIC_PAGE = "page.static.tsx";
const DYNAMIC_PAGE = "page.dynamic.tsx";

function routeSegments(relativeDir) {
  return relativeDir === "" ? [] : relativeDir.split(sep).filter((part) => !/^\(.*\)$/.test(part));
}

/**
 * The routes the static export builds, read from src/app: every page (plain
 * `page.tsx` or the export-only `page.static.tsx`) and every dynamic segment
 * served through one shell. Private (`_x`) folders are not routes.
 */
export function appRoutes(appDir) {
  const pages = [];
  const shells = [];
  const visit = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    const segments = routeSegments(relative(appDir, dir));
    const route = `/${segments.join("/")}`;
    const hasStaticPage = files.has(STATIC_PAGE);
    const hasDynamicPage = files.has(DYNAMIC_PAGE);
    if (hasStaticPage || PAGE_FILES.some((name) => files.has(name))) {
      pages.push({ route, samplePath: route.replace(/\[(\w+)\]/g, "$1-sample") });
    }
    const dynamic = /^\[(\w+)\]$/.exec(segments.at(-1) ?? "");
    if (dynamic && (hasStaticPage || hasDynamicPage)) {
      const prefix = `/${segments.slice(0, -1).join("/")}/`.replace(/^\/\/$/, "/");
      if (prefix.includes("["))
        throw new Error(`${route}: nested dynamic shells are not supported`);
      shells.push({
        dir: relative(appDir, dir),
        prefix,
        param: dynamic[1],
        hasStaticPage,
        hasDynamicPage,
      });
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith("_")) visit(join(dir, entry.name));
    }
  };
  visit(appDir);
  return { pages, shells };
}

/**
 * The rules that serve every id from its route's one prerendered shell.
 * Cloudflare applies a redirect "regardless of whether or not an asset matches",
 * so `/email/:id` would swallow the real /email/candidates page; each static
 * sibling therefore rewrites to itself first (static rules match before
 * dynamic ones). `.txt` is the RSC payload Next's client router fetches on
 * in-app navigation in export mode, so it gets the same treatment. A trailing
 * slash 308s to the bare path, as Next does (Pages does it for real files,
 * but not for paths only a rewrite serves).
 */
export function expectedShellRules({ pages, shells }) {
  const passthrough = [];
  const rewrites = [];
  const ordered = [...shells].sort(
    (a, b) => b.prefix.length - a.prefix.length || a.prefix.localeCompare(b.prefix),
  );
  for (const shell of ordered) {
    const siblings = pages
      .map((page) => page.route)
      .filter((route) => route.startsWith(shell.prefix))
      .map((route) => route.slice(shell.prefix.length))
      .filter((name) => name !== "" && !name.includes("/") && !name.startsWith("["))
      .sort();
    for (const name of siblings) {
      const path = `${shell.prefix}${name}`;
      passthrough.push({ from: path, to: path, status: 200 });
      passthrough.push({ from: `${path}.txt`, to: `${path}.txt`, status: 200 });
    }
    const target = `${shell.prefix}${SHELL_PARAM}`;
    rewrites.push({ from: `${shell.prefix}:${shell.param}.txt`, to: `${target}.txt`, status: 200 });
    rewrites.push({ from: `${shell.prefix}:${shell.param}`, to: target, status: 200 });
    rewrites.push({
      from: `${shell.prefix}:${shell.param}/`,
      to: `${shell.prefix}:${shell.param}`,
      status: 308,
    });
  }
  return [...passthrough, ...rewrites];
}
