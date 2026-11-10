#!/usr/bin/env node
/**
 * Sitemap coverage guard.
 *
 * `website/sitemap.xml` is hand-maintained, like the landings themselves, and
 * it had drifted into being exactly wrong in both directions at once:
 *
 *   - it submitted /privacy/, /terms/ and /refund/, which are fourteen-line
 *     redirect stubs carrying `noindex` and a canonical pointing at
 *     app.klorn.ai. Submitting a noindex URL earns a Search Console error and
 *     spends crawl budget on a page we have asked not to be indexed.
 *   - it omitted all ten /vs/* and /open-source/ pages (#1219), whose entire
 *     reason to exist is being found by someone searching for a competitor.
 *
 * Ten pages built to be discovered were invisible to the file whose only job
 * is to declare what exists, while three pages that must not be indexed were
 * declared. Nothing failed, because nothing was checking.
 *
 * Three assertions, derived from the filesystem rather than a list anyone has
 * to remember to update:
 *
 *   1. every indexable page appears in the sitemap
 *   2. no `noindex` page appears in the sitemap
 *   3. every <loc> resolves to a page that exists
 *   4. each entry's hreflang set is exactly the one its page declares
 *
 * (4) holds for all 17 entries today. It is cheap to keep true and silent to
 * break: a sitemap that advertises a translation the page does not claim back
 * is a non-reciprocal annotation, which Google drops without reporting.
 *
 * A page opts out by carrying `noindex`, which is the same signal robots read —
 * so the sitemap and the pages cannot disagree about intent.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = "website";
const SITEMAP = join(ROOT, "sitemap.xml");
const ORIGIN = "https://klorn.ai";

/** Every index.html under website/, as the URL path it will be served at. */
function pages(dir = ROOT, found = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      pages(full, found);
      continue;
    }
    if (entry.name !== "index.html") continue;
    const rel = relative(ROOT, dir).split(sep).filter(Boolean).join("/");
    const url = rel ? `/${rel}/` : "/";
    const html = readFileSync(full, "utf8");
    found.set(url, {
      file: full,
      noindex: /name=["']robots["'][^>]*noindex/i.test(html),
    });
  }
  return found;
}

let sitemapXml;
try {
  sitemapXml = readFileSync(SITEMAP, "utf8");
} catch {
  console.error(`::error::${SITEMAP} is missing`);
  process.exit(1);
}

const strip = (href) =>
  href.startsWith(ORIGIN) ? href.slice(ORIGIN.length) || "/" : href;

/** Each <url> as {path, alternates}, alternates as "hreflang href" strings. */
const entries = [...sitemapXml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((block) => ({
  path: strip(/<loc>\s*([^<\s]+)\s*<\/loc>/.exec(block[1])?.[1] ?? ""),
  alternates: new Set(
    [...block[1].matchAll(/hreflang="([^"]+)"\s+href="([^"]+)"/g)].map(
      (m) => `${m[1]} ${m[2]}`,
    ),
  ),
}));
const listed = new Set(entries.map((e) => e.path));

const found = pages();
const problems = [];

for (const [url, meta] of found) {
  if (meta.noindex && listed.has(url)) {
    problems.push(`${url} carries noindex (${meta.file}) but is submitted in the sitemap`);
  }
  if (!meta.noindex && !listed.has(url)) {
    problems.push(`${url} is indexable (${meta.file}) but missing from the sitemap`);
  }
}

for (const { path, alternates } of entries) {
  const meta = found.get(path);
  if (!meta) {
    problems.push(`sitemap lists ${path}, which has no index.html`);
    continue;
  }
  const declared = new Set(
    [...readFileSync(meta.file, "utf8").matchAll(
      /<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"/g,
    )].map((m) => `${m[1]} ${m[2]}`),
  );
  const onlySitemap = [...alternates].filter((a) => !declared.has(a));
  const onlyPage = [...declared].filter((a) => !alternates.has(a));
  for (const a of onlySitemap) {
    problems.push(`${path}: sitemap claims alternate "${a}", the page does not`);
  }
  for (const a of onlyPage) {
    problems.push(`${path}: page declares alternate "${a}", the sitemap does not`);
  }
}

if (problems.length) {
  console.error("::error::sitemap drift");
  for (const p of problems.sort()) console.error(`✗ ${p}`);
  console.error("");
  console.error("A page opts out of the sitemap by carrying noindex — not by being");
  console.error("left out of it. Add the page, or add the noindex, so the two agree.");
  process.exit(1);
}

const indexable = [...found.values()].filter((m) => !m.noindex).length;
console.log(
  `✓ sitemap: ${indexable} indexable page(s) all submitted, ` +
    `${found.size - indexable} noindex page(s) correctly withheld, no dead entries.`,
);
