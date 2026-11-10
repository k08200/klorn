#!/usr/bin/env node
/**
 * IndexNow submitter.
 *
 * Why this exists: Google is no longer the only mouth that has to be fed.
 * ChatGPT Search resolves citations through Bing's index, so a page Bing has
 * not crawled cannot be cited no matter how quotable it is. IndexNow is the
 * push channel Bing, Yandex, Seznam and Naver all consume — it turns "wait
 * for a crawler" into "tell them the moment it deploys".
 *
 * Called from website.yml after the Pages deploy, with the URLs derived from
 * the pushed commit range so we only submit what actually changed. Submitting
 * unchanged URLs is not an error, but it burns the endpoint's goodwill.
 *
 * Failure is non-fatal by design: a 4xx from one search engine must never
 * fail a deploy that already succeeded.
 */

import { readdirSync } from "node:fs";
import { execSync } from "node:child_process";

const HOST = "klorn.ai";
const ORIGIN = `https://${HOST}`;
const ENDPOINT = "https://api.indexnow.org/IndexNow";

/** The key is the basename of the single <32hex>.txt file at website/ root. */
function findKey() {
  const hit = readdirSync("website").find((f) => /^[0-9a-f]{32}\.txt$/.test(f));
  if (!hit) throw new Error("no IndexNow key file at website/<32hex>.txt");
  return hit.replace(/\.txt$/, "");
}

/** Changed website/ paths in this push, mapped to public URLs. */
function changedUrls() {
  const before = process.env.BEFORE_SHA;
  const after = process.env.AFTER_SHA || "HEAD";
  // A first push (or a force-push) has no usable base — fall back to the
  // single commit rather than diffing against the zero sha.
  const range =
    before && !/^0+$/.test(before) ? `${before}..${after}` : `${after}~1..${after}`;
  let out = "";
  try {
    out = execSync(`git diff --name-only ${range} -- website/`, { encoding: "utf8" });
  } catch {
    return [];
  }
  const urls = new Set();
  for (const line of out.split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (line.endsWith("/index.html")) {
      const dir = line.replace(/^website\//, "").replace(/index\.html$/, "");
      urls.add(`${ORIGIN}/${dir}`);
    } else if (line === "website/index.html") {
      urls.add(`${ORIGIN}/`);
    }
  }
  return [...urls];
}

const urls = changedUrls();
if (urls.length === 0) {
  console.log("IndexNow: no page changes in this push — nothing to submit.");
  process.exit(0);
}

const body = { host: HOST, key: findKey(), keyLocation: `${ORIGIN}/${findKey()}.txt`, urlList: urls };
console.log(`IndexNow: submitting ${urls.length} URL(s)`);
for (const u of urls) console.log(`  ${u}`);

const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify(body),
});
// 200 accepted, 202 accepted-pending-key-verification. Anything else is
// reported and swallowed: the deploy already happened.
console.log(`IndexNow: HTTP ${res.status}`);
if (![200, 202].includes(res.status)) {
  console.log(`::warning::IndexNow responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
