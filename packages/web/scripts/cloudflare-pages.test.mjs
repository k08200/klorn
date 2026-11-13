/**
 * public/_headers and public/_redirects are what Cloudflare Pages serves in
 * place of next.config.ts's headers() and redirects(), which a static export
 * cannot run (docs/deploy/cloudflare-pages.md). These tests load the REAL
 * next.config.ts and fail the moment the two drift apart — the headers are
 * the ones the CASA Tier 2 DAST of app.klorn.ai was run against.
 *
 * Run: node --test packages/web/scripts/cloudflare-pages.test.mjs   (Node 22.6+)
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  appRoutes,
  cloudflareHeadersFor,
  diffHeaderBlocks,
  expectedHeaderBlocks,
  expectedRedirects,
  expectedShellRules,
  LIMITS,
  loadNextConfig,
  nextHeadersFor,
  PRODUCTION_BUILD_ENV,
  parseHeadersFile,
  parseRedirectsFile,
  SHELL_PARAM,
  WEB_ROOT,
} from "./cloudflare-pages-rules.mjs";

const headersText = readFileSync(join(WEB_ROOT, "public/_headers"), "utf8");
const redirectsText = readFileSync(join(WEB_ROOT, "public/_redirects"), "utf8");
const production = loadNextConfig(PRODUCTION_BUILD_ENV);
const routes = appRoutes(join(WEB_ROOT, "src/app"));

test("the production config is the Next server build (headers and redirects present)", () => {
  assert.equal(production.output, null);
  assert.ok(Array.isArray(production.headers) && production.headers.length > 0);
  assert.ok(Array.isArray(production.redirects) && production.redirects.length > 0);
});

test("KLORN_STATIC_EXPORT=1 switches to output: export and drops headers()/redirects()", () => {
  const exported = loadNextConfig({ ...PRODUCTION_BUILD_ENV, KLORN_STATIC_EXPORT: "1" });
  assert.equal(exported.output, "export");
  assert.equal(exported.headers, null);
  assert.equal(exported.redirects, null);
  for (const value of ["", "0", "true", "yes", " 1"]) {
    const other = loadNextConfig({ ...PRODUCTION_BUILD_ENV, KLORN_STATIC_EXPORT: value });
    assert.equal(
      other.output,
      null,
      `KLORN_STATIC_EXPORT=${JSON.stringify(value)} must not export`,
    );
  }
});

test("_headers is exactly next.config.ts headers() for a production build", () => {
  const differences = diffHeaderBlocks(
    expectedHeaderBlocks(production.headers),
    parseHeadersFile(headersText),
  );
  assert.deepEqual(differences, []);
});

test("every route gets the same response headers from _headers as from next.config.ts", () => {
  const blocks = parseHeadersFile(headersText);
  const samples = [
    ...routes.pages.map((page) => page.samplePath),
    "/_next/static/chunks/main-0123abcd.js",
    "/icon-192.png",
    "/sw.js",
    "/email/0b6f9c1e-5d0e-4a51-9a39-2f0f7e8f1c11",
    "/email/candidates/0b6f9c1e",
    "/calendar/0b6f9c1e",
    "/inbox/firewall/deeper/still",
    "/inbox.txt",
    "/settings.txt",
    "/email/0b6f9c1e.txt",
    "/today.txt",
    "/does-not-exist",
  ];
  for (const path of samples) {
    assert.deepEqual(
      cloudflareHeadersFor(blocks, path),
      nextHeadersFor(production.headers, path),
      `headers differ for ${path}`,
    );
  }
});

test("the CSP Cloudflare serves is the pinned production policy", () => {
  // Same policy scripts/check-csp.mjs pins, and what app.klorn.ai served on
  // 2026-11-12 (curl -sI https://app.klorn.ai/).
  const csp = cloudflareHeadersFor(parseHeadersFile(headersText), "/")["content-security-policy"];
  assert.match(
    csp,
    /^default-src 'self'; script-src 'self' 'unsafe-inline' https:\/\/\*\.paddle\.com;/,
  );
  assert.match(
    csp,
    /connect-src 'self' https:\/\/klorn-api\.onrender\.com wss:\/\/klorn-api\.onrender\.com /,
  );
  assert.match(csp, /frame-ancestors 'none'; upgrade-insecure-requests$/);
});

const plain = (rules) => rules.map(({ from, to, status }) => ({ from, to, status }));

test("_redirects is next.config.ts redirects(), in order with the same status, then the shell rules", () => {
  const expected = expectedRedirects(production.redirects);
  assert.ok(
    expected.every((rule) => rule.status === 307),
    "next.config.ts redirects are 307s today",
  );
  assert.deepEqual(plain(parseRedirectsFile(redirectsText)), [
    ...expected,
    ...expectedShellRules(routes),
  ]);
});

test("every dynamic route has both build modes' pages and a Cloudflare rewrite to its shell", () => {
  assert.ok(routes.shells.length >= 3, "expected the email, candidate and calendar shells");
  for (const shell of routes.shells) {
    assert.ok(shell.hasStaticPage, `${shell.dir}: page.static.tsx missing (static export 404s)`);
    assert.ok(shell.hasDynamicPage, `${shell.dir}: page.dynamic.tsx missing (Next server 404s)`);
    const rules = plain(parseRedirectsFile(redirectsText));
    assert.ok(
      rules.some((rule) => rule.from === `${shell.prefix}:${shell.param}` && rule.status === 200),
      `${shell.prefix}:${shell.param} has no rewrite to its shell`,
    );
  }
});

test("the shell placeholder is the one the pages treat as 'read the id from the URL'", () => {
  const source = readFileSync(join(WEB_ROOT, "src/lib/route-param.ts"), "utf8");
  assert.match(source, new RegExp(`export const STATIC_SHELL_PARAM = "${SHELL_PARAM}";`));
});

test("rewrites only ever point inside the site (no open redirect, no external proxy)", () => {
  for (const rule of parseRedirectsFile(redirectsText)) {
    assert.match(
      rule.to,
      /^\/(?!\/)[A-Za-z0-9\-._~/:]*$/,
      `${rule.line}: destination must be a site path`,
    );
    assert.ok(!rule.to.includes("\\"), `${rule.line}: backslash in destination`);
  }
});

test("both files stay inside Cloudflare Pages' limits", () => {
  const blocks = parseHeadersFile(headersText);
  assert.ok(blocks.length <= LIMITS.headerRules, `${blocks.length} header rules`);
  for (const line of headersText.split("\n")) {
    assert.ok(
      line.length <= LIMITS.headerLineChars,
      `_headers line over ${LIMITS.headerLineChars}`,
    );
  }
  const rules = parseRedirectsFile(redirectsText);
  const dynamic = rules.filter((rule) => /[*:]/.test(rule.from));
  assert.ok(dynamic.length <= LIMITS.dynamicRedirects, `${dynamic.length} dynamic redirects`);
  assert.ok(rules.length - dynamic.length <= LIMITS.staticRedirects);
  for (const rule of rules) {
    assert.ok(
      rule.line.length <= LIMITS.redirectLineChars,
      `_redirects line too long: ${rule.line}`,
    );
  }
});

test("the parsers reject what Cloudflare would silently misread", () => {
  assert.throws(() => parseHeadersFile("X-Frame-Options: DENY\n"), /before any path/);
  assert.throws(() => parseHeadersFile("/*\nX-Frame-Options: DENY\n"), /indented/);
  assert.throws(() => parseHeadersFile("/*\n  X-Frame-Options DENY\n"), /name: value/);
  assert.throws(() => parseRedirectsFile("/a\n"), /source destination status/);
  assert.throws(() => parseRedirectsFile("/a /b 404\n"), /status/);
});
