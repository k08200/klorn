/**
 * decision-label recorder: captures the tier the firewall SHOWED the user
 * (immutable, survives AttentionItem.tier override) + stamps the eventual
 * outcome. Best-effort — must never throw into the firewall path, but must
 * log a signal on failure (never silently swallow). Prisma is mocked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => {
  const prisma = {
    decisionLabel: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  return { prisma, db: prisma };
});

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { prisma } from "../db.js";
import {
  ENGAGEMENT_OUTCOMES,
  recordDecision,
  recordEmailDecision,
  stampDecisionOutcome,
  stampDecisionOutcomes,
  stampProviderEngagement,
} from "../judge/decision-label.js";
import { captureError } from "../sentry.js";

type DecisionLabelMock = {
  findUnique: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
};
const decisionLabel = (prisma as unknown as { decisionLabel: DecisionLabelMock }).decisionLabel;

const FEATURES = { confidence: 0.8, senderTrust: 0.6, reversibility: 0.4, urgency: 0.9 };

const DECISION = {
  userId: "user-1",
  sourceId: "email-1",
  shownTier: "PUSH" as const,
  features: FEATURES,
  sender: "boss@acme.example",
  decidedBy: "llm" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  decisionLabel.findUnique.mockResolvedValue(null);
  decisionLabel.upsert.mockResolvedValue({});
  decisionLabel.updateMany.mockResolvedValue({ count: 1 });
});

describe("recordEmailDecision", () => {
  it("records the shown tier, features, sender and decidedBy as an EMAIL ledger row", async () => {
    await recordEmailDecision(DECISION);

    expect(decisionLabel.upsert).toHaveBeenCalledTimes(1);
    const args = decisionLabel.upsert.mock.calls[0][0];
    expect(args.where).toEqual({
      userId_source_sourceId: { userId: "user-1", source: "EMAIL", sourceId: "email-1" },
    });
    expect(args.create).toMatchObject({
      userId: "user-1",
      source: "EMAIL",
      sourceId: "email-1",
      shownTier: "PUSH",
      features: FEATURES,
      sender: "boss@acme.example",
      decidedBy: "llm",
    });
    // The update path (re-judge) refreshes the decision but never the outcome.
    expect(args.update).toMatchObject({ shownTier: "PUSH", features: FEATURES });
    expect(args.update).not.toHaveProperty("outcome");
  });

  it("refreshes an OPEN row on re-judge (outcome still null)", async () => {
    decisionLabel.findUnique.mockResolvedValue({ outcome: null });
    await recordEmailDecision({ ...DECISION, shownTier: "QUEUE" });
    expect(decisionLabel.upsert).toHaveBeenCalledTimes(1);
    expect(decisionLabel.upsert.mock.calls[0][0].update.shownTier).toBe("QUEUE");
  });

  it("does NOT overwrite a frozen row — once the user has acted the label is ground truth", async () => {
    decisionLabel.findUnique.mockResolvedValue({ outcome: "OVERRIDE:PUSH" });
    await recordEmailDecision({ ...DECISION, shownTier: "QUEUE" });
    expect(decisionLabel.upsert).not.toHaveBeenCalled();
  });

  it("never throws into the firewall path, but logs the failure (no silent swallow)", async () => {
    decisionLabel.upsert.mockRejectedValue(new Error("db down"));
    await expect(recordEmailDecision(DECISION)).resolves.toBeUndefined();
    expect(captureError).toHaveBeenCalled();
  });
});

describe("recordDecision (source-aware)", () => {
  it("records a GITHUB ledger row keyed on (GITHUB, sourceId)", async () => {
    await recordDecision({
      userId: "user-1",
      source: "GITHUB",
      sourceId: "gh-thread-1",
      shownTier: "PUSH",
      features: FEATURES,
      sender: "acme/repo",
      decidedBy: "llm",
    });

    expect(decisionLabel.upsert).toHaveBeenCalledTimes(1);
    const args = decisionLabel.upsert.mock.calls[0][0];
    expect(args.where).toEqual({
      userId_source_sourceId: { userId: "user-1", source: "GITHUB", sourceId: "gh-thread-1" },
    });
    expect(args.create).toMatchObject({
      source: "GITHUB",
      sourceId: "gh-thread-1",
      shownTier: "PUSH",
      sender: "acme/repo",
    });
  });

  it("freezes a GITHUB row once the user has acted (outcome present)", async () => {
    decisionLabel.findUnique.mockResolvedValue({ outcome: "OVERRIDE:QUEUE" });
    await recordDecision({
      userId: "user-1",
      source: "GITHUB",
      sourceId: "gh-thread-1",
      shownTier: "SILENT",
      features: FEATURES,
    });
    expect(decisionLabel.upsert).not.toHaveBeenCalled();
  });
});

describe("stampDecisionOutcome", () => {
  it("stamps the outcome and outcomeAt only on a not-yet-stamped row (first action wins), scoped to the user", async () => {
    await stampDecisionOutcome("user-1", "EMAIL", "email-1", "OVERRIDE:PUSH");

    expect(decisionLabel.updateMany).toHaveBeenCalledTimes(1);
    const args = decisionLabel.updateMany.mock.calls[0][0];
    // userId is part of the filter so a stamp can never touch another user's row.
    expect(args.where).toEqual({
      userId: "user-1",
      source: "EMAIL",
      sourceId: "email-1",
      outcome: null,
    });
    expect(args.data.outcome).toBe("OVERRIDE:PUSH");
    expect(args.data.outcomeAt).toBeInstanceOf(Date);
  });

  it("never throws, logs on failure", async () => {
    decisionLabel.updateMany.mockRejectedValue(new Error("db down"));
    await expect(
      stampDecisionOutcome("user-1", "EMAIL", "email-1", "DISMISSED"),
    ).resolves.toBeUndefined();
    expect(captureError).toHaveBeenCalled();
  });

  // An engagement signal must never land in `outcome`: fallback-rejudge selects
  // outcome:null rows, the override/confirm stamps are outcome:null-guarded, and
  // the AUTO calibrator reads any non-override outcome as agreement. Each kind
  // gets its own first-wins column instead.
  it.each([
    ["OPENED", "openedAt"],
    ["REPLIED", "repliedAt"],
    ["ARCHIVED", "archivedAt"],
    ["DISMISSED", "dismissedAt"],
    ["SNOOZED", "snoozedAt"],
    ["STARRED", "starredAt"],
    ["UNSUBSCRIBED", "unsubscribedAt"],
  ] as const)("stamps %s into %s only while that column is empty, never into outcome", async (kind, column) => {
    await stampDecisionOutcome("user-1", "EMAIL", "email-1", kind);

    expect(decisionLabel.updateMany).toHaveBeenCalledTimes(1);
    const args = decisionLabel.updateMany.mock.calls[0][0];
    expect(args.where).toEqual({
      userId: "user-1",
      source: "EMAIL",
      sourceId: "email-1",
      [column]: null,
    });
    expect(Object.keys(args.data)).toEqual([column]);
    expect(args.data[column]).toBeInstanceOf(Date);
  });

  it("lists exactly the engagement vocabulary the ledger has columns for", () => {
    expect([...ENGAGEMENT_OUTCOMES].sort()).toEqual(
      ["ARCHIVED", "DISMISSED", "OPENED", "REPLIED", "SNOOZED", "STARRED", "UNSUBSCRIBED"].sort(),
    );
  });
});

describe("stampDecisionOutcomes (bulk)", () => {
  it("stamps every listed row of the acting user in one query", async () => {
    await stampDecisionOutcomes("user-1", "EMAIL", ["e1", "e2"], "ARCHIVED");

    expect(decisionLabel.updateMany).toHaveBeenCalledTimes(1);
    const args = decisionLabel.updateMany.mock.calls[0][0];
    expect(args.where).toEqual({
      userId: "user-1",
      source: "EMAIL",
      sourceId: { in: ["e1", "e2"] },
      archivedAt: null,
    });
    expect(args.data.archivedAt).toBeInstanceOf(Date);
  });

  it("skips the query for an empty list", async () => {
    await stampDecisionOutcomes("user-1", "EMAIL", [], "ARCHIVED");
    expect(decisionLabel.updateMany).not.toHaveBeenCalled();
  });

  it("never throws, logs on failure", async () => {
    decisionLabel.updateMany.mockRejectedValue(new Error("db down"));
    await expect(
      stampDecisionOutcomes("user-1", "EMAIL", ["e1"], "OPENED"),
    ).resolves.toBeUndefined();
    expect(captureError).toHaveBeenCalled();
  });
});

describe("stampProviderEngagement (what the user did in Gmail itself)", () => {
  const AT = new Date("2026-11-10T08:00:00Z");

  it("writes its own provider column, first wins, scoped to the user, never before the judgement", async () => {
    decisionLabel.updateMany.mockResolvedValue({ count: 2 });

    const count = await stampProviderEngagement("user-1", "REPLIED", ["e1", "e2"], AT);

    expect(count).toBe(2);
    expect(decisionLabel.updateMany).toHaveBeenCalledTimes(1);
    expect(decisionLabel.updateMany.mock.calls[0][0]).toEqual({
      where: {
        userId: "user-1",
        source: "EMAIL",
        sourceId: { in: ["e1", "e2"] },
        providerRepliedAt: null,
        judgedAt: { lte: AT },
      },
      data: { providerRepliedAt: AT },
    });
  });

  it("archive goes to providerArchivedAt and never touches the Klorn columns or outcome", async () => {
    decisionLabel.updateMany.mockResolvedValue({ count: 1 });

    await stampProviderEngagement("user-1", "ARCHIVED", ["e1"], AT);

    const args = decisionLabel.updateMany.mock.calls[0][0];
    expect(args.data).toEqual({ providerArchivedAt: AT });
    expect(args.where).toMatchObject({ providerArchivedAt: null });
    expect(args.where).not.toHaveProperty("archivedAt");
    expect(args.where).not.toHaveProperty("outcome");
  });

  it("skips the query for an empty list", async () => {
    await expect(stampProviderEngagement("user-1", "REPLIED", [], AT)).resolves.toBe(0);
    expect(decisionLabel.updateMany).not.toHaveBeenCalled();
  });

  it("never throws, logs on failure", async () => {
    decisionLabel.updateMany.mockRejectedValue(new Error("db down"));
    await expect(stampProviderEngagement("user-1", "ARCHIVED", ["e1"], AT)).resolves.toBe(0);
    expect(captureError).toHaveBeenCalled();
  });
});
