/**
 * PII scrub + leak-linter for the real eval set workflow (#648).
 *
 * The doctrine (eval/README.md) stands: nothing auto-commits real mail to
 * this public repo — the founder eyeballs every row. These functions shrink
 * that job to review-and-approve: the scrubber replaces addresses/URLs/phones
 * DETERMINISTICALLY (same sender → same placeholder, so sender-prior signal
 * survives), and the linter is the pre-commit guard that refuses any file
 * still carrying an address-shaped string — "one missed address" is exactly
 * the irreversible leak the doctrine warns about.
 */

import { describe, expect, it } from "vitest";
import { createScrubContext, lintPii, scrubItem, scrubText } from "../eval-scrub.js";

describe("scrubText", () => {
  it("replaces email addresses deterministically (same address → same placeholder)", () => {
    const ctx = createScrubContext();
    const a = scrubText("Mail from jane.doe@acmecorp.com about the deal", ctx);
    const b = scrubText("Reply to jane.doe@acmecorp.com and bob@acmecorp.com", ctx);
    expect(a.text).not.toContain("jane.doe@acmecorp.com");
    expect(a.text).toMatch(/person-1@domain-1\.example/);
    // Same address again → same placeholder; same domain → same domain token.
    expect(b.text).toContain("person-1@domain-1.example");
    expect(b.text).toContain("person-2@domain-1.example");
    expect(a.notes).toContain("email:jane.doe@acmecorp.com→person-1@domain-1.example");
  });

  it("replaces display-name+address sender headers while keeping structure", () => {
    const ctx = createScrubContext();
    const r = scrubText("Jane Doe <jane@acmecorp.com>", ctx);
    expect(r.text).toBe("Jane Doe <person-1@domain-1.example>");
  });

  it("replaces URLs and phone-like sequences", () => {
    const ctx = createScrubContext();
    const r = scrubText("See https://tracking.acme.com/x?id=9 or call +82 10-1234-5678", ctx);
    expect(r.text).not.toContain("tracking.acme.com");
    expect(r.text).toContain("https://link-1.example");
    expect(r.text).not.toContain("1234-5678");
    expect(r.text).toMatch(/000-0000/);
  });

  it("keeps dates and short reference codes intact (structural signal)", () => {
    const ctx = createScrubContext();
    const r = scrubText("Invoice INV-2291 due 2026-07-25", ctx);
    expect(r.text).toContain("INV-2291");
    expect(r.text).toContain("2026-07-25");
  });

  it("returns empty notes when nothing was scrubbed", () => {
    const ctx = createScrubContext();
    expect(scrubText("Weekly build report", ctx).notes).toEqual([]);
  });
});

describe("scrubItem", () => {
  it("scrubs all text fields, keeps the label, and marks reviewed:false", () => {
    const ctx = createScrubContext();
    const item = scrubItem(
      {
        id: "row-1",
        gmailId: "g-1",
        from: "Acme Billing <billing@acmecorp.com>",
        subject: "Your invoice from billing@acmecorp.com",
        snippet: "Pay at https://pay.acme.com now",
        body: "Contact jane@acmecorp.com or +1 415 555 0100",
        labels: ["INBOX"],
        receivedAt: "2026-06-01T00:00:00.000Z",
        label: "QUEUE",
      },
      ctx,
    );
    expect(item.reviewed).toBe(false);
    expect(item.label).toBe("QUEUE");
    // The content fields must be clean…
    const content = JSON.stringify([item.from, item.subject, item.snippet, item.body]);
    expect(content).not.toMatch(/acmecorp\.com|acme\.com|555 ?0100/);
    // …while scrubNotes deliberately carry original→replacement pairs for the
    // founder's review. They never reach the committed file (the finalize step
    // strips them), and lintPii flags a document that still contains them.
    expect(item.scrubNotes.some((n) => n.includes("billing@acmecorp.com"))).toBe(true);
    expect(lintPii(JSON.stringify(item)).length).toBeGreaterThan(0);
  });
});

describe("lintPii", () => {
  it("passes a clean scrubbed document (placeholders allowed)", () => {
    const doc = JSON.stringify({
      items: [{ from: "person-1@domain-1.example", body: "https://link-1.example ok 000-0000-1" }],
    });
    expect(lintPii(doc)).toEqual([]);
  });

  it("flags real email addresses, URLs, and phone numbers", () => {
    const doc = JSON.stringify({
      items: [
        { from: "leak@gmail.com" },
        { body: "visit https://real-site.io/path" },
        { snippet: "call 010-9876-5432" },
      ],
    });
    const findings = lintPii(doc);
    expect(findings.some((f) => f.includes("leak@gmail.com"))).toBe(true);
    expect(findings.some((f) => f.includes("real-site.io"))).toBe(true);
    expect(findings.some((f) => f.includes("9876"))).toBe(true);
  });

  it("does not treat ISO dates or short codes as PII", () => {
    const doc = JSON.stringify({ items: [{ body: "INV-2291 due 2026-07-25" }] });
    expect(lintPii(doc)).toEqual([]);
  });
});

describe("lintPii — JSON escape artifacts", () => {
  it("does not misread \\n-adjacent placeholders as leaks", () => {
    const doc = JSON.stringify({
      items: [{ body: "line one\nperson-4@domain-4.example\nhttps://link-2.example" }],
    });
    expect(lintPii(doc)).toEqual([]);
  });

  it("still catches a real address after a newline", () => {
    const doc = JSON.stringify({ items: [{ body: "hello\nreal.leak@gmail.com" }] });
    expect(lintPii(doc).some((f) => f.includes("real.leak@gmail.com"))).toBe(true);
  });
});

describe("role-preserving placeholders (instrument correctness)", () => {
  it("keeps machine-role local-parts so sender floors still fire on the eval", () => {
    const ctx = createScrubContext();
    expect(scrubText("Vercel <notifications@vercel.com>", ctx).text).toBe(
      "Vercel <notifications@domain-1.example>",
    );
    expect(scrubText("noreply@stripe.com", ctx).text).toBe("noreply@domain-2.example");
    expect(scrubText("messages-noreply@linkedin.com", ctx).text).toBe(
      "messages-noreply@domain-3.example",
    );
    // Human-looking locals stay anonymized as person-N.
    expect(scrubText("jane@acme.com", ctx).text).toBe("person-4@domain-4.example");
  });

  it("the linter accepts role placeholders and still flags real addresses", () => {
    const clean = JSON.stringify({
      items: [{ from: "notifications@domain-1.example", body: "noreply@domain-2.example" }],
    });
    expect(lintPii(clean)).toEqual([]);
    expect(lintPii(JSON.stringify({ from: "noreply@vercel.com" })).length).toBe(1);
  });
});
