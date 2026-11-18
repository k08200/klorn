import { describe, expect, it } from "vitest";
import { clampText } from "../notify/clamp-text.js";

describe("clampText", () => {
  it("returns text that already fits unchanged", () => {
    expect(clampText("Board deck — numbers check", 40)).toBe("Board deck — numbers check");
  });

  it("cuts Latin text at a word boundary and ends with an ellipsis", () => {
    const out = clampText("Please review the quarterly numbers before Friday", 30);
    expect(out).toBe("Please review the quarterly…");
    expect(out.length).toBeLessThanOrEqual(30);
  });

  it("never splits a grapheme cluster", () => {
    const family = "👨‍👩‍👧‍👦";
    const out = clampText(`${"a".repeat(8)}${family}${family}`, 12);
    expect(out.length).toBeLessThanOrEqual(12);
    // The kept part either holds the whole family emoji or none of it.
    const kept = out.replace(/…$/, "").slice(8);
    expect(kept === "" || kept === family).toBe(true);
  });

  it("keeps a curly quote pair whole when the cut lands inside it", () => {
    const out = clampText("Terry Smith · “오늘 17시까지 꼭 회신 부탁드립니다 감사합니다”", 30);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out.endsWith("…”")).toBe(true);
    expect(out.split("“").length).toBe(out.split("”").length);
  });

  it("keeps straight double quotes paired", () => {
    const out = clampText('Re: "Final proposal for the board meeting next week"', 28);
    expect(out.length).toBeLessThanOrEqual(28);
    expect((out.match(/"/g) ?? []).length % 2).toBe(0);
  });

  it("cuts CJK text without spaces on a character, not mid code point", () => {
    const out = clampText("견적서최종확인요청드립니다오늘중으로부탁", 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/[\uD800-\uDFFF]/);
  });

  it("does not leave a lone surrogate when the limit falls inside a pair", () => {
    const out = clampText(`ab${"😀".repeat(10)}`, 6);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(out.length).toBeLessThanOrEqual(6);
  });

  it("keeps line breaks of a multi-line body", () => {
    expect(clampText("Line one\nLine two", 50)).toBe("Line one\nLine two");
  });

  it("returns an empty string for a non-positive limit", () => {
    expect(clampText("anything", 0)).toBe("");
  });
});
