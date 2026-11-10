import { describe, expect, it } from "vitest";
import {
  formatUrgentEmailBody,
  humanizeAutoExec,
  senderEmail,
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

// Notification chrome is Klorn's own voice, so it follows the user's chosen
// language — unlike a reply, which follows the language of the mail it answers.
// Before this, every banner was hardcoded English regardless of the setting.
describe("notification language", () => {
  it("formats the urgent-mail body in Korean when that is the user's language", () => {
    const out = formatUrgentEmailBody(
      [{ from: "김영희 <y@acme.kr>", subject: "계약서 검토 부탁드립니다", summary: null }],
      "ko",
    );
    expect(out).toContain("김영희");
    expect(out).toContain("계약서 검토 부탁드립니다");
  });

  it("pluralizes the multi-mail summary in Korean without an English word", () => {
    const out = formatUrgentEmailBody(
      [
        { from: "A <a@x.com>", subject: "First", summary: null },
        { from: "B <b@y.com>", subject: "Second", summary: null },
      ],
      "ko",
    );
    expect(out).toContain("2");
    expect(out).not.toMatch(/urgent emails/i);
  });

  it("keeps English as the default when no language is given", () => {
    const out = formatUrgentEmailBody([
      { from: "A <a@x.com>", subject: "First", summary: null },
      { from: "B <b@y.com>", subject: "Second", summary: null },
    ]);
    expect(out).toContain("2 urgent emails");
  });

  it("translates auto-exec summaries", () => {
    const ko = humanizeAutoExec("classify_emails", {}, "ko");
    expect(ko.autoTitle).toContain("[Klorn]");
    expect(ko.autoTitle).not.toMatch(/Mail prioritized/i);
    const en = humanizeAutoExec("classify_emails", {});
    expect(en.autoTitle).toBe("[Klorn] Mail prioritized");
  });

  it("falls back to English for a language it does not ship", () => {
    // fr shipped in 2026-08-23; pt is the current stand-in for "unshipped".
    const out = formatUrgentEmailBody(
      [
        { from: "A <a@x.com>", subject: "First", summary: null },
        { from: "B <b@y.com>", subject: "Second", summary: null },
      ],
      "pt",
    );
    expect(out).toContain("2 urgent emails");
  });

  it("keeps an unknown sender label in the chosen language", () => {
    expect(senderName(null, "ko")).not.toBe("Unknown sender");
    expect(senderName(null)).toBe("Unknown sender");
  });
});

describe("senderEmail", () => {
  it.each([
    ["Name <A@B.com>", "a@b.com"],
    ["a@b.com", "a@b.com"],
    ["Sarah :( <s@x.com>", "s@x.com"],
    ['"<victim@target.com>" <attacker@evil.co>', "attacker@evil.co"],
    ["<attacker@evil.co>, <victim@target.com>", ""],
    ["No Address", ""],
    [null, ""],
  ])("%j → %j", (raw, address) => {
    expect(senderEmail(raw)).toBe(address);
  });
});
