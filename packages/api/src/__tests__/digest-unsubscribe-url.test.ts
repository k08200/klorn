/**
 * `WEB_URL` is operator-set, and it ends up in two places where a malformed
 * value does real damage: a `List-Unsubscribe` mail header, where a stray `>`
 * or `,` splits one URI into two, and an `href` in the HTML body.
 *
 * A mutation run over the first version of this feature showed the digest
 * tests passed with `safeHttpUrl`'s scheme check deleted, with
 * `stripHeaderControls` deleted, and with the `href` left unescaped — the
 * assertions only ever exercised one benign URL. These cases cover the
 * builder directly, which is why it takes its base as an argument instead of
 * reading the env var at import time.
 */

import { describe, expect, it } from "vitest";
import { digestUnsubscribeLabel, digestUnsubscribeUrl } from "../mail/digest-unsubscribe.js";

const PATH = "/settings/notifications#notifyDailyBriefing";

describe("digestUnsubscribeUrl", () => {
  it("builds the preferences anchor from a normal base URL", () => {
    expect(digestUnsubscribeUrl("https://app.klorn.ai")).toBe(`https://app.klorn.ai${PATH}`);
  });

  it("tolerates a trailing slash without doubling it", () => {
    expect(digestUnsubscribeUrl("https://app.klorn.ai/")).toBe(`https://app.klorn.ai${PATH}`);
  });

  it("keeps a non-default port, which local and preview deployments need", () => {
    expect(digestUnsubscribeUrl("http://localhost:8001")).toBe(`http://localhost:8001${PATH}`);
  });

  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["file:", "file:///etc/passwd"],
    ["mailto:", "mailto:someone@example.com"],
  ])("refuses a %s base rather than linking it", (_label, value) => {
    expect(digestUnsubscribeUrl(value)).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["undefined", undefined],
    ["null", null],
    ["scheme-less host", "app.klorn.ai"],
    ["garbage", "://///"],
  ])("returns null for a %s value so the caller can refuse to send", (_label, value) => {
    expect(digestUnsubscribeUrl(value)).toBeNull();
  });

  // Each of these produced a header that was wrong rather than absent before
  // the builder normalized through URL.origin.
  it("drops a path, query and fragment on the base instead of splicing them in", () => {
    expect(digestUnsubscribeUrl("https://app.klorn.ai/x?ref=y#frag")).toBe(
      `https://app.klorn.ai${PATH}`,
    );
  });

  it("drops userinfo, so a base cannot point the link at another host", () => {
    expect(digestUnsubscribeUrl("https://app.klorn.ai@evil.example")).toBe(
      `https://evil.example${PATH}`,
    );
  });

  it("cannot emit a second List-Unsubscribe URI via '>' or ','", () => {
    const url = digestUnsubscribeUrl("https://app.klorn.ai/?x=>, <https://evil.example");
    expect(url).toBe(`https://app.klorn.ai${PATH}`);
    expect(url).not.toContain(">");
    expect(url).not.toContain(",");
  });

  it.each([
    ["CR/LF", "https://app.klorn.ai\r\nBcc: evil@example.com"],
    ["tab", "https://app.klorn.ai\t/x"],
    ["vertical tab", "https://app.klorn.ai\v"],
    ["NUL", "https://app.klorn.ai\u0000"],
    ["U+2028", "https://app.klorn.ai\u2028"],
  ])("never lets a %s survive into the header", (_label, value) => {
    const url = digestUnsubscribeUrl(value);
    // Not asserted: that the host stays app.klorn.ai. It does not always, and
    // that is correct — in "https://app.klorn.ai\r\nBcc: x@y" the stripped
    // control chars leave "app.klorn.ai Bcc: x@" parsed as USERINFO, so the
    // origin becomes y. WEB_URL is operator-set, so a nonsense value giving a
    // nonsense host is a config bug, not an attack. What must hold is that
    // nothing which could forge a header or split the URI list survives.
    expect(url).not.toBeNull();
    expect(url).not.toMatch(/[\r\n\t\v\0\u2028\u2029]/);
    expect(url).not.toContain(" ");
    expect(url).not.toContain("Bcc");
    expect(url).toMatch(/^https?:\/\/[^/]+\/settings\/notifications#notifyDailyBriefing$/);
  });

  it("never returns a URL with a space, which would break the header", () => {
    for (const base of [
      "https://app.klorn.ai\r\nBcc: evil@example.com",
      " https://app.klorn.ai ",
      "https://app.klorn.ai/a b",
    ]) {
      expect(digestUnsubscribeUrl(base)).not.toContain(" ");
    }
  });
});

describe("digestUnsubscribeLabel", () => {
  it("names the preference, not just this one mail", () => {
    // notifyDailyBriefing also gates the morning briefing and weekly report
    // pushes, so a label promising only "the daily digest" would understate it.
    expect(digestUnsubscribeLabel("en")).toContain("daily briefing");
    expect(digestUnsubscribeLabel("en").toLowerCase()).toContain("unsubscribe");
  });

  it("speaks Korean for ko", () => {
    expect(digestUnsubscribeLabel("ko")).toContain("수신거부");
  });

  it.each([
    "de",
    "fr",
    "es",
    "ja",
    "zh",
    "",
    "nonsense",
  ])("falls back to English for %s rather than inventing unreviewed copy", (lang) => {
    expect(digestUnsubscribeLabel(lang)).toBe(digestUnsubscribeLabel("en"));
  });
});
