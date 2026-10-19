import { describe, expect, it } from "vitest";
import { detectSchedulingIntent, detectTransactionalNotice } from "../judge/keyword-policy.js";
import { TIER_THRESHOLDS, tierFromFeaturesV2 } from "../judge/tier-policy.js";
import { normalizeTier, TIERS } from "../judge/tiers.js";

const base = { confidence: 0.9, senderTrust: 0.6, reversibility: 0.5, urgency: 0.3 };
const noSignals = { scheduling: false, transactional: false };

describe("tier vocabulary v2", () => {
  it("includes MEETING and INFO as storage-valid tiers", () => {
    expect(TIERS).toContain("MEETING");
    expect(TIERS).toContain("INFO");
    expect(normalizeTier("MEETING")).toBe("MEETING");
    expect(normalizeTier("INFO")).toBe("INFO");
    // Legacy behaviors are unchanged.
    expect(normalizeTier("CALL")).toBe("PUSH");
    expect(normalizeTier("garbage")).toBe("QUEUE");
    expect(normalizeTier(null)).toBe("QUEUE");
  });
});

describe("tierFromFeaturesV2", () => {
  it("routes scheduling mail to MEETING regardless of urgency", () => {
    const calm = tierFromFeaturesV2(base, { ...noSignals, scheduling: true });
    expect(calm.tier).toBe("MEETING");
    const urgent = tierFromFeaturesV2(
      { ...base, urgency: 0.9 },
      { ...noSignals, scheduling: true },
    );
    expect(urgent.tier).toBe("MEETING");
  });

  it("keeps the v1 branches for non-scheduling mail", () => {
    expect(tierFromFeaturesV2({ ...base, confidence: 0.3 }, noSignals).tier).toBe("QUEUE");
    expect(tierFromFeaturesV2({ ...base, urgency: 0.9 }, noSignals).tier).toBe("PUSH");
    expect(
      tierFromFeaturesV2(
        { confidence: 0.9, senderTrust: 0.1, reversibility: 0.95, urgency: 0.1 },
        noSignals,
      ).tier,
    ).toBe("SILENT");
    expect(tierFromFeaturesV2(base, noSignals).tier).toBe("QUEUE");
  });

  it("routes calm transactional notices to INFO, but never urgent ones", () => {
    const calm = tierFromFeaturesV2(
      { ...base, senderTrust: 0.3 },
      { ...noSignals, transactional: true },
    );
    expect(calm.tier).toBe("INFO");
    const urgent = tierFromFeaturesV2(
      { ...base, senderTrust: 0.3, urgency: 0.9 },
      { ...noSignals, transactional: true },
    );
    expect(urgent.tier).not.toBe("INFO");
  });

  it("never emits AUTO", () => {
    // The exact v1 AUTO profile now lands in QUEUE with the flag instead.
    const v1AutoProfile = {
      confidence: 0.95,
      senderTrust: 0.8,
      reversibility: 0.95,
      urgency: 0.1,
    };
    const result = tierFromFeaturesV2(v1AutoProfile, noSignals);
    expect(result.tier).toBe("QUEUE");
    expect(result.autoEligible).toBe(true);
  });

  it("computes autoEligible only on QUEUE and MEETING, with the v1 AUTO floors", () => {
    const eligible = { confidence: 0.9, senderTrust: 0.7, reversibility: 0.9, urgency: 0.2 };
    expect(tierFromFeaturesV2(eligible, noSignals).autoEligible).toBe(true);
    expect(tierFromFeaturesV2(eligible, { ...noSignals, scheduling: true }).autoEligible).toBe(
      true,
    );
    // Push/silent/info are never auto-answerable.
    expect(tierFromFeaturesV2({ ...eligible, urgency: 0.9 }, noSignals).autoEligible).toBe(false);
    expect(
      tierFromFeaturesV2(
        { confidence: 0.9, senderTrust: 0.1, reversibility: 0.95, urgency: 0.1 },
        noSignals,
      ).autoEligible,
    ).toBe(false);
    expect(
      tierFromFeaturesV2({ ...eligible, senderTrust: 0.3 }, { ...noSignals, transactional: true })
        .autoEligible,
    ).toBe(false);
    // Below any AUTO floor → not eligible.
    expect(tierFromFeaturesV2({ ...eligible, reversibility: 0.5 }, noSignals).autoEligible).toBe(
      false,
    );
    expect(tierFromFeaturesV2({ ...eligible, senderTrust: 0.3 }, noSignals).autoEligible).toBe(
      false,
    );
  });

  it("keeps thresholds shared with v1 (no fork)", () => {
    // v2 reads the same threshold object — ontology overrides keep applying.
    expect(TIER_THRESHOLDS.push.urgency).toBeGreaterThan(0);
  });
});

describe("scheduling intent — bulk and automated 'invite' wording (prod 2026-10-05..18)", () => {
  // 28 of 30 MEETING items in prod over 14 days were these shapes, and MEETING
  // notifies. "invit" alone is not scheduling intent when the mail is bulk or
  // sent by a system account.
  it("ignores a LinkedIn connection invitation (social, bulk)", () => {
    expect(
      detectSchedulingIntent({
        from: "LinkedIn <invitations@linkedin.com>",
        subject: "You have an invitation ✉️",
        snippet: "Anna is waiting for your response",
        labels: ["UNREAD", "CATEGORY_SOCIAL", "INBOX"],
        hasListUnsubscribe: true,
      }),
    ).toBe(false);
  });

  it("ignores a referral promo filed under Updates when it carries List-Unsubscribe", () => {
    expect(
      detectSchedulingIntent({
        from: "Uber <uber@uber.com>",
        subject: "Ria, want 50% off your next 2 trips?",
        snippet: "Invite friends and family—claim savings.",
        labels: ["CATEGORY_UPDATES", "INBOX"],
        hasListUnsubscribe: true,
      }),
    ).toBe(false);
  });

  it("ignores promotions-category invites without a List-Unsubscribe header", () => {
    expect(
      detectSchedulingIntent({
        from: "anar@pitchhut.com",
        subject: "Your project Klorn is invited to join PitchHut",
        labels: ["CATEGORY_PROMOTIONS"],
      }),
    ).toBe(false);
  });

  it("ignores system-account invites (repo, workspace)", () => {
    expect(
      detectSchedulingIntent({
        from: "GitHub <noreply@github.com>",
        subject: "softmarshmallow invited you to gridaco/spock",
      }),
    ).toBe(false);
    expect(
      detectSchedulingIntent({
        from: "Notion <notify@mail.notion.so>",
        subject: "권오영 invited you to Consilience",
      }),
    ).toBe(false);
  });

  it("keeps a calendar invite even from an automated sender", () => {
    expect(
      detectSchedulingIntent({
        from: "Google Calendar <calendar-notification@google.com>",
        subject: "Invitation: Board sync @ Tue Oct 27, 2026 2pm - 3pm (KST)",
        hasListUnsubscribe: false,
      }),
    ).toBe(true);
    expect(
      detectSchedulingIntent({
        from: "calendar-notification@google.com",
        subject: "Updated invitation: Board sync @ Wed Oct 28, 2026",
      }),
    ).toBe(true);
  });

  it("keeps a person asking to reschedule", () => {
    expect(
      detectSchedulingIntent({
        from: "Dana Kim <dana@acme.io>",
        subject: "Can we reschedule Thursday?",
        labels: ["CATEGORY_PERSONAL", "INBOX"],
      }),
    ).toBe(true);
  });

  it("keeps reschedule notices from scheduling tools (not the noise source)", () => {
    expect(
      detectSchedulingIntent({
        from: "Calendly <notifications@calendly.com>",
        subject: "Event rescheduled: Intro call with Dana",
      }),
    ).toBe(true);
  });

  it("keeps a forwarded calendar invite", () => {
    expect(
      detectSchedulingIntent({
        from: "calendar-notification@google.com",
        subject: "Fwd: Invitation: Board sync @ Tue Oct 27, 2026",
      }),
    ).toBe(true);
  });

  it("keeps a person's invite when labels and headers are unknown (IMAP)", () => {
    expect(
      detectSchedulingIntent({ from: "dana@acme.io", subject: "Invite: design review next week" }),
    ).toBe(true);
  });

  it("treats invitations@ as a system sender", () => {
    expect(
      detectSchedulingIntent({ from: "invitations@example.com", subject: "You're invited" }),
    ).toBe(false);
  });

  it("still lets a join link through from a person", () => {
    expect(
      detectSchedulingIntent({
        from: "dana@acme.io",
        subject: "Quick chat",
        body: "Join: https://zoom.us/j/123",
      }),
    ).toBe(true);
  });
});

describe("scheduling / transactional detectors", () => {
  it("detects meeting invites by subject and meet links", () => {
    expect(
      detectSchedulingIntent({ subject: "Invitation: Board sync @ Tue", snippet: "", body: "" }),
    ).toBe(true);
    expect(detectSchedulingIntent({ subject: "미팅 일정 조율", snippet: "", body: "" })).toBe(true);
    expect(
      detectSchedulingIntent({
        subject: "Quick chat",
        snippet: "",
        body: "Join: https://meet.google.com/abc-defg-hij",
      }),
    ).toBe(true);
    expect(
      detectSchedulingIntent({ subject: "Invoice #123", snippet: "your receipt", body: "" }),
    ).toBe(false);
    // Marketing copy must not reach a lane that notifies (review 2026-08-15).
    expect(
      detectSchedulingIntent({ subject: "Your editorial calendar for Q4", snippet: "", body: "" }),
    ).toBe(false);
    expect(detectSchedulingIntent({ subject: "Zoom in on savings!", snippet: "", body: "" })).toBe(
      false,
    );
    expect(detectSchedulingIntent({ subject: "배송 일정 안내", snippet: "", body: "" })).toBe(
      false,
    );
    expect(
      detectSchedulingIntent({ subject: "다음주 일정 조율 부탁드립니다", snippet: "", body: "" }),
    ).toBe(true);
  });

  it("a bare meeting NOUN is not scheduling intent (eval misses, 2026-08-20)", () => {
    // Meeting NOTES — a recap of a past meeting, nothing to accept/decline.
    expect(
      detectSchedulingIntent({
        subject: "Notes from yesterday's product review",
        snippet: "Summary of decisions and owners from the meeting.",
        body: "",
      }),
    ).toBe(false);
    // Urgent human ask that merely MENTIONS a meeting — the request is the
    // deck, not attendance; this must stay on the PUSH path.
    expect(
      detectSchedulingIntent({
        subject: "Need the updated deck today",
        snippet: "Partner meeting moved up — can you send the latest deck today?",
        body: "",
      }),
    ).toBe(false);
  });

  it("a meeting noun WITH scheduling context still fires", () => {
    // Time-coordination reply — the mail from the founder's own inbox that
    // the lane exists for.
    expect(
      detectSchedulingIntent({
        subject: "Re: Can we move tomorrow to 4pm?",
        snippet: "Confirming meeting time",
        body: "",
      }),
    ).toBe(true);
    expect(
      detectSchedulingIntent({
        subject: "미팅 가능하신 시간 알려주세요",
        snippet: "",
        body: "",
      }),
    ).toBe(true);
  });

  it("detects transactional notices from automated senders only", () => {
    expect(
      detectTransactionalNotice({ from: "noreply@github.com", hasListUnsubscribe: false }),
    ).toBe(true);
    expect(detectTransactionalNotice({ from: "jane@example.com", hasListUnsubscribe: false })).toBe(
      false,
    );
    // Bulk marketing (List-Unsubscribe) is SILENT's territory, not INFO's.
    expect(detectTransactionalNotice({ from: "noreply@shop.com", hasListUnsubscribe: true })).toBe(
      false,
    );
  });
});

describe("eligibleAfterFloor", () => {
  it("clears eligibility when a floor rewrites the tier off QUEUE/MEETING", async () => {
    const { eligibleAfterFloor } = await import("../judge/poc-judge.js");
    expect(eligibleAfterFloor(true, "QUEUE")).toBe(true);
    expect(eligibleAfterFloor(true, "MEETING")).toBe(true);
    expect(eligibleAfterFloor(true, "SILENT")).toBe(false);
    expect(eligibleAfterFloor(true, "PUSH")).toBe(false);
    expect(eligibleAfterFloor(false, "QUEUE")).toBe(false);
  });
});
