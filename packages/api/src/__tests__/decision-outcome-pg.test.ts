import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

// Real-Postgres proof of the engagement columns (migration
// 20261024000000_decision_label_engagement) and the lane-quality SQL. A mock
// can't show that each kind's first stamp survives a second one, that an open
// leaves `outcome` null for the override/confirm stamps and fallback-rejudge,
// or that the report's FILTER clauses and READ ONLY transaction actually run.
// Skipped unless KLORN_TEST_PG_URL points at a database with every migration
// applied.
const url = vi.hoisted(() => {
  const value = process.env.KLORN_TEST_PG_URL;
  if (value) process.env.DATABASE_URL = value;
  return value;
});

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { prisma } from "../db.js";
import { stampDecisionOutcome, stampDecisionOutcomes } from "../judge/decision-label.js";
import { queryLaneQuality } from "../judge/lane-quality.js";

const describePg = url ? describe : describe.skip;
const createdUsers: string[] = [];

async function newUser(): Promise<string> {
  const user = await prisma.user.create({ data: { email: `outcome-${randomUUID()}@test.local` } });
  createdUsers.push(user.id);
  return user.id;
}

async function newLabel(
  userId: string,
  over: { shownTier?: string; decidedBy?: string; judgedAt?: Date } = {},
): Promise<string> {
  const sourceId = randomUUID();
  await prisma.decisionLabel.create({
    data: {
      userId,
      source: "EMAIL",
      sourceId,
      shownTier: over.shownTier ?? "QUEUE",
      features: { confidence: 0.9 },
      decidedBy: over.decidedBy ?? "llm",
      ...(over.judgedAt ? { judgedAt: over.judgedAt } : {}),
    },
  });
  return sourceId;
}

const label = (userId: string, sourceId: string) =>
  prisma.decisionLabel.findUniqueOrThrow({
    where: { userId_source_sourceId: { userId, source: "EMAIL", sourceId } },
  });

afterAll(async () => {
  if (!url) return;
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  await prisma.$disconnect();
});

describePg("engagement stamps (real Postgres)", () => {
  it("keeps the first stamp of each kind", async () => {
    const userId = await newUser();
    const sourceId = await newLabel(userId);

    await stampDecisionOutcome(userId, "EMAIL", sourceId, "OPENED");
    const first = (await label(userId, sourceId)).openedAt;
    await new Promise((r) => setTimeout(r, 5));
    await stampDecisionOutcome(userId, "EMAIL", sourceId, "OPENED");

    expect(first).toBeInstanceOf(Date);
    expect((await label(userId, sourceId)).openedAt).toEqual(first);
  });

  it("records an open AND the reply after it, and leaves outcome free for a lane move", async () => {
    const userId = await newUser();
    const sourceId = await newLabel(userId, { decidedBy: "keyword-fallback" });

    await stampDecisionOutcome(userId, "EMAIL", sourceId, "OPENED");
    await stampDecisionOutcome(userId, "EMAIL", sourceId, "REPLIED");

    const afterEngagement = await label(userId, sourceId);
    expect(afterEngagement.openedAt).toBeInstanceOf(Date);
    expect(afterEngagement.repliedAt).toBeInstanceOf(Date);
    expect(afterEngagement.outcome).toBeNull();

    // fallback-rejudge's selection (outcome:null) still finds the opened row.
    const rejudgeEligible = await prisma.decisionLabel.count({
      where: { userId, source: "EMAIL", decidedBy: "keyword-fallback", outcome: null },
    });
    expect(rejudgeEligible).toBe(1);

    // The override/confirm stamp (outcome:null-guarded) still lands after an open.
    await stampDecisionOutcome(userId, "EMAIL", sourceId, "OVERRIDE:PUSH");
    expect((await label(userId, sourceId)).outcome).toBe("OVERRIDE:PUSH");
  });

  it("never touches another user's row with the same sourceId", async () => {
    const owner = await newUser();
    const other = await newUser();
    const sourceId = await newLabel(owner);
    await prisma.decisionLabel.create({
      data: { userId: other, source: "EMAIL", sourceId, shownTier: "PUSH", features: {} },
    });

    await stampDecisionOutcomes(owner, "EMAIL", [sourceId], "ARCHIVED");

    expect((await label(owner, sourceId)).archivedAt).toBeInstanceOf(Date);
    expect((await label(other, sourceId)).archivedAt).toBeNull();
  });
});

describePg("queryLaneQuality (real Postgres)", () => {
  it("counts per lane and decidedBy, replied<24h over matured rows, and override flows", async () => {
    const userId = await newUser();
    const until = new Date();
    const since = new Date(until.getTime() - 7 * 86_400_000);
    const twoDaysAgo = new Date(until.getTime() - 2 * 86_400_000);

    // PUSH: two matured rows — one opened + replied within an hour, one untouched.
    const replied = await newLabel(userId, { shownTier: "PUSH", judgedAt: twoDaysAgo });
    await newLabel(userId, { shownTier: "PUSH", judgedAt: twoDaysAgo });
    await prisma.decisionLabel.update({
      where: { userId_source_sourceId: { userId, source: "EMAIL", sourceId: replied } },
      data: {
        openedAt: new Date(twoDaysAgo.getTime() + 60_000),
        repliedAt: new Date(twoDaysAgo.getTime() + 3_600_000),
      },
    });
    // PUSH: a reply that came after 24h does not count as replied<24h.
    const late = await newLabel(userId, { shownTier: "PUSH", judgedAt: twoDaysAgo });
    await prisma.decisionLabel.update({
      where: { userId_source_sourceId: { userId, source: "EMAIL", sourceId: late } },
      data: { repliedAt: new Date(twoDaysAgo.getTime() + 30 * 3_600_000) },
    });
    // SILENT via sender-prior: fresh (not matured), opened, then moved to QUEUE.
    const rescued = await newLabel(userId, {
      shownTier: "SILENT",
      decidedBy: "sender-prior",
      judgedAt: new Date(until.getTime() - 3_600_000),
    });
    await stampDecisionOutcome(userId, "EMAIL", rescued, "OPENED");
    await stampDecisionOutcome(userId, "EMAIL", rescued, "OVERRIDE:QUEUE");
    // Legacy AUTO folds into QUEUE; dismissed.
    const auto = await newLabel(userId, { shownTier: "AUTO", judgedAt: twoDaysAgo });
    await stampDecisionOutcome(userId, "EMAIL", auto, "DISMISSED");
    // Outside the window: ignored.
    await newLabel(userId, { shownTier: "PUSH", judgedAt: new Date(since.getTime() - 1000) });

    const report = await queryLaneQuality({ since, until, userId });
    const lane = (name: string) => report.lanes.find((l) => l.lane === name);

    expect(lane("PUSH")).toMatchObject({
      judged: 3,
      matured: 3,
      anyOutcome: 2,
      opened: 1,
      replied24h: 1,
    });
    expect(lane("SILENT")).toMatchObject({ judged: 1, matured: 0, opened: 1, overridden: 1 });
    expect(lane("SILENT")?.shares.replied24h).toBeNull();
    expect(lane("QUEUE")).toMatchObject({ judged: 1, dismissed: 1, anyOutcome: 1 });
    expect(report.byDecidedBy.find((c) => c.decidedBy === "sender-prior")).toMatchObject({
      lane: "SILENT",
      judged: 1,
    });
    expect(report.overrideFlows).toEqual([{ from: "SILENT", to: "QUEUE", count: 1 }]);
  });

  it("runs read-only: the transaction it uses refuses a write", async () => {
    await expect(
      prisma.$transaction([
        prisma.$executeRaw`SET TRANSACTION READ ONLY`,
        prisma.$executeRaw`UPDATE "DecisionLabel" SET "outcome" = NULL WHERE false`,
      ]),
    ).rejects.toThrow(/read-only transaction/);
  });
});
