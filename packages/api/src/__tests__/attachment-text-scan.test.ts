import { describe, expect, it } from "vitest";
import {
  collectPdfLiteralStrings,
  collectTextRuns,
  collectWordTextRuns,
  replaceNamespacedClosingTag,
  replaceNamespacedSelfClosingTag,
  replaceSelfClosingTag,
  stripTags,
} from "../mail/attachment-text-scan.js";
import { expectLinear, repeatTo } from "./helpers/linear-timing.js";

/**
 * The regexes the scanners replace. They are the oracle: on short inputs they
 * are fast, and every scanner must return exactly what its regex returned.
 */
const LEGACY = {
  stripTags: (s: string) => s.replace(/<[^>]+>/g, " "),
  wordTab: (s: string) => s.replace(/<w:tab\b[^>]*\/>/g, "\t"),
  wordBr: (s: string) => s.replace(/<w:br\b[^>]*\/>/g, "\n"),
  wordRuns: (s: string) => Array.from(s.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g), (m) => m[1]),
  textRuns: (s: string) =>
    Array.from(s.matchAll(/<[^:>\s]*:?t\b[^>]*>([\s\S]*?)<\/[^:>\s]*:?t\b[^>]*>/gi), (m) => m[1]),
  hwpxTab: (s: string) => s.replace(/<[^:>]*:?tab\b[^>]*\/>/g, "\t"),
  hwpxLineBreak: (s: string) => s.replace(/<[^:>]*:?lineBreak\b[^>]*\/>/g, "\n"),
  hwpxBr: (s: string) => s.replace(/<[^:>]*:?br\b[^>]*\/>/g, "\n"),
  hwpxP: (s: string) => s.replace(/<\/[^:>]*:?p>/g, "\n"),
  hwpxTr: (s: string) => s.replace(/<\/[^:>]*:?tr>/g, "\n"),
  hwpxTc: (s: string) => s.replace(/<\/[^:>]*:?tc>/g, "\t"),
  pdfLiterals: (s: string) =>
    Array.from(s.matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)/g), (m) => m[1]),
};

/** Seeded so a failure reproduces; the high bits of an LCG are the random ones. */
function randomInputs(tokens: string[], seed: number, count = 4000, maxTokens = 24): string[] {
  let state = seed >>> 0;
  const next = (limit: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state >>> 16) % limit;
  };
  return Array.from({ length: count }, () =>
    Array.from({ length: next(maxTokens + 1) }, () => tokens[next(tokens.length)]).join(""),
  );
}

function expectSameOnAll<T>(
  inputs: string[],
  scan: (s: string) => T,
  legacy: (s: string) => T,
): void {
  for (const input of inputs) {
    expect({ input, out: scan(input) }).toEqual({ input, out: legacy(input) });
  }
}

const SELF_CLOSING_TOKENS = [
  "<w:tab",
  "<w:tabs",
  "<w:br",
  "<",
  ">",
  "/",
  "/>",
  " ",
  "a",
  "_",
  "\n",
];
const WORD_RUN_TOKENS = [
  "<w:t",
  "<w:t>",
  "<w:tab",
  "</w:t>",
  "</w:t",
  ">",
  "<",
  "/",
  "x",
  " ",
  "_",
];
const TEXT_RUN_TOKENS = [
  "<",
  "</",
  ">",
  "t",
  "T",
  ":",
  " ",
  " ",
  "　",
  "a",
  "s",
  "/",
  "_",
  "-",
  "\n",
  "<t>",
  "</t>",
  "<a:t>",
  "</a:t>",
  "<sst>",
  "tx",
];
const HWPX_SELF_CLOSING_TOKENS = [
  "<",
  ">",
  "/",
  "/>",
  ":",
  "tab",
  "tabs",
  "br",
  "lineBreak",
  "a",
  " ",
  "_",
  "\n",
  "<hp:tab/>",
];
const HWPX_CLOSING_TOKENS = ["</", "<", ">", ":", "p", "tr", "tc", "a", " ", "/", "</hp:p>", "\n"];
const PDF_TOKENS = ["(", ")", "\\", "\\(", "\\)", "a", " ", "\n", "\r", " ", "\\\n", "\\\r"];

describe("attachment text scanners return exactly what the old regexes returned", () => {
  it("stripTags", () => {
    expectSameOnAll(
      randomInputs(["<", ">", "<>", "a", " ", "\n", "/"], 1),
      stripTags,
      LEGACY.stripTags,
    );
  });

  it("replaceSelfClosingTag for <w:tab/> and <w:br/>", () => {
    const inputs = randomInputs(SELF_CLOSING_TOKENS, 2);
    expectSameOnAll(inputs, (s) => replaceSelfClosingTag(s, "<w:tab", "\t"), LEGACY.wordTab);
    expectSameOnAll(inputs, (s) => replaceSelfClosingTag(s, "<w:br", "\n"), LEGACY.wordBr);
  });

  it("collectWordTextRuns", () => {
    expectSameOnAll(randomInputs(WORD_RUN_TOKENS, 3), collectWordTextRuns, LEGACY.wordRuns);
  });

  it("collectTextRuns, including tag names that merely end in t", () => {
    expectSameOnAll(randomInputs(TEXT_RUN_TOKENS, 4, 8000), collectTextRuns, LEGACY.textRuns);
    expect(collectTextRuns("<sst><si><t>a</t></si></sst>")).toEqual(["<si><t>a"]);
  });

  it("replaceNamespacedSelfClosingTag for hwpx tab, lineBreak and br", () => {
    const inputs = randomInputs(HWPX_SELF_CLOSING_TOKENS, 5, 6000);
    const scan = (name: string, replacement: string) => (s: string) =>
      replaceNamespacedSelfClosingTag(s, name, replacement);
    expectSameOnAll(inputs, scan("tab", "\t"), LEGACY.hwpxTab);
    expectSameOnAll(inputs, scan("lineBreak", "\n"), LEGACY.hwpxLineBreak);
    expectSameOnAll(inputs, scan("br", "\n"), LEGACY.hwpxBr);
  });

  it("replaceNamespacedClosingTag for hwpx p, tr and tc", () => {
    const inputs = randomInputs(HWPX_CLOSING_TOKENS, 6, 6000);
    const scan = (name: string, replacement: string) => (s: string) =>
      replaceNamespacedClosingTag(s, name, replacement);
    expectSameOnAll(inputs, scan("p", "\n"), LEGACY.hwpxP);
    expectSameOnAll(inputs, scan("tr", "\n"), LEGACY.hwpxTr);
    expectSameOnAll(inputs, scan("tc", "\t"), LEGACY.hwpxTc);
  });

  it("collectPdfLiteralStrings, with escapes and without balancing nested parens", () => {
    expectSameOnAll(
      randomInputs(PDF_TOKENS, 7, 8000),
      collectPdfLiteralStrings,
      LEGACY.pdfLiterals,
    );
    expect(collectPdfLiteralStrings("(a(b)c) (x\\)y)")).toEqual(["b", "x\\)y"]);
  });
});

describe("attachment text scanners stay linear on adversarial input", () => {
  it('pdf literals on "(" + "\\\\(" repeated', () => {
    expectLinear((n) => repeatTo(n, "\\(", "("), collectPdfLiteralStrings);
  });

  it('docx text runs on "<w:t>" repeated', () => {
    expectLinear((n) => repeatTo(n, "<w:t>"), collectWordTextRuns);
  });

  it("docx <w:tab/> and <w:br/> on unterminated tags repeated", () => {
    expectLinear(
      (n) => repeatTo(n, "<w:tab "),
      (s) => replaceSelfClosingTag(s, "<w:tab", "\t"),
    );
    expectLinear(
      (n) => repeatTo(n, "<w:br "),
      (s) => replaceSelfClosingTag(s, "<w:br", "\n"),
    );
  });

  it('xml text runs on "<t>", "<", "</" and non-t closers repeated', () => {
    expectLinear((n) => repeatTo(n, "<t>"), collectTextRuns);
    expectLinear((n) => repeatTo(n, "<"), collectTextRuns);
    expectLinear((n) => repeatTo(n, "</"), collectTextRuns);
    expectLinear((n) => repeatTo(n, "</x", "<t>", ">"), collectTextRuns);
  });

  it('tag stripping on "<" repeated', () => {
    expectLinear((n) => repeatTo(n, "<"), stripTags);
    expectLinear((n) => repeatTo(n, "<", "", ">"), stripTags);
  });

  it("hwpx self-closing tags on name and '<' floods", () => {
    for (const [unit, name] of [
      ["<tab", "tab"],
      ["<br", "br"],
      ["<lineBreak", "lineBreak"],
      ["<", "tab"],
    ] as const) {
      expectLinear(
        (n) => repeatTo(n, unit),
        (s) => replaceNamespacedSelfClosingTag(s, name, " "),
      );
      expectLinear(
        (n) => repeatTo(n, unit, "", "/>"),
        (s) => replaceNamespacedSelfClosingTag(s, name, " "),
      );
    }
  });

  it('hwpx closing tags on "</" and "</p" floods', () => {
    expectLinear(
      (n) => repeatTo(n, "</"),
      (s) => replaceNamespacedClosingTag(s, "p", "\n"),
    );
    expectLinear(
      (n) => repeatTo(n, "</a", "", ">"),
      (s) => replaceNamespacedClosingTag(s, "p", "\n"),
    );
  });
});
