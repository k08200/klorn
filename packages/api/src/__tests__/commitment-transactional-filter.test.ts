import { beforeEach, describe, expect, it, vi } from "vitest";

// Order-confirmation / shipping emails were being mined as dated COUNTERPARTY
// commitments ("Order will arrive Tuesday" → a fake promise on the ledger),
// because the broad rule matched them, the LLM refiner is off by default
// (fail-open), and nothing gated transactional mail upstream. These tests pin
// the two deterministic guards: an automated-sender gate (F1) and a
// transactional-text denylist (F2).

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

import { isNoReplySender, isTransactionalSender } from "../keyword-policy.js";
import { extractCommitmentCandidates } from "../pim/commitment-extractor.js";
import { extractAndUpsertCommitmentsFromText } from "../pim/commitment-ingestion.js";

describe("isNoReplySender (F1 helper)", () => {
  it("flags no-reply / do-not-reply machine senders", () => {
    expect(isNoReplySender("no-reply@amazon.com")).toBe(true);
    expect(isNoReplySender("noreply@shop.example")).toBe(true);
    expect(isNoReplySender("donotreply@store.example")).toBe(true);
  });
  it("does NOT flag people or commitment-bearing notifications (github/jira/linear)", () => {
    expect(isNoReplySender("sarah@company.com")).toBe(false);
    expect(isNoReplySender("notifications@github.com")).toBe(false);
    expect(isNoReplySender("notifications@linear.app")).toBe(false);
  });
});

describe("isTransactionalSender (F3 helper — logistics role addresses)", () => {
  it("flags shipping/order/delivery role senders (non no-reply, would evade F1+F2)", () => {
    expect(isTransactionalSender("ship-confirm@fedex.com")).toBe(true);
    expect(isTransactionalSender("order-update@amazon.com")).toBe(true);
    expect(isTransactionalSender("orders@store.example")).toBe(true);
    expect(isTransactionalSender("orderstatus@shop.example")).toBe(true);
    expect(isTransactionalSender("shipment@ups.com")).toBe(true);
    expect(isTransactionalSender("delivery@dhl.com")).toBe(true);
    expect(isTransactionalSender("tracking@store.example")).toBe(true);
    expect(isTransactionalSender("dispatch@store.example")).toBe(true);
  });
  it("does NOT flag people, teams, or commitment-bearing notifications", () => {
    // The token must be a standalone role word — names/words that merely contain
    // it must not match, or a real person's promise would be silently dropped.
    expect(isTransactionalSender("sarah@company.com")).toBe(false);
    expect(isTransactionalSender("shipley@company.com")).toBe(false);
    expect(isTransactionalSender("jordan@company.com")).toBe(false);
    expect(isTransactionalSender("gordon@company.com")).toBe(false);
    expect(isTransactionalSender("leadership@company.com")).toBe(false);
    expect(isTransactionalSender("notifications@github.com")).toBe(false);
    expect(isTransactionalSender("notifications@linear.app")).toBe(false);
  });
});

describe("extractCommitmentCandidates — transactional/shipping denylist (F2)", () => {
  it("drops shipping/order notifications even when the broad COUNTERPARTY rule matches", () => {
    expect(extractCommitmentCandidates("Order will arrive Tuesday.")).toHaveLength(0);
    expect(extractCommitmentCandidates("Amazon will deliver your package Monday.")).toHaveLength(0);
    expect(extractCommitmentCandidates("Order will be delivered Monday.")).toHaveLength(0);
    expect(extractCommitmentCandidates("Delivery will be attempted tomorrow.")).toHaveLength(0);
  });
  it("KEEPS real interpersonal commitments (no over-blocking)", () => {
    expect(extractCommitmentCandidates("Sarah will send the deck Friday.").length).toBeGreaterThan(
      0,
    );
    // "deliver" the verb (vs the "delivery" noun / "will be delivered" phrase)
    // must survive — a real project deliverable is not shipping noise.
    expect(
      extractCommitmentCandidates("Sarah will deliver the project Friday.").length,
    ).toBeGreaterThan(0);
    // "ship" (release software), "order", "refund" are real commitment verbs for
    // klorn's users — the shipping denylist must not catch them in verb position.
    expect(
      extractCommitmentCandidates("Sarah will ship the v2 release Friday.").length,
    ).toBeGreaterThan(0);
    expect(
      extractCommitmentCandidates("John will order the laptops Monday.").length,
    ).toBeGreaterThan(0);
    expect(
      extractCommitmentCandidates("He will refund the customer today.").length,
    ).toBeGreaterThan(0);
  });
});

describe("extractAndUpsertCommitmentsFromText — no-reply gate (F1)", () => {
  beforeEach(() => {
    upsertCalls.length = 0;
  });

  it("creates 0 commitments for an order-confirmation email from a no-reply sender", async () => {
    const result = await extractAndUpsertCommitmentsFromText({
      userId: "user-1",
      sourceType: "EMAIL",
      sourceId: "email-1",
      text: "Thanks for your order. Amazon will deliver your package Monday.",
      senderEmail: "no-reply@amazon.com",
    });
    expect(result.commitmentsCreated).toBe(0);
    expect(upsertCalls).toHaveLength(0);
  });

  it("still creates a commitment from a real person's email", async () => {
    const result = await extractAndUpsertCommitmentsFromText({
      userId: "user-1",
      sourceType: "EMAIL",
      sourceId: "email-2",
      text: "I will send the report tomorrow.",
      senderEmail: "sarah@company.com",
    });
    expect(result.commitmentsCreated).toBe(1);
  });

  it("still mines commitments from project-tool notifications (notifications@ is not gated)", async () => {
    const result = await extractAndUpsertCommitmentsFromText({
      userId: "user-1",
      sourceType: "EMAIL",
      sourceId: "email-3",
      text: "Sarah will review the PR Friday.",
      senderEmail: "notifications@github.com",
    });
    expect(result.commitmentsCreated).toBe(1);
  });

  it("creates 0 commitments for a logistics role sender even when text evades F2 (F3 gate)", async () => {
    // ship-confirm@ is NOT no-reply (F1 misses) and a refund/return line carries
    // no shipping noun (F2 misses) — the role-address gate is the backstop.
    const result = await extractAndUpsertCommitmentsFromText({
      userId: "user-1",
      sourceType: "EMAIL",
      sourceId: "email-4",
      text: "We will refund your return within 5 business days.",
      senderEmail: "ship-confirm@fedex.com",
    });
    expect(result.commitmentsCreated).toBe(0);
    expect(upsertCalls).toHaveLength(0);
  });
});
