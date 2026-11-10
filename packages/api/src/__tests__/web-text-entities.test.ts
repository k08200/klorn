// Pins decodeHtmlEntities in packages/web/src/lib/text.ts. The web package has
// no unit runner, so its pure helpers are exercised here.
//
// Numeric character references to zero, anything past U+10FFFF and the UTF-16
// surrogate range become U+FFFD, as the HTML tokenizer does for those cases. Nothing here may throw, and the cost stays linear in the input.
import { describe, expect, it } from "vitest";
import { decodeHtmlEntities } from "../../../web/src/lib/text";
import { expectLinear, repeatTo } from "./helpers/linear-timing.js";

const FFFD = "\ufffd";

describe("decodeHtmlEntities", () => {
  it("decodes named, decimal and hex references", () => {
    // &nbsp; folds to a plain space on purpose (display text, not markup).
    expect(decodeHtmlEntities("a&amp;b &lt;c&gt; &quot;d&apos; e&nbsp;f")).toBe("a&b <c> \"d' e f");
    expect(decodeHtmlEntities("&#65;&#x42;&#X43;&#x1F600;")).toBe("ABC\u{1F600}");
    expect(decodeHtmlEntities("&#x10FFFF;")).toBe("\u{10FFFF}");
  });

  it("returns an empty string for nullish or empty input", () => {
    expect(decodeHtmlEntities(null)).toBe("");
    expect(decodeHtmlEntities(undefined)).toBe("");
    expect(decodeHtmlEntities("")).toBe("");
  });

  it("maps code points past U+10FFFF to U+FFFD instead of throwing", () => {
    expect(decodeHtmlEntities("a&#x110000;b")).toBe(`a${FFFD}b`);
    expect(decodeHtmlEntities("&#99999999;")).toBe(FFFD);
    expect(decodeHtmlEntities("&#1114112;")).toBe(FFFD);
  });

  it("maps a zero reference to U+FFFD", () => {
    expect(decodeHtmlEntities("&#0;")).toBe(FFFD);
    expect(decodeHtmlEntities("&#x0;")).toBe(FFFD);
    expect(decodeHtmlEntities("&#0000;")).toBe(FFFD);
  });

  it("maps surrogate code points to U+FFFD instead of a lone surrogate", () => {
    for (const ref of ["&#xD800;", "&#xDBFF;", "&#xDC00;", "&#xDFFF;", "&#55296;", "&#57343;"]) {
      expect(decodeHtmlEntities(ref)).toBe(FFFD);
    }
    // Neighbours of the range still decode.
    expect(decodeHtmlEntities("&#xD7FF;&#xE000;")).toBe("\ud7ff\ue000");
  });

  it("maps a reference with a huge digit string to U+FFFD", () => {
    expect(decodeHtmlEntities(`&#${"9".repeat(100_000)};`)).toBe(FFFD);
    expect(decodeHtmlEntities(`&#x${"f".repeat(100_000)};`)).toBe(FFFD);
    // Leading zeros do not change the value.
    expect(decodeHtmlEntities(`&#${"0".repeat(100_000)}65;`)).toBe("A");
  });

  it("decodes only its own named entities, never object prototype keys", () => {
    for (const text of ["&constructor;", "&toString;", "&__proto__;", "&CONSTRUCTOR;"]) {
      expect(decodeHtmlEntities(text)).toBe(text);
    }
  });

  it("leaves malformed references as text", () => {
    for (const text of [
      "&",
      "&;",
      "&#;",
      "&#x;",
      "&#xZZ;",
      "&#12",
      "&#x41",
      "&unknown;",
      "& amp;",
      "&#-1;",
    ]) {
      expect(decodeHtmlEntities(text)).toBe(text);
    }
  });

  it("never throws on hostile input", () => {
    const inputs = [
      "&#x110000;&#xFFFFFFFF;&#4294967296;&#1e9;&#x-1;",
      "&#".repeat(10_000),
      "&#x".repeat(10_000),
      `&#${"9".repeat(400)};`,
      "&#xD800;&#xDC00;",
    ];
    for (const input of inputs) expect(() => decodeHtmlEntities(input)).not.toThrow();
  });

  it("stays linear in input length on out-of-range and unterminated references", () => {
    expectLinear((bytes) => repeatTo(bytes, "&#x110000;"), decodeHtmlEntities);
    expectLinear((bytes) => repeatTo(bytes, "&#0;&#xD800;"), decodeHtmlEntities);
    expectLinear((bytes) => `&#${"9".repeat(bytes)}`, decodeHtmlEntities);
    expectLinear((bytes) => `&#${"9".repeat(bytes)};`, decodeHtmlEntities);
    expectLinear((bytes) => repeatTo(bytes, "&a"), decodeHtmlEntities);
  });
});
