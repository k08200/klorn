import { describe, expect, it } from "vitest";
import { deterministicPreFacts, type PreFactsInput } from "../judge/v3/pre-facts.js";

const me = "me@acme.com";
const mail = (over: Partial<PreFactsInput> = {}): PreFactsInput => ({
  from: "Sarah Kim <sarah@partner.io>",
  to: me,
  cc: null,
  userAddresses: [me],
  subject: "Contract next steps",
  snippet: "Could you confirm the date?",
  body: null,
  labels: ["INBOX", "CATEGORY_PERSONAL"],
  hasListUnsubscribe: false,
  listId: null,
  precedence: null,
  autoSubmitted: null,
  hasCalendarInvite: false,
  userRepliedAfter: null,
  ...over,
});

describe("deterministicPreFacts — addressedTo", () => {
  it("is certain me_direct when the user is a To recipient of a small list", () => {
    const p = deterministicPreFacts(mail({ to: `${me}, Bob <bob@acme.com>` }));
    expect(p.facts.addressedTo).toBe("me_direct");
    expect(p.certain).toContain("addressedTo");
  });

  it("matches the user's address case-insensitively and through display names", () => {
    const p = deterministicPreFacts(mail({ to: "Me Myself <ME@Acme.com>" }));
    expect(p.facts.addressedTo).toBe("me_direct");
  });

  it("is me_cc when the user is only on Cc", () => {
    const p = deterministicPreFacts(mail({ to: "bob@acme.com", cc: me }));
    expect(p.facts.addressedTo).toBe("me_cc");
    expect(p.certain).toContain("addressedTo");
  });

  it("is group when the user is one of many recipients", () => {
    const many = Array.from({ length: 12 }, (_, i) => `p${i}@acme.com`).join(", ");
    expect(deterministicPreFacts(mail({ to: `${me}, ${many}` })).facts.addressedTo).toBe("group");
    expect(deterministicPreFacts(mail({ to: many, cc: me })).facts.addressedTo).toBe("group");
  });

  it("is certain bulk for list mail, whatever the To header says", () => {
    for (const over of [
      { hasListUnsubscribe: true },
      { listId: "<announce.lists.example.com>" },
      { precedence: "bulk" },
      { precedence: "List" },
      { labels: ["CATEGORY_PROMOTIONS"] },
      { labels: ["CATEGORY_SOCIAL"] },
    ] satisfies Partial<PreFactsInput>[]) {
      const p = deterministicPreFacts(mail(over));
      expect(p.facts.addressedTo, JSON.stringify(over)).toBe("bulk");
      expect(p.certain).toContain("addressedTo");
    }
  });

  it("is group for a forums-category mail", () => {
    const p = deterministicPreFacts(mail({ labels: ["CATEGORY_FORUMS"] }));
    expect(p.facts.addressedTo).toBe("group");
  });

  it("leaves addressedTo to the model when the user's address is unknown or absent", () => {
    expect(deterministicPreFacts(mail({ userAddresses: [] })).facts.addressedTo).toBeUndefined();
    const bcc = deterministicPreFacts(mail({ to: "team@acme.com" }));
    expect(bcc.facts.addressedTo).toBeUndefined();
    expect(bcc.certain).not.toContain("addressedTo");
    expect(bcc.signals.userInTo).toBe(false);
  });
});

describe("deterministicPreFacts — kind, event, threadTurn, asks", () => {
  it("marks Gmail promotions and marketing subjects as promotion", () => {
    const promo = deterministicPreFacts(mail({ labels: ["CATEGORY_PROMOTIONS"] }));
    expect(promo.facts.kind).toBe("promotion");
    expect(promo.certain).toContain("kind");
    const ad = deterministicPreFacts(mail({ subject: "[광고] 가을 할인" }));
    expect(ad.facts.kind).toBe("promotion");
  });

  it("marks social-category mail as a notification", () => {
    const p = deterministicPreFacts(mail({ labels: ["CATEGORY_SOCIAL"] }));
    expect(p.facts.kind).toBe("notification");
  });

  it("treats an ICS invite as a certain meeting event (times still come from the model)", () => {
    const p = deterministicPreFacts(mail({ hasCalendarInvite: true }));
    expect(p.facts.kind).toBe("meeting");
    expect(p.facts.event).toEqual({ proposedTimes: [], hasInvite: true, conflict: null });
    expect(p.certain).toEqual(expect.arrayContaining(["kind", "event"]));
  });

  it("treats an invitation subject as a hint only: anyone can write one", () => {
    const p = deterministicPreFacts(
      mail({
        from: "calendar-notification@google.com",
        subject: "Invitation: Board sync @ Tue Nov 3, 2026 10am",
      }),
    );
    expect(p.signals.inviteSubject).toBe(true);
    expect(p.signals.icsInvite).toBe(false);
    expect(p.facts.event).toBeUndefined();
    expect(p.certain).not.toContain("event");
    expect(p.certain).not.toContain("kind");
  });

  it("bounds the recipient scan on an attacker-sized To header", () => {
    const huge = Array.from({ length: 200_000 }, (_, i) => `p${i}@x.com`).join(", ");
    const started = process.cpuUsage();
    const p = deterministicPreFacts(mail({ to: `${me}, ${huge}` }));
    const cpuMs = (process.cpuUsage(started).user + process.cpuUsage(started).system) / 1000;
    expect(p.signals.toCount).toBeLessThan(1000);
    expect(p.facts.addressedTo).toBe("group");
    expect(cpuMs).toBeLessThan(2000);
  });

  it("does not let a marketing ICS (webinar blast) become a meeting", () => {
    const p = deterministicPreFacts(
      mail({ hasCalendarInvite: true, hasListUnsubscribe: true, labels: ["CATEGORY_PROMOTIONS"] }),
    );
    expect(p.facts.kind).toBe("promotion");
    expect(p.facts.addressedTo).toBe("bulk");
  });

  it("sets threadTurn none for no-reply and bulk senders", () => {
    expect(deterministicPreFacts(mail({ from: "no-reply@bank.com" })).facts.threadTurn).toBe(
      "none",
    );
    expect(deterministicPreFacts(mail({ hasListUnsubscribe: true })).facts.threadTurn).toBe("none");
  });

  it("sets threadTurn theirs when the user already replied after this mail", () => {
    const p = deterministicPreFacts(mail({ userRepliedAfter: true }));
    expect(p.facts.threadTurn).toBe("theirs");
    expect(p.certain).toContain("threadTurn");
  });

  it("leaves threadTurn to the model for an unanswered human mail", () => {
    const p = deterministicPreFacts(mail({ userRepliedAfter: false }));
    expect(p.facts.threadTurn).toBeUndefined();
  });

  it("fixes no fact from the spam label (Gmail misfiles real mail); it is a signal only", () => {
    const p = deterministicPreFacts(mail({ labels: ["SPAM"] }));
    expect(p.signals.spam).toBe(true);
    expect(p.facts.asks).toBeUndefined();
    expect(p.facts.kind).toBeUndefined();
    expect(p.facts.addressedTo).toBe("me_direct");
  });

  it("never marks asks/risk/transaction/ambiguous certain for ordinary mail", () => {
    const p = deterministicPreFacts(mail());
    for (const f of ["asks", "risk", "transaction", "ambiguous"] as const) {
      expect(p.certain).not.toContain(f);
    }
  });

  it("exposes detector signals for the prompt and for audit", () => {
    const p = deterministicPreFacts(
      mail({ from: "ship-confirm@shop.com", autoSubmitted: "auto-generated" }),
    );
    expect(p.signals).toMatchObject({
      automatedSender: true,
      transactionalSender: true,
      autoSubmitted: true,
    });
  });

  it("is pure: same input, same output; input untouched", () => {
    const input = mail({ to: `${me}, bob@acme.com`, labels: ["INBOX"] });
    const before = structuredClone(input);
    expect(deterministicPreFacts(input)).toEqual(deterministicPreFacts(input));
    expect(input).toEqual(before);
  });
});
