import { beforeEach, describe, expect, it, vi } from "vitest";

// Founder screen audit 2026-07-22: /api/commitments?status=OPEN contained
// (1) an automated appointment notice ("You will not be allowed to join the
//     queue for entry until 10 minutes prior to your scheduled appointment…")
//     saved as a WAITING-ON commitment, and
// (2) counterparty first-person promises ("I'll push it back to them now",
//     "I'll route it for signature immediately") saved as I-OWE commitments —
//     the SENDER's "I" was attributed to the user.
// These tests pin the four fixes: a second-person / negated-permission text
// filter in the extractor, a case-insensitive no-reply sender gate, the
// automated-sender + List-Unsubscribe ingestion gates, and sender-perspective
// owner attribution for EMAIL sources.

const upsertCalls: Array<{ userId: string; input: Record<string, unknown> }> = [];
vi.mock("../db.js", () => ({
  prisma: { commitment: { findUnique: vi.fn(async () => null) } },
}));
vi.mock("../pim/commitments.js", () => ({
  upsertCommitment: vi.fn(async (userId: string, input: Record<string, unknown>) => {
    upsertCalls.push({ userId, input });
    return { id: "c-1", ...input };
  }),
}));

import { isNoReplySender } from "../judge/keyword-policy.js";
import { extractCommitmentCandidates } from "../pim/commitment-extractor.js";
import { extractAndUpsertCommitmentsFromText } from "../pim/commitment-ingestion.js";

const APPOINTMENT_NOTICE =
  "You will not be allowed to join the queue for entry until 10 minutes prior " +
  "to your scheduled appointment. Please plan your arrival accordingly.";

describe("extractCommitmentCandidates — second-person / policy-notice filter", () => {
  it("drops appointment boilerplate addressed to the recipient (founder screen #1)", () => {
    expect(extractCommitmentCandidates(APPOINTMENT_NOTICE)).toHaveLength(0);
  });

  it("drops negated-permission notices regardless of subject", () => {
    expect(
      extractCommitmentCandidates("Applicants will not be permitted to enter before check-in."),
    ).toHaveLength(0);
    expect(
      extractCommitmentCandidates("Visitors will not be able to park on site next week."),
    ).toHaveLength(0);
  });

  it("KEEPS real third-person counterparty promises (no over-blocking)", () => {
    expect(
      extractCommitmentCandidates("Sarah will send the contract tomorrow afternoon.").length,
    ).toBeGreaterThan(0);
    expect(
      extractCommitmentCandidates("The team will share the roadmap next week.").length,
    ).toBeGreaterThan(0);
  });
});

describe("isNoReplySender — case-insensitive machine addresses", () => {
  it("flags mixed-case no-reply variants (the appointment notice sender form)", () => {
    expect(isNoReplySender("No-Reply@ttp.example.gov")).toBe(true);
    expect(isNoReplySender("DoNotReply@store.example")).toBe(true);
    expect(isNoReplySender("NOREPLY@shop.example")).toBe(true);
    expect(isNoReplySender("Trusted Traveler Program <No-Reply@ttp.example.gov>")).toBe(true);
  });

  it("still does not flag people", () => {
    expect(isNoReplySender("sarah@company.com")).toBe(false);
    expect(isNoReplySender("norep.lya@company.com")).toBe(false);
  });
});

describe("extractAndUpsertCommitmentsFromText — automated-mail gates", () => {
  beforeEach(() => {
    upsertCalls.length = 0;
  });

  it("creates 0 commitments when the email carries a List-Unsubscribe header", async () => {
    const result = await extractAndUpsertCommitmentsFromText({
      userId: "user-1",
      sourceType: "EMAIL",
      sourceId: "email-1",
      text: "We will send your entry pass tomorrow.",
      senderEmail: "events@venue.example",
      listUnsubscribe: true,
    });
    expect(result.commitmentsCreated).toBe(0);
    expect(upsertCalls).toHaveLength(0);
  });

  it("creates 0 commitments from a system-notification sender (founder decision 2026-07-22)", async () => {
    const result = await extractAndUpsertCommitmentsFromText({
      userId: "user-1",
      sourceType: "EMAIL",
      sourceId: "email-2",
      text: "Sarah will review the PR Friday.",
      senderEmail: "notifications@github.com",
    });
    expect(result.commitmentsCreated).toBe(0);
    expect(upsertCalls).toHaveLength(0);
  });

  it("creates 0 commitments from a mixed-case no-reply sender", async () => {
    const result = await extractAndUpsertCommitmentsFromText({
      userId: "user-1",
      sourceType: "EMAIL",
      sourceId: "email-3",
      text: APPOINTMENT_NOTICE,
      senderEmail: "Trusted Traveler Program <No-Reply@ttp.example.gov>",
    });
    expect(result.commitmentsCreated).toBe(0);
    expect(upsertCalls).toHaveLength(0);
  });
});

describe("extractAndUpsertCommitmentsFromText — EMAIL owner attribution (founder screen #2)", () => {
  beforeEach(() => {
    upsertCalls.length = 0;
  });

  it("attributes the sender's first-person promise to COUNTERPARTY, not the user", async () => {
    const result = await extractAndUpsertCommitmentsFromText({
      userId: "user-1",
      sourceType: "EMAIL",
      sourceId: "email-4",
      text: "Got it. I'll push it back to them now.",
      senderEmail: "colleague@partner.example",
    });
    expect(result.commitmentsCreated).toBe(1);
    expect(upsertCalls[0].input).toMatchObject({
      owner: "COUNTERPARTY",
      counterpartyEmail: "colleague@partner.example",
    });
  });

  it("keeps USER ownership when the user authored the email themselves", async () => {
    const result = await extractAndUpsertCommitmentsFromText({
      userId: "user-1",
      sourceType: "EMAIL",
      sourceId: "email-5",
      text: "I'll route it for signature immediately.",
      senderEmail: "me@founder.example",
      senderIsUser: true,
    });
    expect(result.commitmentsCreated).toBe(1);
    expect(upsertCalls[0].input).toMatchObject({ owner: "USER", counterpartyEmail: null });
  });

  it("keeps USER ownership for non-email sources (chat is the user's own voice)", async () => {
    const result = await extractAndUpsertCommitmentsFromText({
      userId: "user-1",
      sourceType: "CHAT",
      sourceId: "msg-1",
      text: "내일까지 자료 보내드릴게요.",
    });
    expect(result.commitmentsCreated).toBe(1);
    expect(upsertCalls[0].input).toMatchObject({ owner: "USER" });
  });

  it("rule-based confidence stays below the home surface threshold (0.7)", async () => {
    await extractAndUpsertCommitmentsFromText({
      userId: "user-1",
      sourceType: "EMAIL",
      sourceId: "email-6",
      text: "I'll take it back to them tonight. Sarah will send the contract tomorrow.",
      senderEmail: "colleague@partner.example",
    });
    expect(upsertCalls.length).toBeGreaterThan(0);
    for (const call of upsertCalls) {
      expect(call.input.confidence as number).toBeLessThan(0.7);
    }
  });
});
