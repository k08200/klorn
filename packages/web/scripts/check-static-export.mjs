#!/usr/bin/env node
/**
 * Smoke check for the static export (`pnpm --filter @klorn/web build:static`,
 * docs/deploy/cloudflare-pages.md). Runs right after `next build` writes out/,
 * in CI and in the Cloudflare Pages build, and fails the build when:
 *
 *   - a page Cloudflare must serve is missing (index, 404, each dynamic
 *     route's shell, each page a rewrite points at);
 *   - out/_headers no longer says what next.config.ts says for THIS build's
 *     environment — e.g. a different NEXT_PUBLIC_API_URL needs another CSP
 *     connect-src than the committed file carries;
 *   - out/_redirects drifts from next.config.ts redirects() or from src/app;
 *   - a file beside a shell would be swallowed by its `/prefix/:id` rewrite;
 *   - a dev-only route was exported.
 *
 * Run: node packages/web/scripts/check-static-export.mjs   (Node 22.6 or later)
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  appRoutes,
  diffHeaderBlocks,
  expectedHeaderBlocks,
  expectedRedirects,
  expectedShellRules,
  loadNextConfig,
  parseHeadersFile,
  parseRedirectsFile,
  SHELL_PARAM,
  WEB_ROOT,
  withoutKeys,
} from "./cloudflare-pages-rules.mjs";

const OUT = join(WEB_ROOT, "out");
const failures = [];

function check(ok, message) {
  if (ok) console.log(`✓ static export: ${message}`);
  else failures.push(message);
}

/** The file Cloudflare serves for a site path: `/a/b` → a/b.html, `/a/b.txt` → a/b.txt. */
function fileFor(sitePath) {
  const relativePath = sitePath.replace(/^\//, "");
  return join(OUT, relativePath.endsWith(".txt") ? relativePath : `${relativePath}.html`);
}

function sameRules(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

check(existsSync(OUT), "out/ exists");
for (const name of ["index.html", "404.html", "_headers", "_redirects"]) {
  check(existsSync(join(OUT, name)), `out/${name} exists`);
}
if (failures.length > 0) {
  console.error(`✗ static export:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}

// This build's own config, read the way next.config.ts would be by the Next
// server build of the same environment (the export switch off).
const config = loadNextConfig({
  ...withoutKeys(process.env, ["KLORN_STATIC_EXPORT"]),
  NODE_ENV: "production",
});
const headerDiff = diffHeaderBlocks(
  expectedHeaderBlocks(config.headers),
  parseHeadersFile(readFileSync(join(OUT, "_headers"), "utf8")),
);
check(
  headerDiff.length === 0,
  headerDiff.length === 0
    ? "_headers matches next.config.ts for this build's environment"
    : `_headers differs from next.config.ts for this build's environment:\n    ${headerDiff.join("\n    ")}`,
);

const rules = parseRedirectsFile(readFileSync(join(OUT, "_redirects"), "utf8"));
const routes = appRoutes(join(WEB_ROOT, "src/app"));
check(
  sameRules(
    rules.map(({ from, to, status }) => ({ from, to, status })),
    [...expectedRedirects(config.redirects), ...expectedShellRules(routes)],
  ),
  "_redirects is next.config.ts redirects() plus the shell rules for src/app's dynamic routes",
);

for (const rule of rules.filter((r) => r.status === 200)) {
  check(
    existsSync(fileFor(rule.to)),
    `${rule.from} → ${rule.to} is served (${fileFor(rule.to).slice(OUT.length + 1)})`,
  );
}

// Anything else Next wrote beside a shell would be rewritten to the shell.
const rewriteTargets = new Set(rules.filter((r) => r.status === 200).map((r) => r.to));
for (const shell of routes.shells) {
  const dir = join(OUT, shell.prefix);
  const strays = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => `${shell.prefix}${entry.name.replace(/\.html$/, "")}`)
        .filter((sitePath) => !rewriteTargets.has(sitePath))
    : [];
  check(
    strays.length === 0,
    strays.length === 0
      ? `nothing beside ${shell.prefix}${SHELL_PARAM} is hidden by its rewrite`
      : `hidden by the ${shell.prefix}:${shell.param} rewrite: ${strays.join(", ")}`,
  );
}

check(!existsSync(join(OUT, "dev")), "no dev-only route was exported");

if (failures.length > 0) {
  console.error(`✗ static export:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
