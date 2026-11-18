import { describe, expect, it } from "vitest";
import {
  contactContextLabel,
  followUpContent,
  replyWaitContent,
  senderLabel,
} from "../agentcore/reply-wait-content.js";

const NOW = new Date("2026-11-18T00:30:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function mail(from: string, subject: string | null, ageMs = 3 * DAY + 3_600_000, reason?: string) {
  return { id: `m-${from}`, from, subject, receivedAt: new Date(NOW.getTime() - ageMs), reason };
}

describe("senderLabel", () => {
  it("uses the display name", () => {
    expect(senderLabel("Terry Smith <terry@acme.com>", "en")).toBe("Terry Smith");
  });

  it("never shows the full address when there is no name: the domain only", () => {
    expect(senderLabel("terry@acme.com", "en")).toBe("acme.com");
    expect(senderLabel("<terry@acme.com>", "en")).toBe("acme.com");
  });

  it("treats a display name that is itself an address as no name", () => {
    const out = senderLabel('"terry@acme.com" <terry@acme.com>', "en");
    expect(out).toBe("acme.com");
    expect(out).not.toContain("@");
  });

  it("falls back to the localized unknown sender", () => {
    expect(senderLabel("", "ko")).toBe("알 수 없는 발신자");
    expect(senderLabel(null, "zh")).toBe("未知发件人");
    expect(senderLabel(undefined, "en")).toBe("Unknown sender");
  });

  it("strips tags and controls from the name and bounds it", () => {
    const out = senderLabel(`<b>Ana</b>‮ ${"x".repeat(80)} <ana@acme.com>`, "en");
    expect(out).not.toMatch(/[<>‮]/);
    expect(out.length).toBeLessThanOrEqual(40);
  });
});

describe("contactContextLabel", () => {
  it("drops the internal auto-added tag", () => {
    expect(contactContextLabel({ company: "Acme", role: "CFO", tags: "auto-added" })).toBe(
      " (Acme, CFO)",
    );
    expect(contactContextLabel({ company: null, role: null, tags: "auto-added" })).toBe("");
    expect(contactContextLabel({ company: null, role: null, tags: "vip, Auto-Added" })).toBe(
      " (vip)",
    );
  });
});

describe("replyWaitContent", () => {
  it("is null for no mail", () => {
    expect(replyWaitContent([], "en", NOW)).toBeNull();
  });

  it("one mail: title is the person, subtitle the subject, body the wait line (ko)", () => {
    const c = replyWaitContent(
      [
        mail(
          "Jun Park <jun@x.com>",
          "Board deck — numbers check",
          3 * DAY + 3_600_000,
          "숫자 확인 요청",
        ),
      ],
      "ko",
      NOW,
    );
    expect(c).toMatchObject({
      kind: "wait",
      title: "Jun Park",
      subtitle: "Board deck — numbers check",
      body: "3일째 답장 대기 · 숫자 확인 요청",
    });
    expect(c?.message).toBe("Board deck — numbers check\n3일째 답장 대기 · 숫자 확인 요청");
  });

  it("one mail without a reason: the wait line alone (en, zh)", () => {
    const en = replyWaitContent([mail("Jun Park <jun@x.com>", "Deck")], "en", NOW);
    expect(en?.body).toBe("Waiting 3 days for your reply");
    const zh = replyWaitContent([mail("Jun Park <jun@x.com>", "Deck")], "zh", NOW);
    expect(zh?.body).toBe("已等待回复3天");
  });

  it("several mails: the canonical digest (ko)", () => {
    const c = replyWaitContent(
      [
        mail("Terry Smith <terry@acme.com>", "견적서 최종 확인"),
        mail("Jun Park <jun@x.com>", "Board deck — numbers check"),
        mail("c@x.com", "Three"),
        mail("d@x.com", "Four"),
      ],
      "ko",
      NOW,
    );
    expect(c).toMatchObject({
      kind: "digest",
      title: "답장 대기 4건",
      subtitle: null,
      body: "Terry Smith · 견적서 최종 확인\nJun Park · Board deck — numbers check\n외 2건",
    });
    expect(c?.message).toBe(c?.body);
  });

  it("three mails fit on three lines without a 'more' line", () => {
    const c = replyWaitContent(
      [mail("A <a@x.com>", "One"), mail("B <b@x.com>", "Two"), mail("C <c@x.com>", "Three")],
      "en",
      NOW,
    );
    expect(c?.title).toBe("3 replies waiting");
    expect(c?.body).toBe("A · One\nB · Two\nC · Three");
  });

  it("pluralizes per language (en, zh)", () => {
    const four = [1, 2, 3, 4].map((n) => mail(`P${n} <p${n}@x.com>`, `S${n}`));
    expect(replyWaitContent(four, "en", NOW)?.body.split("\n")[2]).toBe("+2 more");
    expect(replyWaitContent(four, "zh", NOW)).toMatchObject({ title: "4封邮件待回复" });
    expect(replyWaitContent(four, "zh", NOW)?.body.split("\n")[2]).toBe("另外2封");
  });

  it("falls back to English for a removed or unknown language", () => {
    for (const lang of ["ja", "fr", "de", "es", "pt-BR", ""]) {
      expect(replyWaitContent([mail("A <a@x.com>", "S")], lang, NOW)?.body).toBe(
        "Waiting 3 days for your reply",
      );
    }
  });

  it("never puts a bare address into any line", () => {
    const c = replyWaitContent(
      [mail("ceo@evil.com", "Wire now"), mail("<cfo@evil.com>", null)],
      "en",
      NOW,
    );
    expect(`${c?.title}\n${c?.body}`).not.toContain("@");
    expect(c?.body).toBe("evil.com · Wire now\nevil.com · (no subject)");
  });

  it("cuts a long subject on a word boundary", () => {
    const c = replyWaitContent(
      [
        mail("A <a@x.com>", "Quarterly numbers for the board meeting that happens next week"),
        mail("B <b@x.com>", "x"),
      ],
      "en",
      NOW,
    );
    expect(c?.body.split("\n")[0]).toBe("A · Quarterly numbers for the board…");
  });
});

describe("followUpContent", () => {
  it("localizes and pluralizes the follow-up suggestion", () => {
    const one = followUpContent(
      [{ from: "Ana <ana@acme.com>", subject: "Deal", context: "" }],
      "en",
    );
    expect(one.title).toBe("1 email may need a follow-up");
    const ko = followUpContent(
      [
        { from: "Ana <ana@acme.com>", subject: "Deal", context: " (Acme, CFO)" },
        { from: "bob@acme.com", subject: null, context: "" },
      ],
      "ko",
    );
    expect(ko.title).toBe("후속 연락이 필요할 수 있는 메일 2건");
    expect(ko.message).toContain("Ana (Acme, CFO) · Deal");
    expect(ko.message).toContain("acme.com · (제목 없음)");
    expect(ko.message).not.toContain("bob@");
    expect(followUpContent([{ from: "A <a@x.com>", subject: "S", context: "" }], "zh").title).toBe(
      "1封邮件可能需要跟进",
    );
  });
});
