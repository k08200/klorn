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
  recordDecision,
  recordEmailDecision,
  stampDecisionOutcome,
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
});
