#!/usr/bin/env node
/**
 * Blog structured-data language guard.
 *
 * Blog posts exist only in English (website/blog/<slug>/). The localized blog
 * listings (website/<locale>/blog/) introduce those same posts under
 * translated visible titles, and their JSON-LD used to carry the translated
 * titles too. That declared a French or Korean `headline` for a URL whose
 * content is English — structured data describing a page that does not exist.
 *
 * Decision (LOCKED): visible titles stay localized; structured data describes
 * the linked document as it is. So every BlogPosting/Article entry that points
 * at an English post must:
 *
 *   1. carry the post's own English `headline`, read from that post's page
 *   2. declare `"inLanguage": "en"`
 *
 * The English post pages themselves must also declare `"inLanguage": "en"`.
 *
 * Everything is derived from the filesystem: a new post or a new locale is
 * covered without editing this file.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "website";
const BLOG_DIR = join(ROOT, "blog");
const POST_URL = /^https:\/\/klorn\.ai\/blog\/([^/]+)\/$/;
const POST_TYPES = new Set(["BlogPosting", "Article"]);
const LD_JSON = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;

function readJsonLd(file) {
  const html = readFileSync(file, "utf8");
  return [...html.matchAll(LD_JSON)].map((match, i) => {
    try {
      return JSON.parse(match[1]);
    } catch (err) {
      throw new Error(`${file}: JSON-LD block #${i + 1} does not parse: ${err.message}`);
    }
  });
}

/** Every object in a JSON-LD tree whose @type is a post type. */
function collectPosts(node) {
  if (Array.isArray(node)) return node.flatMap(collectPosts);
  if (node === null || typeof node !== "object") return [];
  const self = POST_TYPES.has(node["@type"]) ? [node] : [];
  return [...self, ...Object.values(node).flatMap(collectPosts)];
}

function listPostSlugs() {
  return readdirSync(BLOG_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(BLOG_DIR, d.name, "index.html")))
    .map((d) => d.name);
}

function listListingPages() {
  const localized = readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(ROOT, d.name, "blog", "index.html"))
    .filter(existsSync);
  return [join(BLOG_DIR, "index.html"), ...localized];
}

function checkPostPages(slugs, errors) {
  const headlines = new Map();
  for (const slug of slugs) {
    const file = join(BLOG_DIR, slug, "index.html");
    const posts = readJsonLd(file).flatMap(collectPosts);
    if (posts.length === 0) {
      errors.push(`${file}: no Article/BlogPosting JSON-LD`);
      continue;
    }
    const [post] = posts;
    headlines.set(slug, post.headline);
    if (post.inLanguage !== "en") {
      errors.push(`${file}: inLanguage is ${JSON.stringify(post.inLanguage)}, expected "en"`);
    }
  }
  return headlines;
}

function checkListing(file, headlines, errors) {
  const entries = readJsonLd(file).flatMap(collectPosts);
  for (const entry of entries) {
    const slug = POST_URL.exec(entry.url ?? "")?.[1];
    if (!slug || !headlines.has(slug)) {
      errors.push(`${file}: entry url ${JSON.stringify(entry.url)} is not an English post`);
      continue;
    }
    const expected = headlines.get(slug);
    if (entry.headline !== expected) {
      errors.push(
        `${file}: ${slug} headline ${JSON.stringify(entry.headline)} != English ${JSON.stringify(expected)}`,
      );
    }
    if (entry.inLanguage !== "en") {
      errors.push(`${file}: ${slug} inLanguage is ${JSON.stringify(entry.inLanguage)}, expected "en"`);
    }
  }
  return entries.length;
}

function main() {
  const errors = [];
  const slugs = listPostSlugs();
  const headlines = checkPostPages(slugs, errors);
  const listings = listListingPages();
  const counts = listings.map((file) => `${file}=${checkListing(file, headlines, errors)}`);

  if (errors.length > 0) {
    console.error(`Blog JSON-LD guard: ${errors.length} problem(s)`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`Blog JSON-LD guard: ${slugs.length} posts, ${listings.length} listings OK (${counts.join(", ")})`);
}

main();
