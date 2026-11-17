/**
 * Mail addresses out of free text bound for Sentry (security/sentry-scrub.ts).
 *
 * The console integration turns every `console.*` line into a breadcrumb that
 * rides on the next error event, so an address in any log line reached Sentry
 * whatever the log sites themselves did. This redactor runs on every
 * breadcrumb, so it has to stay linear on hostile input: the untrusted-text
 * paths here have been DoS'd by a regex before (#1466).
 */

import { describe, expect, it } from "vitest";
import {
  MAIL_ADDRESS_MARKER,
  MAIL_ADDRESS_PATTERN,
  redactMailAddresses,
} from "../security/mail-address-redaction.js";

describe("redactMailAddresses", () => {
  it.each([
    ["alice@example.com", MAIL_ADDRESS_MARKER],
    ["send to bob.smith+news@mail.example.co.uk failed", `send to ${MAIL_ADDRESS_MARKER} failed`],
    ["Alice <alice@example.com>", `Alice <${MAIL_ADDRESS_MARKER}>`],
    ["mailto:o'brien@example.ie", `mailto:${MAIL_ADDRESS_MARKER}`],
    ["?to=alice%40example.com&alt=sse", `?to=${MAIL_ADDRESS_MARKER}&alt=sse`],
    ["user@163.com", MAIL_ADDRESS_MARKER],
  ])("redacts %j", (input, expected) => {
    expect(redactMailAddresses(input)).toBe(expected);
  });

  it("redacts an address with a non-ASCII local part or domain", () => {
    const out = redactMailAddresses("from 홍길동@example.kr and kim@회사.한국 today");
    expect(out).toBe(`from ${MAIL_ADDRESS_MARKER} and ${MAIL_ADDRESS_MARKER} today`);
  });

  it("redacts every address in a line, not only the first", () => {
    const out = redactMailAddresses("a@x.io, b@y.io; c@z.io");
    expect(out).toBe(`${MAIL_ADDRESS_MARKER}, ${MAIL_ADDRESS_MARKER}; ${MAIL_ADDRESS_MARKER}`);
  });

  it.each([
    "@sentry/node",
    "a @ b",
    "user@localhost",
    "price 3@ $5",
    "[imap] sync failed (rowId=r1): Error, message 14 chars",
  ])("leaves %j alone", (input) => {
    expect(redactMailAddresses(input)).toBe(input);
  });

  it("is idempotent", () => {
    const once = redactMailAddresses("to alice@example.com");
    expect(redactMailAddresses(once)).toBe(once);
  });
});

/**
 * Removes character classes, so what is left is the pattern's structure: the
 * quantifiers that decide whether matching can go superlinear.
 */
function outsideClasses(source: string): string {
  return source.replace(/\\./g, "").replace(/\[[^\]]*\]/g, "C");
}

describe("redactMailAddresses — linear on hostile input", () => {
  it("bounds every repetition, so no start position can scan more than a fixed window", () => {
    const structure = outsideClasses(MAIL_ADDRESS_PATTERN.source);
    // `+`, `*` and `{n,}` are unbounded; a quantified group is a nested quantifier.
    expect(structure).not.toMatch(/[+*]|\{\d+,\}|\)[?{]/);
    expect(structure).toMatch(/\{1,\d+\}/);
  });

  // Sizes at which the same pattern with unbounded runs (`+` for `{1,n}`) is
  // far past the 60s test timeout: measured 0.35s at 20 KB, 1.5s at 40 KB and
  // 7s at 80 KB of "a", quadratic, so ~18 minutes at 1 MB. Finishing at all is
  // the proof, so these assert output, not time.
  const MB = 1_000_000;
  it.each([
    ["a run of local-part characters with no @", () => "a".repeat(MB)],
    ["a run of local-part characters ending in @ and no domain", () => `${"a".repeat(MB)}@`],
    ["an @ before a dotless domain run", () => `a@${"b".repeat(MB)}`],
    ["alternating a@ pairs", () => "a@".repeat(MB / 2)],
    ["percent-encoded @ runs", () => "a%40".repeat(MB / 4)],
    ["a dotless domain-label run after an @", () => `a@${"-".repeat(MB)}`],
    ["empty labels after an @", () => "a@.".repeat(MB / 3)],
  ])("%s", (_name, build) => {
    const input = build();
    const out = redactMailAddresses(input);
    expect(out).not.toContain(MAIL_ADDRESS_MARKER);
    expect(out).toBe(input);
  });

  it("a megabyte of back-to-back addresses comes out as markers", () => {
    const input = "a@b.co ".repeat(MB / 7);
    const out = redactMailAddresses(input);
    expect(out).toBe(`${MAIL_ADDRESS_MARKER} `.repeat(MB / 7));
  });
});
