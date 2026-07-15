import { describe, expect, it } from "vitest";
import {
  formatUrgentEmailBody,
  humanizeAutoExec,
  senderName,
} from "../notify/notification-format.js";

describe("senderName", () => {
  it("extracts display name from RFC-style address", () => {
    expect(senderName("Alice Park <alice@acme.com>")).toBe("Alice Park");
  });

  it("falls back to bare email", () => {
    expect(senderName("alice@acme.com")).toBe("alice@acme.com");
  });

  it("handles missing input", () => {
    expect(senderName(null)).toBe("Unknown sender");
    expect(senderName("")).toBe("Unknown sender");
  });

  it("truncates very long display names", () => {
    expect(senderName("A".repeat(60))).toHaveLength(30);
  });
});

describe("humanizeAutoExec", () => {
  it("translates classify_emails into clear English", () => {
    const out = humanizeAutoExec("classify_emails", {});
    expect(out.autoTitle).toBe("[Klorn] Mail prioritized");
    expect(out.autoMessage).not.toContain("classify_emails");
    expect(out.autoMessage).not.toContain("{");
  });

  it("uses recipient name for send_email", () => {
    const out = humanizeAutoExec("send_email", {
      to: "Sequoia Capital <ops@sequoia.com>",
      subject: "Re: term sheet review",
    });
    expect(out.autoTitle).toBe("[Klorn] Email sent");
    expect(out.autoMessage).toContain("Sequoia Capital");
    expect(out.autoMessage).toContain("term sheet review");
    expect(out.autoMessage).not.toContain("send_email");
  });

  it("falls back gracefully on unknown tool", () => {
    const out = humanizeAutoExec("frobnicate_widgets", { foo: "bar" });
    expect(out.autoTitle).toBe("[Klorn] Action complete");
    expect(out.autoMessage).toContain("frobnicate widgets");
    expect(out.autoMessage).not.toContain("{");
  });

  it("never leaks raw JSON args", () => {
    const out = humanizeAutoExec("create_task", {
      title: "Follow up with VC",
      raw: { nested: "data" },
    });
    expect(out.autoMessage).toContain("Follow up with VC");
    expect(out.autoMessage).not.toContain("nested");
  });
});

describe("formatUrgentEmailBody", () => {
  it("returns empty for no emails", () => {
    expect(formatUrgentEmailBody([])).toBe("");
  });

  it("formats single urgent email with sender name", () => {
    const out = formatUrgentEmailBody([
      { from: "Alice <alice@acme.com>", subject: "Contract signature needed", summary: null },
    ]);
    expect(out).toBe("Alice: Contract signature needed");
    expect(out).not.toContain("<");
  });

  it("uses summary if present", () => {
    const out = formatUrgentEmailBody([
      {
        from: "alice@acme.com",
        subject: "long subject line",
        summary: "Investor wants quick reply",
      },
    ]);
    expect(out).toContain("Investor wants quick reply");
  });

  it("counts multiple urgent emails", () => {
    const out = formatUrgentEmailBody([
      { from: "Alice <a@x.com>", subject: "First", summary: null },
      { from: "Bob <b@y.com>", subject: "Second", summary: null },
      { from: "Carol <c@z.com>", subject: "Third", summary: null },
    ]);
    expect(out).toContain("3 urgent emails");
    expect(out).toContain("Alice");
    expect(out).toContain("First");
  });

  it("never embeds gmailId-style internal IDs", () => {
    const out = formatUrgentEmailBody([{ from: "alice@acme.com", subject: "Hi", summary: null }]);
    expect(out).not.toMatch(/\[[a-f0-9]{8,}\]/);
  });
});
