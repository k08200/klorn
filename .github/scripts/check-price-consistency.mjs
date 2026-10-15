#!/usr/bin/env node
/**
 * The advertised price must be one number everywhere, and the native price
 * must never undercut the web one.
 *
 * Two failures this exists for, both of which shipped:
 *
 *   2026-08-12 — the app advertised $7.99 while Paddle, the Terms page and
 *   both landings said $8.99. Customers were quoted a price nobody charged.
 *   lib/pricing.ts was created to fix it, but nothing stopped the static
 *   pages under website/ from drifting away from it again — they import
 *   nothing.
 *
 *   2026-10-14 — the web price went $8.99 → $29.99 and PRO_PRICE_NATIVE stayed
 *   $9.99, leaving the native paywall quoting a third of the web price. Not a
 *   discount; two different public prices for one product.
 *
 * So: lib/pricing.ts is the source of truth, every static page is compared
 * against it, and native >= web is asserted. de/fr write prices in European
 * format (29,99 $, not $29.99) and a naive /\$[\d.]+/ sweep silently skips them —
 * both forms are matched here on purpose.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PRICING_TS = "packages/web/src/lib/pricing.ts";

/** Pull a `export const NAME = "$12.34";` literal out of pricing.ts. */
function readConst(source, name) {
  const match = source.match(
    new RegExp(`export const ${name}\\s*=\\s*"([^"]+)"`),
  );
  if (!match) throw new Error(`${PRICING_TS}: ${name} not found`);
  return match[1];
}

/** Dollars in "$29.99", "$34.99" or "29,99 $" — the de/fr form included. */
function amount(price) {
  const parsed = Number(price.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Unparseable price string: ${price}`);
  }
  return parsed;
}

const source = readFileSync(PRICING_TS, "utf8");
const web = readConst(source, "PRO_PRICE_WEB");
const native = readConst(source, "PRO_PRICE_NATIVE");

const problems = [];

if (amount(native) < amount(web)) {
  problems.push(
    `${PRICING_TS}: PRO_PRICE_NATIVE (${native}) is below PRO_PRICE_WEB (${web}). ` +
      `The store takes a cut, so native is never the cheaper surface — and two ` +
      `public prices for one product is the 2026-08-12 bug wearing a new hat.`,
  );
}

// Every price-like string on a page we publish, in both notations. Tolerates
// "$29.99/mo", "29,99 $ im Monat", "<strong>$29.99</strong>/month".
const PRICE = /(?:\$\s?(\d+(?:[.,]\d{2})?)|(\d+(?:[.,]\d{2})?)\s?\$)/g;

const webAmount = amount(web);

/** Every index.html under website/, without pulling in a glob dependency. */
function pagesUnder(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...pagesUnder(path));
    else if (entry.name === "index.html") found.push(path);
  }
  return found;
}

const pages = pagesUnder("website").sort();
if (pages.length === 0) problems.push("no website/**/index.html found");

/**
 * Prices Klorn used to charge. No competitor publishes these, so any
 * occurrence anywhere on a published page is ours and is stale.
 *
 * This is the half that catches what selectors cannot. A security review of
 * the first version of this script mutation-tested it and got a clean pass
 * after planting $8.99 in the JSON-LD Offer, the meta/og/twitter
 * descriptions, the pricing headline and the trial line — none of which any
 * selector below reaches. The JSON-LD Offer is the worst of those to miss,
 * because search engines read it and show it.
 *
 * $9.99 is NOT listed: it is Google AI Plus's published price and appears in
 * competitor tables. The retired native price is covered by the native >= web
 * assertion above instead.
 */
const RETIRED_PRICES = ["8.99", "7.99"];

const SELF = ".github/scripts/check-price-consistency.mjs";

/**
 * Pages that are supposed to state Klorn's own price. If one of these yields
 * no price at all, the selectors above have gone blind rather than the page
 * having become correct.
 */
const QUOTES_A_PRICE =
  /^website\/(?:[a-z]{2}\/)?(?:index\.html|next\/index\.html|pricing\/index\.html|(?:[a-z]{2}\/)?vs\/[^/]+\/index\.html)$/;

for (const page of pages) {
  const html = readFileSync(page, "utf8");

  // 1. Structured places that state OUR price, where an exact match is
  //    required. Competitor tables sit outside these and are left alone.
  //    `class='us'` is matched as well as `class="us"`: the single-quoted form
  //    also passed the first version of this guard.
  //    `td.us` is a general "Klorn's side" class, also used on /self-host/,
  //    /security/ and in blog tables — scoping to the whole cell would fail
  //    the build the first time one of those mentions "a $5 VPS". Only the
  //    price row is read, in the four languages that label it.
  const priceRows = [
    ...html.matchAll(
      /<tr><th>(?:Price|Published price|공개 가격|가격)<\/th>([\s\S]*?)<\/tr>/g,
    ),
  ].map((m) => m[1]);

  const ours = [
    ...html.matchAll(/<div class="amt[^"]*">([\s\S]*?)<\/div>/g),
    ...html.matchAll(/<a href="\/pricing\/">([^<]*)</g),
    // Inside a price row, only OUR column. The other cell is the competitor's
    // published price and is none of this guard's business.
    ...priceRows.flatMap((row) => [
      ...row.matchAll(/<td class=['"]us['"]>(?:(?!<\/td>)[\s\S])*?<\/td>/g),
    ]),
  ].map((m) => m[0]);

  let seen = 0;
  const reported = new Set();
  for (const fragment of ours) {
    for (const hit of fragment.matchAll(PRICE)) {
      const raw = (hit[1] ?? hit[2]).replace(",", ".");
      if (Number(raw) === 0) continue; // the free tier card, "$0" or "$0.00"
      seen += 1;
      if (Number(raw) !== webAmount) {
        // A vs-page price row contains the /pricing/ link, so the same number
        // matches twice. Report it once.
        const key = `${page}:${raw}`;
        if (reported.has(key)) continue;
        reported.add(key);
        problems.push(
          `${page}: quotes $${raw} as Klorn's price, but ${PRICING_TS} says ${web}`,
        );
      }
    }
  }

  // A page that states a price must have been read, or this guard is green
  // because its selectors stopped matching rather than because the price is
  // right. Markup changes are exactly when that happens — and the P11a
  // rebuild is rewriting these pages now.
  if (seen === 0 && QUOTES_A_PRICE.test(page)) {
    problems.push(
      `${page}: no Klorn price found to check. The markup moved and this ` +
        `guard went blind on it — update the selectors in ${SELF}.`,
    );
  }

  // JSON-LD carries a bare number ("30.00"), which PRICE does not match
  // because it has no currency sign. Check those separately.
  for (const hit of html.matchAll(/"price"\s*:\s*"([^"]*)"/g)) {
    const raw = hit[1].replace(",", ".");
    if (!/^\d+(\.\d+)?$/.test(raw)) {
      problems.push(`${page}: JSON-LD price is not a number: ${hit[1]}`);
    } else if (Number(raw) === 0) {
      // The Free tier ships its own Offer at 0. That is correct and fixed.
    } else if (Number(raw) !== webAmount) {
      problems.push(
        `${page}: JSON-LD offer price is ${raw}, but ${PRICING_TS} says ${web}`,
      );
    }
  }

  // 2. Anywhere at all: a price we no longer charge.
  for (const retired of RETIRED_PRICES) {
    if (html.includes(retired)) {
      problems.push(
        `${page}: still contains the retired price ${retired} — it is no ` +
          `longer what anyone is charged, and no competitor publishes it`,
      );
    }
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}

console.log(
  `price consistency: ${web} web / ${native} native, ` +
    `and ${pages.length} published page(s) agree with ${PRICING_TS}.`,
);
