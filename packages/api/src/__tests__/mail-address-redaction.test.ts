/**
 * Mail addresses out of free text bound for Sentry (security/sentry-scrub.ts).
 *
 * The console integration turns every `console.*` line into a breadcrumb that
 * rides on the next error event, so an address in any log line reached Sentry
 * whatever the log sites themselves did. This redactor runs on every
 * breadcrumb, on the event loop, so it has to stay linear on hostile input:
 * the untrusted-text paths here have been DoS'd by a regex before (#1466).
 */

import { describe, expect, it } from "vitest";
import { MAIL_ADDRESS_MARKER, redactMailAddresses } from "../security/mail-address-redaction.js";

const M = MAIL_ADDRESS_MARKER;

describe("redactMailAddresses", () => {
  it.each([
    ["alice@example.com", M],
    ["send to bob.smith+news@mail.example.co.uk failed", `send to ${M} failed`],
    ["Alice <alice@example.com>", `Alice <${M}>`],
    ["mailto:o'brien@example.ie", `mailto:${M}`],
    ["user@163.com", M],
    ["alice@my_host.example.com", M],
    // `=` is an atext character, so a parameter name before an address goes
    // with it; `/ ? & #` are not taken, so a URL keeps its path and query.
    ["?to=alice%40example.com&alt=sse", `?${M}&alt=sse`],
    ["https://x.example/u/jo%2540example.com/x", `https://x.example/u/${M}/x`],
    ["https://x.example/u/alice@example.com?y=1", `https://x.example/u/${M}?y=1`],
  ])("redacts %j", (input, expected) => {
    expect(redactMailAddresses(input)).toBe(expected);
  });

  it.each([
    ["a VERP bounce address", "bounce+kim=example.com@lists.example.org"],
    ["an SRS forward address", "SRS0=HHH=TT=example.com=kim@fwd.example.net"],
    ["a local part with atext symbols", "kim!o'neil*x^y{z}|w~v$u@example.com"],
  ])("redacts the recipient inside %s, not only its tail", (_name, address) => {
    expect(redactMailAddresses(`Return-Path: <${address}>`)).toBe(`Return-Path: <${M}>`);
  });

  it("redacts an address with a non-ASCII local part or domain", () => {
    const out = redactMailAddresses("from 홍길동@example.kr and kim@회사.한국 today");
    expect(out).toBe(`from ${M} and ${M} today`);
  });

  it("redacts every address in a line, not only the first", () => {
    expect(redactMailAddresses("a@x.io, b@y.io; c@z.io")).toBe(`${M}, ${M}; ${M}`);
  });

  it("takes a local part longer than RFC 5321's 64 characters whole: no head is left", () => {
    const out = redactMailAddresses(`to ${"h".repeat(10)}${"t".repeat(64)}@example.com now`);
    expect(out).toBe(`to ${M} now`);
  });

  it.each([
    ['"kim lee"@example.com', M],
    ['To: "kim lee"@example.com, bob@example.com', `To: ${M}, ${M}`],
    ['<"kim.lee@home"@example.com>', `<${M}>`],
    ['"kim \\"the boss\\" lee"@example.com', M],
    [`"${"q".repeat(80)}"@example.com`, M],
    // JSON writes the quotes escaped: the escape goes with the address.
    [JSON.stringify({ to: '"kim lee"@example.com' }), `{"to":"${M}"}`],
    ['said "hi" then "kim lee"@example.com', `said "hi" then ${M}`],
    ['"a@b.co" and "kim"@example.com', `"${M}" and ${M}`],
  ])("redacts the quoted local part in %j", (input, expected) => {
    expect(redactMailAddresses(input)).toBe(expected);
  });

  it("follows a quoted local part folded across lines, and takes the line when no opening quote is on it", () => {
    // RFC 5322 lets a quoted string fold: the opening quote may sit a line up.
    expect(redactMailAddresses('To: "Kim\r\n Lee"@example.com')).toBe(`To: ${M}`);
    // A stray closing quote with no opening: the line up to it goes, not only
    // the domain, and the line before stays.
    expect(redactMailAddresses('first line\nlog: x"@example.com')).toBe(`first line\n${M}`);
    // An opening quote on an earlier, unfolded line is not this one's.
    expect(redactMailAddresses('say "hi"\nline two\nfoo"@y.co')).toBe(`say "hi"\nline two\n${M}`);
  });

  it.each([
    "@sentry/node",
    "a @ b",
    "user@localhost",
    "price 3@ $5",
    "100%",
    "%4",
    "[imap] sync failed (rowId=r1): Error, message 14 chars",
  ])("leaves %j alone", (input) => {
    expect(redactMailAddresses(input)).toBe(input);
  });

  it("is idempotent", () => {
    const once = redactMailAddresses("to alice@example.com");
    expect(redactMailAddresses(once)).toBe(once);
  });
});

describe("redactMailAddresses — linear on hostile input", () => {
  // Shapes that make a scan without the RFC bounds (or the common unbounded
  // `[…]+@[…]+\.[…]{2,}` regex, measured at 0.35s for 20 KB, 1.5s for 40 KB and
  // 7s for 80 KB of "a") quadratic: minutes at 1 MB, far past the 60s test
  // timeout. Finishing at all is the proof, so these assert output, not time.
  const MB = 1_000_000;
  it.each([
    ["a run of local-part characters with no @", () => "a".repeat(MB)],
    ["a run of local-part characters ending in @ and no domain", () => `${"a".repeat(MB)}@`],
    ["an @ before a dotless domain run", () => `a@${"b".repeat(MB)}`],
    ["alternating a@ pairs", () => "a@".repeat(MB / 2)],
    ["percent-encoded @ runs", () => "a%40".repeat(MB / 4)],
    ["double-encoded @ runs", () => "a%2540".repeat(MB / 6)],
    ["a dotless domain-label run after an @", () => `a@${"-".repeat(MB)}`],
    ["empty labels after an @", () => "a@.".repeat(MB / 3)],
    [
      "full-length local parts before full-length dotless labels",
      () => `${"a".repeat(64)}@${"b".repeat(63)}-`.repeat(MB / 129),
    ],
  ])("%s", (_name, build) => {
    const input = build();
    const out = redactMailAddresses(input);
    expect(out).not.toContain(M);
    expect(out).toBe(input);
  });

  it.each([
    ["a megabyte-long local part", () => `${"a".repeat(MB)}@example.com`, M],
    ["a megabyte-long quoted local part", () => `"${"a ".repeat(MB / 2)}"@example.com`, M],
    ["quotes only", () => '"'.repeat(MB), null],
    ["quote-@ pairs with no domain", () => '"@'.repeat(MB / 2), null],
    ["quote-@-dot runs", () => '"@x.'.repeat(MB / 4), null],
    ["escaped quotes only", () => '\\"'.repeat(MB / 2), null],
    ["back-to-back quoted addresses", () => '"a"@b.co '.repeat(MB / 9), `${M} `.repeat(MB / 9)],
    ["a quote, then a megabyte of quote-@ pairs", () => `"${'x"@'.repeat(MB / 3)}`, null],
  ])("%s", (_name, build, expected) => {
    const input = build();
    expect(redactMailAddresses(input)).toBe(expected ?? input);
  });

  it("a megabyte of back-to-back addresses comes out as markers", () => {
    const out = redactMailAddresses("a@b.co ".repeat(MB / 7));
    expect(out).toBe(`${M} `.repeat(MB / 7));
  });
});
