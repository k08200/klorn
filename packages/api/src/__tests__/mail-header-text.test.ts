/**
 * Text helpers shared by the address parser and the reply-subject builder: what
 * may never sit in a header, which invisible characters are stripped, and limits
 * measured in code points (the unit a JSON-schema `maxLength` counts in).
 */

import { describe, expect, it } from "vitest";
import {
  exceedsCodePoints,
  hasHeaderBreaker,
  stripInvisibleControls,
  truncateCodePoints,
} from "../mail/header-text.js";

const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const EMOJI = cp(0x1f4c5);

describe("hasHeaderBreaker", () => {
  it("flags every C0 control, DEL, NEL and the Unicode line and paragraph separators", () => {
    for (const code of [0x00, 0x09, 0x0a, 0x0d, 0x1f, 0x7f, 0x85, 0x2028, 0x2029]) {
      expect(hasHeaderBreaker(`a${cp(code)}b`), code.toString(16)).toBe(true);
    }
  });

  it("passes ordinary text: ASCII, punctuation, CJK, emoji, combining marks", () => {
    for (const text of ["Hello, world!", "회의 일정", `Plan ${EMOJI}`, "é", " "]) {
      expect(hasHeaderBreaker(text), text).toBe(false);
    }
  });
});

describe("stripInvisibleControls", () => {
  it("removes zero-width space, the directional marks and every bidi embedding, override and isolate", () => {
    const invisible = [
      0x200b,
      0x200e,
      0x200f,
      ...Array.from({ length: 5 }, (_, i) => 0x202a + i),
      ...Array.from({ length: 4 }, (_, i) => 0x2066 + i),
    ];
    for (const code of invisible) {
      expect(stripInvisibleControls(`pay${cp(code)}pal`), code.toString(16)).toBe("paypal");
    }
  });

  it("neutralises a right-to-left override that would reorder the visible subject", () => {
    expect(stripInvisibleControls(`invoice ${cp(0x202e)}fdp.exe`)).toBe("invoice fdp.exe");
  });

  it("keeps the characters just outside the ranges, and ordinary text", () => {
    for (const code of [0x200a, 0x2010, 0x2029, 0x202f, 0x2065, 0x206a]) {
      expect(stripInvisibleControls(`a${cp(code)}b`), code.toString(16)).toBe(`a${cp(code)}b`);
    }
    expect(stripInvisibleControls(`회의 ${EMOJI}`)).toBe(`회의 ${EMOJI}`);
  });

  it("keeps the zero-width non-joiner and joiner, which scripts and emoji sequences need", () => {
    const persian = `می${cp(0x200c)}خواهم`;
    const family = `${cp(0x1f469)}${cp(0x200d)}${cp(0x1f467)}`;
    expect(stripInvisibleControls(persian)).toBe(persian);
    expect(stripInvisibleControls(`hi ${family}`)).toBe(`hi ${family}`);
  });

  it("returns an all-invisible string as empty", () => {
    expect(stripInvisibleControls(cp(0x200b, 0x202e, 0x2066))).toBe("");
  });
});

describe("code-point limits", () => {
  it("counts an emoji as one code point, not two UTF-16 units", () => {
    expect(exceedsCodePoints(EMOJI.repeat(300), 300)).toBe(false);
    expect(exceedsCodePoints(EMOJI.repeat(301), 300)).toBe(true);
    expect(EMOJI.repeat(300)).toHaveLength(600);
  });

  it("agrees with a plain length for ASCII, at the boundary", () => {
    expect(exceedsCodePoints("x".repeat(300), 300)).toBe(false);
    expect(exceedsCodePoints("x".repeat(301), 300)).toBe(true);
    expect(exceedsCodePoints("", 0)).toBe(false);
    expect(exceedsCodePoints("x", 0)).toBe(true);
  });

  it("truncates by code points and never splits a surrogate pair", () => {
    expect(truncateCodePoints(`${"x".repeat(5)}${EMOJI}`, 6)).toBe(`${"x".repeat(5)}${EMOJI}`);
    expect(truncateCodePoints(`${"x".repeat(5)}${EMOJI}${EMOJI}`, 6)).toBe(
      `${"x".repeat(5)}${EMOJI}`,
    );
    expect(truncateCodePoints(`${"x".repeat(6)}${EMOJI}`, 6)).toBe("x".repeat(6));
    expect(truncateCodePoints(EMOJI.repeat(10), 3)).toBe(EMOJI.repeat(3));
  });

  it("leaves a short string untouched and handles zero", () => {
    expect(truncateCodePoints("abc", 10)).toBe("abc");
    expect(truncateCodePoints("abc", 0)).toBe("");
  });
});
