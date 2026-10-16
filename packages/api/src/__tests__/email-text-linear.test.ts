import { describe, expect, it } from "vitest";
import {
  coercePlainBody,
  countMarkupTokens,
  htmlToPlainText,
  trimBlanksBeforeNewlines,
} from "../mail/email-text.js";

// Two regexes in this module backtracked quadratically on sender-controlled
// text, on the single API event loop (measured 2026-10-16):
//   - the raw-HTML detector /<\/?(?:…)[^>]*>|style="/gi on the plain body of
//     EVERY persisted email: "<div" × 32k (128 KB) took 1.9 s, and it had no
//     input cap;
//   - the tidy /[ \t]+\n/g in htmlToPlainText (Gmail HTML-only bodies at sync):
//     128k spaces took 10.3 s.
// Both are now linear scanners. The differential tests pin them to the old
// regexes' exact results on inputs where the regexes are still fast.

const OLD_MARKUP_TOKEN = /<\/?(?:table|tbody|tr|td|div|p|span|h[1-6]|img|br|a\s)[^>]*>|style="/gi;
const oldCount = (text: string) => text.match(OLD_MARKUP_TOKEN)?.length ?? 0;
const oldTidy = (text: string) => text.replace(/[ \t]+\n/g, "\n");

// Deterministic PRNG (mulberry32) so a failure reproduces.
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = [
  "<",
  ">",
  "/",
  "</",
  "div",
  "DIV",
  "p",
  "pre",
  "P",
  "a",
  "a ",
  "A\t",
  "a ",
  "ab",
  "tbody",
  "TR",
  "td",
  "table",
  "span",
  "img",
  "br",
  "BR",
  "h1",
  "H6",
  "h7",
  "h",
  'style="',
  'STYLE="',
  "style",
  "=",
  '"',
  " ",
  "\t",
  "\n",
  "x",
  "é",
  "İ",
  "ſ",
];

function randomText(next: () => number, maxParts: number): string {
  const parts = Math.floor(next() * maxParts);
  let out = "";
  for (let i = 0; i < parts; i++) out += FRAGMENTS[Math.floor(next() * FRAGMENTS.length)];
  return out;
}

const BUDGET_MS = 300;

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

describe("raw-HTML detection is linear and matches the old regex", () => {
  it("counts exactly what the old regex counted (5,000 seeded random inputs)", () => {
    const next = rng(20261016);
    for (let i = 0; i < 5000; i++) {
      const text = randomText(next, 40);
      expect(countMarkupTokens(text, Number.POSITIVE_INFINITY), JSON.stringify(text)).toBe(
        oldCount(text),
      );
    }
  });

  it("matches the old regex on every short sequence of tricky atoms, at every limit", () => {
    // Exhaustive, not sampled: Unicode whitespace after "a" (\s), single letters
    // that let a name break mid-way, non-ASCII letters /i must NOT fold
    // (ſ → s, Kelvin K → k), '</', '>' and the style=" attribute.
    const atoms = [
      "<",
      "</",
      ">",
      "a",
      "\u00a0",
      "\u2028",
      "\ufeff",
      "s",
      "t",
      "ſ",
      "K",
      'style="',
    ];
    const check = (text: string) => {
      const old = oldCount(text);
      expect(countMarkupTokens(text, Number.POSITIVE_INFINITY), JSON.stringify(text)).toBe(old);
      for (let limit = 1; limit <= 6; limit++) {
        expect(countMarkupTokens(text, limit)).toBe(Math.min(old, limit));
      }
    };
    const walk = (prefix: string, depth: number) => {
      check(prefix);
      if (depth === 0) return;
      for (const atom of atoms) walk(prefix + atom, depth - 1);
    };
    walk("", 4);
    for (const text of [
      "<span>",
      "<ſpan>",
      "<a\u00a0>",
      "<a\u2028>",
      "<K>",
      "<tr\ufeff>",
      "<h0><h7><h1>",
    ]) {
      check(text);
    }
  });

  it("stops at the limit it is given", () => {
    expect(countMarkupTokens("<p>".repeat(100), 5)).toBe(5);
  });

  it("decides hostile plain bodies within budget", () => {
    // 1 MB each: no '>' anywhere; "<a " runs; one '>' only at the very end.
    for (const hostile of [
      "<div".repeat(250_000),
      "<a ".repeat(330_000),
      `${"<div ".repeat(200_000)}>`,
    ]) {
      const { ms } = timed(() => coercePlainBody(hostile, null));
      expect(ms).toBeLessThan(BUDGET_MS);
    }
  });
});

describe("htmlToPlainText's whitespace tidy is linear and matches the old regex", () => {
  it("tidies exactly as the old regex did (5,000 seeded random inputs)", () => {
    const next = rng(42);
    for (let i = 0; i < 5000; i++) {
      const text = randomText(next, 40);
      expect(trimBlanksBeforeNewlines(text), JSON.stringify(text)).toBe(oldTidy(text));
    }
  });

  it("projects a hostile HTML body within budget", () => {
    const hostile = `<p>${" ".repeat(400_000)}x</p>`;
    const { value, ms } = timed(() => htmlToPlainText(hostile));
    expect(value).toBe("x");
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});
