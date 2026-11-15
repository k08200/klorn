/**
 * The Team plan's numbers are one set everywhere. docs/design/pricing-tiers.md
 * is the founder's record (LOCKED 2026-11-11): $30 / seat / month, $26 / seat /
 * month billed annually ($312 / year), a $0.80 / seat / day pooled LLM target,
 * 2 to 150 self-serve seats. The code that quotes or enforces them — the
 * advertised constants the Team settings page shows (advertised-price.ts),
 * the Paddle price guard's expectations, the seat bounds of the API and the
 * web, and the seat-range copy in every locale — must say the same.
 *
 * The Pro price drifted across pages before its guard existed
 * (check-price-consistency.mjs); this is that guard for Team, in place before
 * any team price reaches the public site (the doc's copy rule). Static: no
 * network, no Paddle.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_SEATS as WEB_MAX_SEATS,
  MIN_SEATS as WEB_MIN_SEATS,
} from "../../../web/src/app/settings/_sections/org/model";
import {
  TEAM_STANDARD_SEAT_ANNUAL_CENTS,
  TEAM_STANDARD_SEAT_ANNUAL_PER_MONTH_CENTS,
  TEAM_STANDARD_SEAT_MONTHLY_CENTS,
} from "../billing/advertised-price.js";
import { compareTeamPaddlePrice } from "../billing/paddle-team-price-check.js";
import { MAX_SELF_SERVE_SEATS, MIN_TEAM_SEATS } from "../org/org-shape.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const doc = readFileSync(join(repo, "docs", "design", "pricing-tiers.md"), "utf8");

const CENTS = 100;
const DAYS_PER_MONTH_IN_DOC = 30;

/** The doc from its Team section on: the individual plans table reuses row labels. */
const teamSection = doc.slice(doc.indexOf("## Team (company) plan"));

/** The Team table's standard-seat cell for a row ("| Price, monthly billing | $30 / seat / month | …"). */
function standardCell(rowLabel: string): string {
  const row = teamSection.split("\n").find((line) => line.startsWith(`| ${rowLabel} |`));
  if (!row) throw new Error(`pricing-tiers.md: no "${rowLabel}" row`);
  return row.split("|")[2]?.trim() ?? "";
}

function dollars(text: string, pattern: RegExp): number {
  const match = text.match(pattern);
  if (!match?.[1]) throw new Error(`pricing-tiers.md: ${pattern} not found in "${text}"`);
  return Number(match[1]);
}

const docMonthly = dollars(
  standardCell("Price, monthly billing"),
  /^\$(\d+(?:\.\d+)?) \/ seat \/ month/,
);
const annualCell = standardCell("Price, annual billing");
const docAnnualPerMonth = dollars(annualCell, /^\$(\d+(?:\.\d+)?) \/ seat \/ month/);
const docAnnual = dollars(annualCell, /\(\$(\d+(?:\.\d+)?) \/ year\)/);
const docTarget = dollars(standardCell("Internal LLM target"), /^\$(\d+\.\d+) \/ seat \/ day/);
const seatsLine = doc.match(/Seats: minimum (\d+), self-serve maximum (\d+)\./);

describe("Team prices: pricing-tiers.md against the code", () => {
  it("reads the standard seat from the doc", () => {
    expect([docMonthly, docAnnualPerMonth, docAnnual, docTarget]).toEqual([30, 26, 312, 0.8]);
    expect(seatsLine?.slice(1).map(Number)).toEqual([2, 150]);
  });

  it("quotes the doc's prices on the Team settings page and in the Paddle guard", () => {
    expect(TEAM_STANDARD_SEAT_MONTHLY_CENTS).toBe(Math.round(docMonthly * CENTS));
    expect(TEAM_STANDARD_SEAT_ANNUAL_PER_MONTH_CENTS).toBe(Math.round(docAnnualPerMonth * CENTS));
    expect(TEAM_STANDARD_SEAT_ANNUAL_CENTS).toBe(Math.round(docAnnual * CENTS));
    // The doc's own arithmetic: $26 a month, billed as one $312 charge.
    expect(docAnnualPerMonth * 12).toBe(docAnnual);

    // The price guard accepts exactly the doc's amounts on the doc's cycles.
    const priceAt = (cents: number, interval: string) => ({
      status: "active",
      unit_price: { amount: String(cents), currency_code: "USD" },
      billing_cycle: { interval, frequency: 1 },
      quantity: { minimum: MIN_TEAM_SEATS, maximum: MAX_SELF_SERVE_SEATS },
    });
    expect(
      compareTeamPaddlePrice({ interval: "month", price: priceAt(docMonthly * CENTS, "month") }).ok,
    ).toBe(true);
    expect(
      compareTeamPaddlePrice({ interval: "year", price: priceAt(docAnnual * CENTS, "year") }).ok,
    ).toBe(true);
    expect(
      compareTeamPaddlePrice({
        interval: "year",
        price: priceAt(docAnnualPerMonth * CENTS, "year"),
      }).ok,
    ).toBe(false);
  });

  it("bounds seats the same in the doc, the API and the web", () => {
    const [min, max] = seatsLine?.slice(1).map(Number) ?? [];
    expect([MIN_TEAM_SEATS, MAX_SELF_SERVE_SEATS]).toEqual([min, max]);
    expect([WEB_MIN_SEATS, WEB_MAX_SEATS]).toEqual([min, max]);
  });

  it("states the seat range the doc sets in every locale's seat copy", () => {
    const [min, max] = seatsLine?.slice(1) ?? [];
    const localesDir = join(repo, "packages", "web", "src", "lib", "locales");
    const locales = readdirSync(localesDir).filter((name) => name.endsWith(".ts"));
    expect(locales.length).toBe(7);
    for (const file of locales) {
      const source = readFileSync(join(localesDir, file), "utf8");
      for (const key of ["settings.org.checkout.seats", "settings.org.error.INVALID_SEATS"]) {
        const value = source.match(new RegExp(`"${key.replace(/\./g, "\\.")}":\\s*"([^"]+)"`));
        expect(value?.[1], `${file} ${key}`).toMatch(new RegExp(`${min}\\D+${max}`));
      }
    }
  });

  it("keeps the margin table on the $0.80 pooled seat target", () => {
    const ceiling = Math.round(docTarget * DAYS_PER_MONTH_IN_DOC);
    for (const product of [
      `Team standard, $${docMonthly} monthly`,
      `Team standard, $${docAnnualPerMonth} annual`,
    ]) {
      const row = doc.split("\n").find((line) => line.startsWith(`| ${product} |`));
      expect(row, product).toBeDefined();
      expect(row?.split("|")[3]?.trim(), product).toBe(`$${ceiling}`);
    }
  });

  it("puts only the doc's per-seat prices on the public pricing pages", () => {
    // Team prices are not on the public site yet (pricing-tiers.md "Copy
    // rules"). When they are, every per-seat amount on a pricing page must be
    // one of the doc's. Competitor prices in blog posts are out of scope.
    const allowed = new Set([docMonthly, docAnnualPerMonth, docAnnual]);
    const pages = [join(repo, "website", "pricing", "index.html")];
    for (const dir of readdirSync(join(repo, "website"), { withFileTypes: true })) {
      const localized = join(repo, "website", dir.name, "pricing", "index.html");
      if (dir.isDirectory()) {
        try {
          readFileSync(localized);
          pages.push(localized);
        } catch {
          // no localized pricing page in this directory
        }
      }
    }
    for (const page of pages) {
      const html = readFileSync(page, "utf8");
      for (const [, amount] of html.matchAll(/\$\s?(\d+(?:[.,]\d+)?)\s*(?:\/|per)\s*seat/gi)) {
        expect(allowed.has(Number(amount?.replace(",", "."))), `${page}: $${amount}/seat`).toBe(
          true,
        );
      }
    }
  });
});
