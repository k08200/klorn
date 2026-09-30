/**
 * An agent's lane change must never teach the judge (step A2b; cross-cutting
 * rule in docs/providers/unified-platform-plan.md: "Only a human action sets
 * isManualOverride. Nothing an agent does feeds the judge's learning.").
 *
 * Every reader that turns lane changes into learning runs for REAL here —
 * judge-context (correction examples, sender priors, tier history),
 * calibration-snapshot, correction-eval, decision-metrics, the weekly report and
 * the ontology proposals — over an in-memory database (helpers/fake-db.ts) that
 * evaluates the `where` each reader builds. The agent's change is made by the
 * real set_tier executor. Each section also runs a HUMAN control (the same move
 * as a real override) and requires the reader to react to it, so a passing
 * exclusion cannot be a reader that ignores everything.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
const judgeEmailMock = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => {
  const prisma = new Proxy(
    {},
    { get: (_t, name) => (dbHolder.current as FakeDb).model(String(name)) },
  );
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../learning/trust-score.js", () => ({ getTrustScore: vi.fn(async () => null) }));
vi.mock("../learning/interaction-graph.js", () => ({
  getCachedInteractionNode: vi.fn(async () => null),
  getCachedInteractionGraph: vi.fn(async () => null),
  propagatedImportanceForDomain: vi.fn(() => 0),
}));
vi.mock("../mail/triage-priorities.js", () => ({ fetchTriagePriorities: vi.fn(async () => null) }));
vi.mock("../notify/push.js", () => ({ sendPushNotification: vi.fn() }));
vi.mock("../judge/poc-judge.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../judge/poc-judge.js")>()),
  judgeEmail: judgeEmailMock,
}));

import { snapshotUserCalibration } from "../judge/calibration-snapshot.js";
import { getDecisionMetrics } from "../judge/decision-metrics.js";
import { buildJudgeContext } from "../judge/judge-context.js";
import { manualOverrideReason } from "../judge/tiers.js";
import { runCorrectionEval } from "../learning/correction-eval.js";
import { recomputeOntologyProposals } from "../learning/ontology-proposals-store.js";
import { executeSetTier } from "../mcp/set-tier.js";
import { collectWeeklyStats } from "../pim/weekly-report.js";

const USER = "user-1";
const KEY = "key-1";
const NOW = new Date("2026-09-30T10:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

const TEE = "Tee Updates <noreply@tee.example>";
const UNA = "Una <una@corp.example>";

const FEATURES = { confidence: 0.8, senderTrust: 0.5, reversibility: 0.5, urgency: 0.3 };

interface Mail {
  id: string;
  from: string;
  tier: string;
}

/** One email + its attention item + its ledger row, as the judge left them. */
function world(mails: Mail[], opts: { humanOverridden?: readonly string[] } = {}): FakeDb {
  const human = new Set(opts.humanOverridden ?? []);
  const db = createFakeDb({
    emailMessage: mails.map((m) => ({
      id: m.id,
      userId: USER,
      gmailId: `g-${m.id}`,
      from: m.from,
      subject: `Subject ${m.id}`,
      snippet: "snippet",
      labels: ["INBOX"],
      receivedAt: ago(2),
    })),
    attentionItem: mails.map((m) => ({
      id: `item-${m.id}`,
      userId: USER,
      source: "EMAIL",
      sourceId: m.id,
      status: "OPEN",
      tier: human.has(m.id) ? "PUSH" : m.tier,
      tierReason: human.has(m.id) ? manualOverrideReason("PUSH") : "judge text",
      isManualOverride: human.has(m.id),
      agentTierSetAt: null,
      agentTierKeyId: null,
      confidence: 0.8,
      evidence: null,
      createdAt: ago(1),
      updatedAt: ago(1),
    })),
    decisionLabel: mails.map((m) => ({
      userId: USER,
      source: "EMAIL",
      sourceId: m.id,
      shownTier: m.tier,
      outcome: human.has(m.id) ? "OVERRIDE:PUSH" : null,
      outcomeAt: human.has(m.id) ? ago(1) : null,
      judgedAt: ago(1),
      decidedBy: "llm",
      features: FEATURES,
      engagementKind: null,
    })),
    feedbackEvent: [],
    calibrationSnapshot: [],
    agentLog: [],
    emailRule: [],
    ontologyProposal: [],
  });
  dbHolder.current = db;
  return db;
}

/** The agent's move, through the real executor. */
async function agentMoves(ids: readonly string[], tier: string): Promise<void> {
  for (const id of ids) {
    const out = JSON.parse(
      await executeSetTier({ userId: USER, apiKeyId: KEY }, { email_id: `g-${id}`, tier }),
    );
    expect(out.success, `agent move of ${id}`).toBe(true);
  }
}

const tee = (tiers: string[]): Mail[] =>
  tiers.map((tier, i) => ({ id: `t${i + 1}`, from: TEE, tier }));
const una = (tiers: string[]): Mail[] =>
  tiers.map((tier, i) => ({ id: `u${i + 1}`, from: UNA, tier }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  judgeEmailMock.mockReset();
  judgeEmailMock.mockResolvedValue({ tier: "QUEUE", reason: "r", source: "llm" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("judge-context: sender priors, tier history and correction examples", () => {
  const ctxFor = (from: string) => buildJudgeContext(USER, { from, subject: "New one" });

  it("three agent moves to QUEUE do not build the unanimous-history prior that skips the LLM", async () => {
    world(tee(["SILENT", "INFO", "PUSH"]));
    expect((await ctxFor(TEE)).senderPrior).toBeNull();
    await agentMoves(["t1", "t2", "t3"], "QUEUE");
    const ctx = await ctxFor(TEE);
    expect(ctx.senderPrior).toBeNull();
    expect(ctx.senderFacts?.tierHistory?.QUEUE ?? 0).toBe(0);
  });

  it("control: the SAME three QUEUE tiers decided by the judge DO build that prior", async () => {
    world(tee(["QUEUE", "QUEUE", "QUEUE"]));
    expect((await ctxFor(TEE)).senderPrior).toEqual({ tier: "QUEUE", count: 3, kind: "history" });
  });

  it("two agent moves to PUSH do not create the 2-override prior, a correction example or an override count", async () => {
    world(una(["QUEUE", "QUEUE"]));
    await agentMoves(["u1", "u2"], "PUSH");
    const ctx = await ctxFor(UNA);
    expect(ctx.senderPrior).toBeNull();
    expect(ctx.corrections).toEqual([]);
    expect(ctx.senderFacts?.manualOverrides ?? 0).toBe(0);
  });

  it("control: two HUMAN overrides to PUSH do create the prior, two examples and the override count", async () => {
    world(una(["QUEUE", "QUEUE"]), { humanOverridden: ["u1", "u2"] });
    const ctx = await ctxFor(UNA);
    expect(ctx.senderPrior).toEqual({ tier: "PUSH", count: 2, kind: "override" });
    expect(ctx.corrections).toHaveLength(2);
    expect(ctx.senderFacts?.manualOverrides).toBe(2);
  });

  it("a judge-authored reason that impersonates the override prefix is still not a correction", async () => {
    const db = world(una(["QUEUE", "QUEUE"]));
    for (const row of db.tables.attentionItem) {
      Object.assign(row, { tier: "PUSH", tierReason: manualOverrideReason("PUSH") });
    }
    const ctx = await ctxFor(UNA);
    expect(ctx.corrections).toEqual([]);
    expect(ctx.senderFacts?.manualOverrides ?? 0).toBe(0);
  });

  it("an agent move on top of a human-labelled neighbour leaves the human signal intact and adds nothing", async () => {
    world([...una(["QUEUE", "QUEUE", "QUEUE"])], { humanOverridden: ["u1"] });
    await agentMoves(["u2", "u3"], "SILENT");
    const ctx = await ctxFor(UNA);
    expect(ctx.corrections).toHaveLength(1);
    expect(ctx.senderFacts?.manualOverrides).toBe(1);
    expect(ctx.senderPrior).toBeNull();
  });
});

describe("calibration-snapshot", () => {
  interface SnapshotPayloadShape {
    manualOverrides: { count: number };
    perTier: Record<string, { count: number } | null>;
    totalItems: number;
  }
  const snapshotOf = async (db: FakeDb): Promise<SnapshotPayloadShape> => {
    await snapshotUserCalibration(USER, NOW);
    return (db.tables.calibrationSnapshot.at(-1) as { payload: SnapshotPayloadShape }).payload;
  };

  it("does not count an agent move as a manual override and leaves the judge's tier distribution alone", async () => {
    const db = world([...una(["QUEUE", "QUEUE"]), ...tee(["QUEUE", "QUEUE"])]);
    await agentMoves(["u1", "u2"], "PUSH");
    const payload = await snapshotOf(db);
    expect(payload.manualOverrides.count).toBe(0);
    expect(payload.perTier.PUSH).toBeNull();
    expect(payload.perTier.QUEUE?.count).toBe(2);
    expect(payload.totalItems).toBe(2);
  });

  it("control: a human override IS counted and moves the distribution", async () => {
    const db = world([...una(["QUEUE", "QUEUE"]), ...tee(["QUEUE", "QUEUE"])], {
      humanOverridden: ["u1", "u2"],
    });
    const payload = await snapshotOf(db);
    expect(payload.manualOverrides.count).toBe(2);
    expect(payload.perTier.PUSH?.count).toBe(2);
    expect(payload.totalItems).toBe(4);
  });
});

describe("correction-eval", () => {
  beforeEach(() => vi.stubEnv("OPENROUTER_API_KEY", "test-key"));

  it("has nothing to evaluate when the only moves are the agent's, and never calls the judge", async () => {
    world(una(["QUEUE", "QUEUE"]));
    await agentMoves(["u1", "u2"], "PUSH");
    expect(await runCorrectionEval(USER, NOW, { delayMs: 0 })).toBeNull();
    expect(judgeEmailMock).not.toHaveBeenCalled();
  });

  it("control: a human override is evaluated", async () => {
    world(una(["QUEUE", "QUEUE"]), { humanOverridden: ["u1"] });
    const payload = await runCorrectionEval(USER, NOW, { delayMs: 0 });
    expect(payload?.n).toBe(1);
    expect(judgeEmailMock).toHaveBeenCalledTimes(1);
  });
});

describe("decision ledger readers: metrics, weekly report, ontology proposals", () => {
  const mails = [...una(["QUEUE", "PUSH", "SILENT"]), ...tee(["QUEUE", "QUEUE"])];

  async function readers() {
    return {
      metrics: await getDecisionMetrics({ userId: USER }),
      weekly: await collectWeeklyStats(USER, NOW),
      ontology: (await recomputeOntologyProposals()).candidates,
    };
  }

  it("agent moves leave the ledger untouched and every reader's output identical", async () => {
    const baseline = world(mails);
    const before = await readers();
    const ledgerBefore = structuredClone(baseline.tables.decisionLabel);

    const moved = world(mails);
    await agentMoves(["u1", "u2", "u3", "t1"], "PUSH");
    const after = await readers();

    expect(moved.tables.decisionLabel).toEqual(ledgerBefore);
    expect(moved.writes.decisionLabel).toBeUndefined();
    expect(after).toEqual(before);
  });

  it("control: a human override changes metrics and the weekly correction count", async () => {
    world(mails);
    const before = await readers();
    world(mails, { humanOverridden: ["u1", "u3"] });
    const after = await readers();
    expect(after.metrics).not.toEqual(before.metrics);
    expect(before.weekly.corrections).toBe(0);
    expect(after.weekly.corrections).toBe(2);
  });

  it("an agent move followed by a human override still counts the human's correction", async () => {
    // First-stamp-wins: had the agent stamped the ledger, the human's stamp would be lost.
    const db = world(mails);
    await agentMoves(["u1"], "SILENT");
    const row = db.tables.decisionLabel.find((r: Row) => r.sourceId === "u1") as Row;
    expect(row.outcome).toBeNull();
    Object.assign(row, { outcome: "OVERRIDE:PUSH", outcomeAt: NOW });
    expect((await collectWeeklyStats(USER, NOW)).corrections).toBe(1);
  });
});
