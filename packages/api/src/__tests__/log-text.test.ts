/**
 * Step B4 review fix: text that came from a remote server (an IMAP error, a TLS
 * message) must not forge or split a log line, and must not flood one. It is made
 * single-line and capped before it is logged.
 */

import { describe, expect, it } from "vitest";

import { MAX_LOG_TEXT_LENGTH, sanitizeLogText } from "../mail/log-text.js";

describe("sanitizeLogText", () => {
  it("leaves ordinary text alone", () => {
    expect(sanitizeLogText("Authentication failed (AUTH=PLAIN)")).toBe(
      "Authentication failed (AUTH=PLAIN)",
    );
  });

  it("turns CR and LF into spaces so one message stays one log line", () => {
    const out = sanitizeLogText("bad\r\n[generic-imap] FORGED: login ok\nsecond");
    expect(out).toBe("bad  [generic-imap] FORGED: login ok second");
    expect(out).not.toMatch(/[\r\n]/);
  });

  it.each([
    ["NUL", "a\u0000b"],
    ["tab", "a\tb"],
    ["escape", "a\u001b[31mb"],
    ["DEL", "a\u007fb"],
    ["C1 control", "a\u0085b"],
    ["line separator", "a b"],
    ["paragraph separator", "a b"],
  ])("replaces %s with a space", (_label, input) => {
    const out = sanitizeLogText(input);
    expect(out.startsWith("a")).toBe(true);
    expect(out.endsWith("b")).toBe(true);
    expect(out).toMatch(/^a.{1,6}b$/);
    for (const ch of out) {
      const code = ch.codePointAt(0) ?? 0;
      expect(code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)).toBe(true);
      expect(code === 0x2028 || code === 0x2029).toBe(false);
    }
  });

  it("caps the length", () => {
    const out = sanitizeLogText("x".repeat(10_000));
    expect(out.length).toBeLessThanOrEqual(MAX_LOG_TEXT_LENGTH);
    expect(MAX_LOG_TEXT_LENGTH).toBeGreaterThan(0);
    expect(MAX_LOG_TEXT_LENGTH).toBeLessThanOrEqual(300);
  });

  it("accepts a smaller cap", () => {
    expect(sanitizeLogText("abcdefghij", 4)).toBe("abcd");
  });

  it("describes things that are not strings", () => {
    expect(sanitizeLogText(new Error("boom\nmore"))).toBe("boom more");
    expect(sanitizeLogText(undefined)).toBe("undefined");
    expect(sanitizeLogText(42)).toBe("42");
    expect(sanitizeLogText({ toString: () => "obj\r\nx" })).toBe("obj  x");
  });

  it("does not throw on a value whose toString throws", () => {
    const hostile = {
      toString() {
        throw new Error("no");
      },
    };
    expect(sanitizeLogText(hostile)).toBe("[unprintable]");
  });
});
