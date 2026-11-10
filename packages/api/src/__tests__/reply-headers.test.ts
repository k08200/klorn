/**
 * mail/reply-headers.ts: turns untrusted In-Reply-To / References input into
 * safe header lines by PARSING message ids (`<` + 1..255 printable ASCII
 * excluding `<`, `>` and whitespace + `>`) instead of sanitising free text.
 * Everything that is not a message id is discarded, so no separator or control
 * character can reach a header.
 */

import { describe, expect, it } from "vitest";
import {
  extractMessageIds,
  MAX_FOLDED_LINE_LENGTH,
  MAX_HEADER_LINE_LENGTH,
  MAX_MESSAGE_ID_LENGTH,
  pickInReplyTo,
  REFERENCES_TAIL_LIMIT,
  replyHeaderLines,
} from "../mail/reply-headers.js";

const CRLF = "\r\n";
/** Separators and control characters that must never reach a header line. */
const FORBIDDEN_CHARS = ["\u2028", "\u2029", "\u0085", "\u0000", "\u007f"];

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `<msg-${i}@mail.example.com>`);
}

/** Header lines joined and unfolded, so one header is one string. */
function unfold(lines: string[]): string[] {
  return lines.map((line) => line.replace(/\r\n /g, " "));
}

function physicalLines(lines: string[]): string[] {
  return lines.flatMap((line) => line.split(CRLF));
}

describe("extractMessageIds", () => {
  it("returns valid ids unchanged and in order", () => {
    expect(extractMessageIds("<a@x.com> <b@y.org>")).toEqual(["<a@x.com>", "<b@y.org>"]);
  });

  it("discards text that is not a message id", () => {
    expect(extractMessageIds("Bcc: evil@x.com <a@x.com> trailing words")).toEqual(["<a@x.com>"]);
  });

  it("discards an id with whitespace inside, an empty id and a nested bracket", () => {
    expect(extractMessageIds("<a b@x.com>")).toEqual([]);
    expect(extractMessageIds("<>")).toEqual([]);
    expect(extractMessageIds("<a<b@x.com>")).toEqual(["<b@x.com>"]);
  });

  it("accepts a 255-character id body and discards a 256-character one", () => {
    const longest = `<${"a".repeat(MAX_MESSAGE_ID_LENGTH)}>`;
    const tooLong = `<${"a".repeat(MAX_MESSAGE_ID_LENGTH + 1)}>`;
    expect(extractMessageIds(longest)).toEqual([longest]);
    expect(extractMessageIds(tooLong)).toEqual([]);
  });

  it.each([
    ["NUL", "\u0000"],
    ["DEL", "\u007f"],
    ["lone CR", "\r"],
    ["LF", "\n"],
    ["tab", "\t"],
    ["U+2028", "\u2028"],
    ["U+2029", "\u2029"],
    ["U+0085", "\u0085"],
    ["C0 control", "\u0001"],
    ["non-ASCII letter", "é"],
  ])("rejects an id containing %s", (_name, ch) => {
    expect(extractMessageIds(`<a${ch}b@x.com>`)).toEqual([]);
  });

  it("drops separators and control characters that sit between ids", () => {
    const input = "\u2028<a@x.com>\u0085\u0000<b@x.com>\r<c@x.com>\u007f";
    expect(extractMessageIds(input)).toEqual(["<a@x.com>", "<b@x.com>", "<c@x.com>"]);
  });

  it.each([
    ["number", 42],
    ["object", { id: "<a@x.com>" }],
    ["array", ["<a@x.com>"]],
    ["null", null],
    ["undefined", undefined],
    ["boolean", true],
  ])("treats a %s as absent instead of throwing", (_name, value) => {
    expect(extractMessageIds(value)).toEqual([]);
  });
});

describe("pickInReplyTo", () => {
  it("returns the last valid id", () => {
    expect(pickInReplyTo("<a@x.com> junk <b@x.com>")).toBe("<b@x.com>");
  });

  it("returns undefined when there is no valid id or the input is not a string", () => {
    expect(pickInReplyTo("no id here")).toBeUndefined();
    expect(pickInReplyTo("")).toBeUndefined();
    expect(pickInReplyTo(7)).toBeUndefined();
    expect(pickInReplyTo(undefined)).toBeUndefined();
  });
});

describe("replyHeaderLines", () => {
  it("emits In-Reply-To then References for valid ids", () => {
    expect(replyHeaderLines({ inReplyTo: "<o@x.com>", references: "<a@x.com> <o@x.com>" })).toEqual(
      ["In-Reply-To: <o@x.com>", "References: <a@x.com> <o@x.com>"],
    );
  });

  it("emits only the header that has a valid id", () => {
    expect(replyHeaderLines({ inReplyTo: "<o@x.com>" })).toEqual(["In-Reply-To: <o@x.com>"]);
    expect(replyHeaderLines({ references: "<a@x.com>" })).toEqual(["References: <a@x.com>"]);
  });

  it("emits exactly one In-Reply-To id, the last valid one", () => {
    expect(replyHeaderLines({ inReplyTo: "<a@x.com> <b@x.com>" })).toEqual([
      "In-Reply-To: <b@x.com>",
    ]);
  });

  it("omits a header that has no valid id", () => {
    expect(replyHeaderLines({ inReplyTo: "junk", references: `${CRLF} \n` })).toEqual([]);
    expect(replyHeaderLines({})).toEqual([]);
  });

  it("never lets CRLF plus a header name survive", () => {
    const lines = replyHeaderLines({
      inReplyTo: `<o@x.com>${CRLF}X-Injected: 1`,
      references: `<a@x.com>${CRLF}Bcc: evil@x.com${CRLF}${CRLF}body`,
    });
    expect(lines).toEqual(["In-Reply-To: <o@x.com>", "References: <a@x.com>"]);
  });

  it("never lets a lone CR survive", () => {
    expect(replyHeaderLines({ inReplyTo: "<o@x.com>\rBcc: evil@x.com" })).toEqual([
      "In-Reply-To: <o@x.com>",
    ]);
  });

  it("drops free text between ids", () => {
    const lines = replyHeaderLines({ references: "<a@x.com> Bcc: evil@x.com <b@x.com>" });
    expect(lines).toEqual(["References: <a@x.com> <b@x.com>"]);
  });

  it("keeps U+2028, U+2029, U+0085, NUL and DEL out of every output line", () => {
    const lines = replyHeaderLines({
      inReplyTo: "<o@x.com>\u2028\u2029\u0085\u0000\u007f",
      references: "<a@x.com>\u2028<b@x.com>\u0085<c@x.com>",
    });
    expect(FORBIDDEN_CHARS.filter((ch) => lines.join(CRLF).includes(ch))).toEqual([]);
    expect(unfold(lines)).toEqual([
      "In-Reply-To: <o@x.com>",
      "References: <a@x.com> <b@x.com> <c@x.com>",
    ]);
  });

  it.each([
    ["number", 42],
    ["object", { a: 1 }],
    ["array", ["<a@x.com>"]],
    ["null", null],
  ])("treats a %s value as absent instead of throwing", (_name, value) => {
    expect(replyHeaderLines({ inReplyTo: value, references: value })).toEqual([]);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["number", 5],
    ["string", "<a@x.com>"],
    ["array", [{ inReplyTo: "<a@x.com>" }]],
  ])("treats a %s reply argument as absent", (_name, reply) => {
    expect(replyHeaderLines(reply)).toEqual([]);
  });

  it("deduplicates References and keeps the first occurrence order", () => {
    const lines = replyHeaderLines({ references: "<a@x.com> <b@x.com> <a@x.com> <c@x.com>" });
    expect(lines).toEqual(["References: <a@x.com> <b@x.com> <c@x.com>"]);
  });

  it("keeps the first id plus the last N ids of a 40-id References chain", () => {
    const all = ids(40);
    const lines = replyHeaderLines({ references: all.join(" ") });
    const expected = [all[0], ...all.slice(-REFERENCES_TAIL_LIMIT)];
    expect(REFERENCES_TAIL_LIMIT).toBe(20);
    expect(unfold(lines)).toEqual([`References: ${expected.join(" ")}`]);
  });

  it("keeps a chain of exactly first + N ids whole and trims one more", () => {
    const whole = ids(REFERENCES_TAIL_LIMIT + 1);
    expect(unfold(replyHeaderLines({ references: whole.join(" ") }))).toEqual([
      `References: ${whole.join(" ")}`,
    ]);
    const over = ids(REFERENCES_TAIL_LIMIT + 2);
    const trimmed = [over[0], ...over.slice(-REFERENCES_TAIL_LIMIT)];
    expect(unfold(replyHeaderLines({ references: over.join(" ") }))).toEqual([
      `References: ${trimmed.join(" ")}`,
    ]);
  });

  it("folds References so every physical line stays within 78 characters", () => {
    const lines = replyHeaderLines({ references: ids(40).join(" ") });
    const physical = physicalLines(lines);
    expect(physical.length).toBeGreaterThan(1);
    for (const line of physical) expect(line.length).toBeLessThanOrEqual(MAX_HEADER_LINE_LENGTH);
  });

  it("folds with CRLF plus a single space between tokens", () => {
    const [, ...continuation] = physicalLines(replyHeaderLines({ references: ids(40).join(" ") }));
    expect(continuation.length).toBeGreaterThan(0);
    for (const line of continuation) expect(line).toMatch(/^ <[^\s<>]+>( <[^\s<>]+>)*$/);
  });

  it("never exceeds 998 characters per physical line even with maximum-length ids", () => {
    const longA = `<${"a".repeat(MAX_MESSAGE_ID_LENGTH)}>`;
    const longB = `<${"b".repeat(MAX_MESSAGE_ID_LENGTH)}>`;
    const lines = replyHeaderLines({ references: `${longA} <s@x.com> ${longB}` });
    for (const line of physicalLines(lines)) {
      expect(line.length).toBeLessThanOrEqual(MAX_FOLDED_LINE_LENGTH);
    }
    expect(physicalLines(lines)).toHaveLength(3);
    expect(unfold(lines)).toEqual([`References: ${longA} <s@x.com> ${longB}`]);
  });

  it("does not mutate its input", () => {
    const reply = Object.freeze({ inReplyTo: "<o@x.com>", references: "<a@x.com>" });
    expect(() => replyHeaderLines(reply)).not.toThrow();
    expect(reply).toEqual({ inReplyTo: "<o@x.com>", references: "<a@x.com>" });
  });
});
