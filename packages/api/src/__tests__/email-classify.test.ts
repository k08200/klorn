import { describe, expect, it } from "vitest";
import { dogfoodEmailClassificationFixtures } from "../__fixtures__/email-classification/dogfood.js";
import { evaluateEmailPriorityFixtures } from "../email-classification-eval.js";
import {
  classifyNeedsReplyFromSignals,
  classifyPriority,
  classifyPriorityDetailed,
  extractEmailAddress,
  parseAiSummary,
} from "../mail/email-sync.js";

describe("classifyPriority — heuristic gate before LLM", () => {
  describe("Gmail category labels (highest precedence)", () => {
    it("PROMOTIONS → LOW even with urgent subject", () => {
      expect(classifyPriority("brand@x.com", "긴급! 오늘까지", ["CATEGORY_PROMOTIONS"])).toBe(
        "LOW",
      );
    });
    it("SOCIAL → LOW", () => {
      expect(classifyPriority("notifications@x.com", "Hello", ["CATEGORY_SOCIAL"])).toBe("LOW");
    });
    it("SPAM → LOW", () => {
      expect(classifyPriority("anyone@x.com", "anything", ["SPAM"])).toBe("LOW");
    });
  });

  describe("LOW precedes URGENT — promotional Korean must stay LOW", () => {
    it("'긴급 할인!' from marketing → LOW", () => {
      expect(classifyPriority("marketing@brand.co.kr", "🔥 긴급 할인 오늘까지!")).toBe("LOW");
    });
    it("noreply sender always wins over urgent subject", () => {
      expect(classifyPriority("noreply@service.com", "URGENT: action required")).toBe("LOW");
    });
    it("subject containing '광고' is LOW regardless of sender", () => {
      expect(classifyPriority("ceo@bigco.com", "[광고] 신규 서비스 안내")).toBe("LOW");
    });
    it("'수신거부' marker → LOW", () => {
      expect(classifyPriority("info@x.com", "Newsletter 수신거부")).toBe("LOW");
    });
  });

  describe("URGENT signals (English + Korean)", () => {
    it("'urgent' in subject → URGENT", () => {
      expect(classifyPriority("vc@example.com", "Urgent: term sheet review")).toBe("URGENT");
    });
    it("'오늘까지' deadline → URGENT", () => {
      expect(classifyPriority("client@x.com", "계약서 오늘까지 회신 부탁드립니다")).toBe("URGENT");
    });
    it("'내일까지' deadline → URGENT", () => {
      expect(classifyPriority("partner@x.com", "검토 결과 내일까지 회신 가능?")).toBe("URGENT");
    });
    it("'ASAP' → URGENT", () => {
      expect(classifyPriority("legal@x.com", "Need your signature ASAP")).toBe("URGENT");
    });
    it("'즉시' → URGENT", () => {
      expect(classifyPriority("ops@x.com", "서버 장애 즉시 확인 필요")).toBe("URGENT");
    });
    it("'deadline' keyword → URGENT", () => {
      expect(classifyPriority("a@b.com", "Deadline reminder for invoice")).toBe("URGENT");
    });
    it("investor/fundraising sender with near-term review → URGENT", () => {
      const result = classifyPriorityDetailed(
        "Mina Park <mina@alpha-capital.com>",
        "Re: Seed round follow-up",
      );

      expect(result).toMatchObject({
        priority: "URGENT",
        reason: "investor_deadline_or_fundraising_signal",
      });
    });
  });

  describe("NORMAL signals", () => {
    it("'meeting' → NORMAL", () => {
      expect(classifyPriority("a@b.com", "Meeting next Tuesday?")).toBe("NORMAL");
    });
    it("'미팅' → NORMAL", () => {
      expect(classifyPriority("a@b.com", "다음 주 미팅 일정")).toBe("NORMAL");
    });
    it("'회의' → NORMAL", () => {
      expect(classifyPriority("a@b.com", "주간 회의 안건 공유")).toBe("NORMAL");
    });
    it("Korean reply prefix '회신' → NORMAL", () => {
      expect(classifyPriority("a@b.com", "회신: 제안서 검토 의견")).toBe("NORMAL");
    });
    it("'문의' → NORMAL", () => {
      expect(classifyPriority("a@b.com", "협업 관련 문의드립니다")).toBe("NORMAL");
    });
    it("'invoice' from billing@ → LOW (automated sender wins over invoice keyword)", () => {
      // Updated 2026-05-19: billing@/invoice@ senders are auto-classified
      // LOW so the recurring billing flood from Stripe/Toss/카카오페이 does
      // not page the user. A human asking about an invoice still surfaces
      // because the LLM keyword "invoice" + non-automated sender wins.
      expect(classifyPriority("billing@x.com", "Invoice INV-2026-001")).toBe("LOW");
    });
    it("'invoice' from human sender → NORMAL", () => {
      expect(classifyPriority("alice@customer.com", "Invoice INV-2026-001")).toBe("NORMAL");
    });
    it("'계약' → NORMAL", () => {
      expect(classifyPriority("a@b.com", "계약 조건 확인 부탁드립니다")).toBe("NORMAL");
    });
  });

  describe("Default fallback", () => {
    it("unrecognized subject → NORMAL", () => {
      expect(classifyPriority("anyone@example.com", "Just checking in")).toBe("NORMAL");
    });
  });

  describe("Case-insensitivity", () => {
    it("uppercase subject still classified", () => {
      expect(classifyPriority("a@b.com", "URGENT REPLY NEEDED")).toBe("URGENT");
    });
  });

  describe("dogfood fixture baseline", () => {
    it("has no known heuristic gaps against the redacted fixture set", () => {
      const report = evaluateEmailPriorityFixtures(dogfoodEmailClassificationFixtures);
      const mismatches = report.mismatches.map((fixture) => fixture.id);
      const knownGaps = dogfoodEmailClassificationFixtures
        .filter((fixture) => fixture.knownHeuristicGap)
        .map((fixture) => fixture.id);

      expect(mismatches).toEqual(knownGaps);
    });

    it("keeps non-gap dogfood cases pinned to the desired heuristic priority", () => {
      for (const fixture of dogfoodEmailClassificationFixtures.filter(
        (item) => !item.knownHeuristicGap,
      )) {
        expect(classifyPriority(fixture.from, fixture.subject, fixture.labels)).toBe(
          fixture.expectedSyncPriority,
        );
      }
    });
  });
});

describe("classifyNeedsReplyFromSignals — canonical reply-needed gate", () => {
  it("marks action-item emails as reply needed", () => {
    expect(
      classifyNeedsReplyFromSignals({
        from: "Sarah <sarah@example.com>",
        subject: "Can you send the deck?",
        category: "conversation",
        actionItems: ["덱 보내기"],
        priority: "NORMAL",
      }),
    ).toMatchObject({ needsReply: true, reason: "action_items_present" });
  });

  it("blocks no-reply/newsletter even with action-looking text", () => {
    expect(
      classifyNeedsReplyFromSignals({
        from: "noreply@service.com",
        subject: "Action required",
        category: "system",
        actionItems: ["확인"],
        priority: "URGENT",
      }),
    ).toMatchObject({ needsReply: false, reason: "automated_or_low_value_sender" });
  });

  it("uses subject reply language as a lower-confidence signal", () => {
    expect(
      classifyNeedsReplyFromSignals({
        from: "partner@example.com",
        subject: "검토 가능하신가요?",
        category: "meeting",
        priority: "NORMAL",
      }),
    ).toMatchObject({ needsReply: true, reason: "reply_language_in_subject" });
  });

  it("never flags mail sent by the inbox owner to themselves as reply needed", () => {
    expect(
      classifyNeedsReplyFromSignals({
        from: "Test User <test@example.com>",
        subject: "내나난",
        category: "conversation",
        actionItems: ["fix this later"],
        priority: "URGENT",
        userEmail: "test@example.com",
      }),
    ).toMatchObject({ needsReply: false, reason: "self_sent" });
  });

  it("self-sent check is case insensitive and tolerates surrounding whitespace", () => {
    expect(
      classifyNeedsReplyFromSignals({
        from: "  <Test@Example.com>  ",
        subject: "todo for tomorrow",
        category: "conversation",
        priority: "NORMAL",
        userEmail: "test@example.com",
      }),
    ).toMatchObject({ needsReply: false, reason: "self_sent" });
  });

  it("does not short-circuit when the userEmail is missing", () => {
    expect(
      classifyNeedsReplyFromSignals({
        from: "Test User <test@example.com>",
        subject: "Can you confirm?",
        category: "conversation",
        actionItems: ["confirm"],
        priority: "NORMAL",
      }),
    ).toMatchObject({ needsReply: true, reason: "action_items_present" });
  });
});

describe("extractEmailAddress", () => {
  it("pulls the angle-bracketed address from a From header", () => {
    expect(extractEmailAddress("Test User <test@example.com>")).toBe("test@example.com");
  });
  it("returns the lowercased bare address when no name is present", () => {
    expect(extractEmailAddress("FOO@BAR.com")).toBe("foo@bar.com");
  });
  it("trims surrounding whitespace", () => {
    expect(extractEmailAddress("  alice@example.com  ")).toBe("alice@example.com");
  });
});

describe("parseAiSummary", () => {
  it("maps a well-formed JSON response", () => {
    const result = parseAiSummary(
      JSON.stringify({
        summary: "Invoice due Friday",
        category: "billing",
        keyPoints: ["$2,450"],
        actionItems: ["pay"],
        sentiment: "neutral",
        priority: "URGENT",
      }),
      "Subject fallback",
    );
    expect(result.summary).toBe("Invoice due Friday");
    expect(result.category).toBe("billing");
    expect(result.priority).toBe("URGENT");
  });

  it("fills defaults for a partial response", () => {
    const result = parseAiSummary(JSON.stringify({ summary: "Hi" }), "Subject");
    expect(result.summary).toBe("Hi");
    expect(result.category).toBe("other");
    expect(result.keyPoints).toEqual([]);
    expect(result.sentiment).toBe("neutral");
    expect(result.priority).toBe("NORMAL");
  });

  it("falls back to the subject on non-JSON output instead of throwing", () => {
    // The :free model occasionally returns prose; this used to throw and get
    // swallowed, leaving the email unsummarized and re-tried forever.
    expect(() => parseAiSummary("Sorry, I cannot help with that.", "Real subject")).not.toThrow();
    expect(parseAiSummary("not json at all", "Real subject").summary).toBe("Real subject");
  });

  it("does not throw on null / array / primitive JSON", () => {
    expect(parseAiSummary("null", "S").summary).toBe("S");
    expect(parseAiSummary("[1,2,3]", "S").summary).toBe("S");
    expect(parseAiSummary("42", "S").summary).toBe("S");
  });

  it("handles the empty-object default", () => {
    expect(parseAiSummary("{}", "S").summary).toBe("S");
  });
});
