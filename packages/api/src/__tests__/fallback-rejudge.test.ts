/**
 * Fallback-rejudge core — the self-healing path for provider-outage residue.
 *
 * A keyword-fallback judgment is permanent by default (the backfill sweep
 * only judges emails with NO AttentionItem). rejudgeFallbackItems repairs
 * eligible rows through the production judge path; sweepFallbackRejudge is
 * the flag-gated scheduler entry (FALLBACK_REJUDGE_SWEEP, default OFF).
 *
 * Contract under test:
 *  - targets ONLY decidedBy=keyword-fallback + outcome:null + OPEN + not
 *    manually overridden
 *  - dryRun judges but never writes
 *  - apply updates the AttentionItem (guards re-checked in the WHERE) and
 *    records the ledger via recordEmailDecision (no second write path)
 *  - a re-judge that itself returns keyword-fallback aborts the run
 *    (provider still degraded — retry next tick, don't burn the batch)
 *  - sweepFallbackRejudge is a no-op while the flag is off
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  decisionLabel: { findMany: vi.fn() },
  attentionItem: { findMany: vi.fn(), updateMany: vi.fn() },
  emailMessage: { findUnique: vi.fn() },
}));
const judgeEmailMock = vi.hoisted(() => vi.fn());
const buildContextMock = vi.hoisted(() => vi.fn());
const recordDecisionMock = vi.hoisted(() => vi.fn());
const flagState = vi.hoisted(() => ({ sweep: false }));

vi.mock("../db.js", () => ({ prisma: dbMock, db: dbMock }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../judge/poc-judge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../judge/poc-judge.js")>();
  return { ...actual, judgeEmail: judgeEmailMock };
});
vi.mock("../judge/judge-context.js", () => ({ buildJudgeContext: buildContextMock }));
vi.mock("../judge/decision-label.js", () => ({ recordEmailDecision: recordDecisionMock }));
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    ...actual,
    get FALLBACK_REJUDGE_SWEEP() {
      return flagState.sweep;
    },
  };
});

import { rejudgeFallbackItems, sweepFallbackRejudge } from "../judge/fallback-rejudge.js";

const LLM_JUDGEMENT = {
  tier: "PUSH",
  reason: "Urgent and confident",
  features: { confidence: 0.9, senderTrust: 0.8, reversibility: 0.5, urgency: 0.9 },
  source: "llm",
};

function wire({ tiers = ["QUEUE"] }: { tiers?: string[] } = {}) {
  dbMock.decisionLabel.findMany.mockResolvedValue(
    tiers.map((_, i) => ({ sourceId: `m${i}`, shownTier: "QUEUE" })),
  );
  dbMock.attentionItem.findMany.mockResolvedValue(
    tiers.map((tier, i) => ({ id: `a${i}`, sourceId: `m${i}`, tier })),
  );
  dbMock.emailMessage.findUnique.mockImplementation(async ({ where }: never) => ({
    id: (where as { id: string }).id,
    from: "Sender <s@corp.com>",
    subject: "subject",
    snippet: null,
    body: null,
    labels: [],
  }));
  buildContextMock.mockResolvedValue({ senderFacts: null });
  judgeEmailMock.mockResolvedValue(LLM_JUDGEMENT);
  dbMock.attentionItem.updateMany.mockResolvedValue({ count: 1 });
}

beforeEach(() => {
  vi.clearAllMocks();
  flagState.sweep = false;
});

describe("rejudgeFallbackItems", () => {
  it("dry run judges through the prod path but writes nothing", async () => {
    wire();
    const summary = await rejudgeFallbackItems("u1", { apply: false, delayMs: 0 });
    expect(summary).toEqual({ changed: 1, unchanged: 0, skippedFallback: 0 });
    expect(judgeEmailMock).toHaveBeenCalledTimes(1);
    expect(dbMock.attentionItem.updateMany).not.toHaveBeenCalled();
    expect(recordDecisionMock).not.toHaveBeenCalled();
  });

  it("apply updates the item with guards re-checked and records the ledger", async () => {
    wire();
    const summary = await rejudgeFallbackItems("u1", { apply: true, delayMs: 0 });
    expect(summary.changed).toBe(1);
    expect(dbMock.attentionItem.updateMany).toHaveBeenCalledWith({
      where: { id: "a0", status: "OPEN", isManualOverride: false },
      data: { tier: "PUSH", tierReason: "Urgent and confident" },
    });
    expect(recordDecisionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        sourceId: "m0",
        shownTier: "PUSH",
        decidedBy: "llm",
      }),
    );
  });

  it("counts an identical verdict as unchanged (still refreshes the ledger)", async () => {
    wire({ tiers: ["PUSH"] });
    const summary = await rejudgeFallbackItems("u1", { apply: true, delayMs: 0 });
    expect(summary).toEqual({ changed: 0, unchanged: 1, skippedFallback: 0 });
    expect(recordDecisionMock).toHaveBeenCalledTimes(1);
  });

  it("aborts the run when the re-judge itself comes back keyword-fallback", async () => {
    wire({ tiers: ["QUEUE", "QUEUE", "QUEUE"] });
    judgeEmailMock.mockResolvedValue({ ...LLM_JUDGEMENT, source: "keyword-fallback" });
    const summary = await rejudgeFallbackItems("u1", { apply: true, delayMs: 0 });
    expect(summary.skippedFallback).toBe(1);
    // Aborted after the first degraded result — the other two were not judged.
    expect(judgeEmailMock).toHaveBeenCalledTimes(1);
    expect(dbMock.attentionItem.updateMany).not.toHaveBeenCalled();
  });

  it("only targets fallback rows that still have an eligible attention item", async () => {
    dbMock.decisionLabel.findMany.mockResolvedValue([
      { sourceId: "m0", shownTier: "QUEUE" },
      { sourceId: "m-gone", shownTier: "QUEUE" },
    ]);
    dbMock.attentionItem.findMany.mockResolvedValue([{ id: "a0", sourceId: "m0", tier: "QUEUE" }]);
    dbMock.emailMessage.findUnique.mockResolvedValue({
      id: "m0",
      from: "Sender <s@corp.com>",
      subject: "subject",
      snippet: null,
      body: null,
      labels: [],
    });
    buildContextMock.mockResolvedValue({ senderFacts: null });
    judgeEmailMock.mockResolvedValue(LLM_JUDGEMENT);
    await rejudgeFallbackItems("u1", { apply: false, delayMs: 0 });
    expect(judgeEmailMock).toHaveBeenCalledTimes(1);
  });
});

describe("sweepFallbackRejudge (scheduler entry)", () => {
  it("is a no-op while FALLBACK_REJUDGE_SWEEP is off", async () => {
    wire();
    const n = await sweepFallbackRejudge("u1");
    expect(n).toBe(0);
    expect(dbMock.decisionLabel.findMany).not.toHaveBeenCalled();
  });

  it("applies a bounded batch when the flag is on", async () => {
    flagState.sweep = true;
    wire();
    const n = await sweepFallbackRejudge("u1");
    expect(n).toBe(1);
    expect(dbMock.attentionItem.updateMany).toHaveBeenCalledTimes(1);
  });
});
