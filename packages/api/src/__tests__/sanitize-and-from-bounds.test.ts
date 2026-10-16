import { describe, expect, it } from "vitest";
import { isAutomatedSender, isTransactionalSender } from "../judge/keyword-policy.js";
import { boundedFromValue, MAX_FROM_REGEX_CHARS } from "../mail/email-address.js";
import {
  boundSanitizeInput,
  htmlToPlainText,
  MAX_SANITIZE_TAGS,
  renderableEmailHtml,
} from "../mail/email-text.js";
import { senderName } from "../notify/notification-format.js";

// Event-loop stalls from one email, found by the 2026-10-16 security review:
//   - sanitize-html (htmlparser2 keeps open tags with stack.unshift) is
//     quadratic in nesting depth: "<b>" x 166k (under the 500 KB cap) took 8.3 s
//     in htmlToPlainText (Gmail HTML-only mail at sync) and 8.5 s in
//     renderableEmailHtml (every email open);
//   - regexes over a From value backtrack on long runs (5-7 s at 80k chars).
// Production on 2026-10-16: the most '<' in any stored HTML body is 5,780
// (p99.9 4,156) and the longest From is 115 characters.

const BUDGET_MS = 300;

function timed(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe("sanitize-html input is bounded by tag count", () => {
  it("leaves HTML with fewer tags than the bound untouched", () => {
    const html = `<table>${"<tr><td>cell</td></tr>".repeat(1500)}</table>`;
    expect(boundSanitizeInput(html)).toBe(html);
  });

  it("cuts right before the tag past the bound", () => {
    const html = "<i>x</i>".repeat(MAX_SANITIZE_TAGS);
    const bounded = boundSanitizeInput(html);
    expect(bounded.split("<").length - 1).toBe(MAX_SANITIZE_TAGS);
    expect(html.startsWith(bounded)).toBe(true);
  });

  it("projects deeply nested HTML to text within budget", () => {
    const hostile = `${"<b>".repeat(166_000)}end`;
    expect(timed(() => htmlToPlainText(hostile))).toBeLessThan(BUDGET_MS);
  });

  it("renders deeply nested HTML within budget", () => {
    const hostile = `${"<b>".repeat(166_000)}end`;
    expect(timed(() => renderableEmailHtml(hostile))).toBeLessThan(BUDGET_MS);
  });
});

describe("From values are bounded before any regex reads them", () => {
  it("keeps every real From value whole", () => {
    const from = `"Kim, Jiwoo (Sales)" <jiwoo.kim@example.co.kr>`;
    expect(boundedFromValue(from)).toBe(from);
    expect(boundedFromValue("x".repeat(MAX_FROM_REGEX_CHARS + 5))).toHaveLength(
      MAX_FROM_REGEX_CHARS,
    );
  });

  it("names a sender within budget for a hostile display name", () => {
    const hostile = `a${" ".repeat(200_000)}b`;
    expect(timed(() => senderName(hostile))).toBeLessThan(BUDGET_MS);
    expect(senderName("Kim Jiwoo <k@example.com>")).toBe("Kim Jiwoo");
  });

  it("classifies a hostile sender within budget", () => {
    const hostile = ".ship".repeat(100_000);
    expect(timed(() => isTransactionalSender(hostile))).toBeLessThan(BUDGET_MS);
    // Unchanged meaning: it reads the address's local-part role.
    expect(isTransactionalSender("ship-confirm@shop.example")).toBe(true);
    expect(isTransactionalSender("shipley@example.com")).toBe(false);
  });

  it("decides an automated sender within budget (the production path)", () => {
    // No angle-addr: the whole header is the extracted "address".
    for (const hostile of [
      ".ship".repeat(20_000),
      "-order".repeat(16_000),
      `x${".ship".repeat(20_000)}@`,
    ]) {
      expect(timed(() => isAutomatedSender(hostile))).toBeLessThan(BUDGET_MS);
    }
    expect(isAutomatedSender("Shop <ship-confirm@shop.example>")).toBe(true);
    expect(isAutomatedSender("No Reply <no-reply@service.example>")).toBe(true);
    expect(isAutomatedSender("Shipley <shipley@example.com>")).toBe(false);
  });
});
