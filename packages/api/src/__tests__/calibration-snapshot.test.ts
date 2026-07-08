/**
 * calibration-snapshot — daily classification-quality KPI persistence.
 *
 * The payload math is pure (buildSnapshotPayload); DB wiring is mocked at
 * the db.js boundary (repo convention). The daily runner must isolate
 * per-user failures: one broken user cannot stop the rest.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const attentionFindMany = vi.hoisted(() => vi.fn());
const attentionGroupBy = vi.hoisted(() => vi.fn());
const feedbackFindMany = vi.hoisted(() => vi.fn());
const snapshotUpsert = vi.hoisted(() => vi.fn());
const snapshotFindUnique = vi.hoisted(() => vi.fn());
const snapshotUpdate = vi.hoisted(() => vi.fn());
const captureErrorMock = vi.hoisted(() => vi.fn());
const runCorrectionEvalMock = vi.hoisted(() => vi.fn());
const decisionLabelFindMany = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({
  prisma: {
    attentionItem: { findMany: attentionFindMany, groupBy: attentionGroupBy },
    feedbackEvent: { findMany: feedbackFindMany },
    calibrationSnapshot: {
      upsert: snapshotUpsert,
      findUnique: snapshotFindUnique,
      update: snapshotUpdate,
    },
    decisionLabel: { findMany: decisionLabelFindMany },
  },
  db: {},
}));

vi.mock("../sentry.js", () => ({
  captureError: captureErrorMock,
}));

vi.mock("../correction-eval.js", () => ({
  runCorrectionEval: runCorrectionEvalMock,
}));

import {
  buildSnapshotPayload,
  runDailyCalibrationSnapshots,
  snapshotUserCalibration,
} from "../calibration-snapshot.js";

const NOW = new Date("2026-06-13T01:00:00.000Z");
const DAYS = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

function emailRow(
  id: string,
  tier: string | null,
  opts: {
    tierReason?: string | null;
    isManualOverride?: boolean;
    judgedBy?: string | null;
    source?: string;
    confidence?: number;
    createdAt?: Date;
  } = {},
) {
  return {
    id,
    source: opts.source ?? "EMAIL",
    sourceId: `src-${id}`,
    tier,
    confidence: opts.confidence ?? 0.8,
    createdAt: opts.createdAt ?? DAYS(1),
    tierReason: opts.tierReason ?? null,
    isManualOverride: opts.isManualOverride ?? false,
    evidence:
      opts.judgedBy === undefined
        ? null
        : {
            source: "EMAIL",
            sourceId: `src-${id}`,
            facts: [
              { label: "From", value: "x@y.com" },
              ...(opts.judgedBy === null ? [] : [{ label: "Judged by", value: opts.judgedBy }]),
            ],
          },
  };
}

beforeEach(() => {
  attentionFindMany.mockReset();
  attentionGroupBy.mockReset();
  feedbackFindMany.mockReset();
  snapshotUpsert.mockReset();
  snapshotFindUnique.mockReset();
  snapshotUpdate.mockReset();
  captureErrorMock.mockReset();
  runCorrectionEvalMock.mockReset();
  decisionLabelFindMany.mockReset();
  snapshotUpsert.mockResolvedValue({});
  snapshotFindUnique.mockResolvedValue(null);
  snapshotUpdate.mockResolvedValue({});
  decisionLabelFindMany.mockResolvedValue([]);
  runCorrectionEvalMock.mockResolvedValue(null);
  feedbackFindMany.mockResolvedValue([]);
});

describe("buildSnapshotPayload", () => {
  it("counts manual tier overrides from the isManualOverride flag", () => {
    const payload = buildSnapshotPayload({
      thisRows: [
        emailRow("a", "QUEUE", {
          tierReason: "Manual override — user moved to QUEUE",
          isManualOverride: true,
        }),
        emailRow("b", "QUEUE", { tierReason: "Visible in queue for manual review" }),
        emailRow("c", "SILENT", {
          tierReason: "Manual override — user moved to SILENT",
          isManualOverride: true,
        }),
        emailRow("d", null),
      ],
      previousRows: [],
      feedbackOverrideIds: new Set(),
      windowDays: 7,
      now: NOW,
    });
    expect(payload.manualOverrides).toEqual({ count: 2, total: 3, rate: 0.6667 });
    expect(payload.totalItems).toBe(4);
  });

  it("does not count judge-authored text impersonating the override prefix (GHSA-cxc5-fmqv-pxv6)", () => {
    const payload = buildSnapshotPayload({
      thisRows: [
        emailRow("a", "QUEUE", {
          tierReason: "Manual override — user moved to QUEUE",
          isManualOverride: false,
        }),
        emailRow("b", "QUEUE", { tierReason: "Visible in queue for manual review" }),
      ],
      previousRows: [],
      feedbackOverrideIds: new Set(),
      windowDays: 7,
      now: NOW,
    });
    expect(payload.manualOverrides).toEqual({ count: 0, total: 2, rate: 0 });
  });

  it("computes the overall feedback-override rate from the per-tier stats", () => {
    const payload = buildSnapshotPayload({
      thisRows: [emailRow("a", "QUEUE"), emailRow("b", "QUEUE"), emailRow("c", "PUSH")],
      previousRows: [],
      feedbackOverrideIds: new Set(["a", "c"]),
      windowDays: 7,
      now: NOW,
    });
    expect(payload.feedbackOverrides).toEqual({ count: 2, total: 3, rate: 0.6667 });
    expect(payload.feedbackOverrideRate.QUEUE.overridden).toBe(1);
    expect(payload.feedbackOverrideRate.PUSH.overridden).toBe(1);
  });

  it("counts judge sources from the 'Judged by' evidence fact, EMAIL rows only", () => {
    const payload = buildSnapshotPayload({
      thisRows: [
        emailRow("a", "QUEUE", { judgedBy: "llm" }),
        emailRow("b", "QUEUE", { judgedBy: "llm" }),
        emailRow("c", "QUEUE", { judgedBy: "keyword-fallback" }),
        emailRow("d", "SILENT", { judgedBy: "fast-path" }),
        emailRow("e", "QUEUE", { judgedBy: "sender-prior" }),
        emailRow("f", "QUEUE", { judgedBy: null }), // evidence without the fact
        emailRow("g", "QUEUE"), // no evidence at all
        emailRow("h", "QUEUE", { judgedBy: "llm", source: "TASK" }), // non-EMAIL — excluded
      ],
      previousRows: [],
      feedbackOverrideIds: new Set(),
      windowDays: 7,
      now: NOW,
    });
    expect(payload.judgeSourceCounts).toEqual({
      "fast-path": 1,
      "sender-prior": 1,
      llm: 2,
      "keyword-fallback": 1,
      unknown: 2,
    });
  });

  it("feeds this-window and previous-window rows into the drift signal", () => {
    const payload = buildSnapshotPayload({
      thisRows: [emailRow("a", "QUEUE"), emailRow("b", "QUEUE")],
      previousRows: [emailRow("p1", "SILENT"), emailRow("p2", "SILENT")],
      feedbackOverrideIds: new Set(),
      windowDays: 7,
      now: NOW,
    });
    expect(payload.driftSignal.thisWindow.QUEUE).toBe(1);
    expect(payload.driftSignal.previousWindow.SILENT).toBe(1);
    expect(payload.driftSignal.deltaMax).toBe(1);
  });
});

describe("snapshotUserCalibration", () => {
  it("upserts one row keyed by (userId, UTC dayKey)", async () => {
    attentionFindMany.mockResolvedValue([]);
    await snapshotUserCalibration("u1", NOW);
    expect(snapshotUpsert).toHaveBeenCalledTimes(1);
    const args = snapshotUpsert.mock.calls[0][0];
    expect(args.where).toEqual({ userId_dayKey: { userId: "u1", dayKey: "2026-06-13" } });
    expect(args.create.userId).toBe("u1");
    expect(args.create.dayKey).toBe("2026-06-13");
    expect(args.create.payload.windowDays).toBe(7);
  });

  it("splits this-window and previous-window queries at the 7-day boundary", async () => {
    attentionFindMany.mockResolvedValue([]);
    await snapshotUserCalibration("u1", NOW);
    const gtes = attentionFindMany.mock.calls.map((c) => c[0].where.createdAt.gte.getTime()).sort();
    expect(gtes).toEqual([DAYS(14).getTime(), DAYS(7).getTime()].sort());
  });

  it("attaches the ledger drift series from the immutable shownTier", async () => {
    attentionFindMany.mockResolvedValue([]);
    decisionLabelFindMany.mockResolvedValue([
      { shownTier: "PUSH", outcome: null, decidedBy: "llm" },
      { shownTier: "QUEUE", outcome: "OVERRIDE:PUSH", decidedBy: "llm" },
      { shownTier: "SILENT", outcome: "OVERRIDE:QUEUE", decidedBy: "sender-prior" },
    ]);
    await snapshotUserCalibration("u1", NOW);
    const dm = snapshotUpsert.mock.calls[0][0].create.payload.decisionMetrics;
    expect(dm).toEqual({
      total: 3,
      acted: 2,
      recallUpperBound: 0.5, // 1 kept / (1 kept + 1 escalated)
      overSuppressionRate: 1, // 1 SILENT rescued / 1 SILENT shown
      overrideRate: 2 / 3,
      pushShown: 1,
      silentShown: 1,
    });
  });

  it("isolates a ledger read failure — KPI snapshot still upserts, signal logged", async () => {
    attentionFindMany.mockResolvedValue([]);
    decisionLabelFindMany.mockRejectedValue(new Error("ledger read failed"));
    await snapshotUserCalibration("u1", NOW);
    expect(snapshotUpsert).toHaveBeenCalledTimes(1);
    expect(snapshotUpsert.mock.calls[0][0].create.payload.decisionMetrics).toBeUndefined();
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
  });
});

describe("runDailyCalibrationSnapshots", () => {
  it("snapshots every user with recent attention items, isolating failures", async () => {
    attentionGroupBy.mockResolvedValue([{ userId: "u1" }, { userId: "u2" }]);
    attentionFindMany.mockResolvedValue([]);
    snapshotUpsert.mockRejectedValueOnce(new Error("u1 write failed")).mockResolvedValueOnce({});

    await runDailyCalibrationSnapshots(NOW);

    // u1 failed but u2 was still processed.
    expect(snapshotUpsert).toHaveBeenCalledTimes(2);
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing when no user has recent items", async () => {
    attentionGroupBy.mockResolvedValue([]);
    await runDailyCalibrationSnapshots(NOW);
    expect(snapshotUpsert).not.toHaveBeenCalled();
  });

  it("paginates the user groupBy — processes every page and advances skip", async () => {
    attentionFindMany.mockResolvedValue([]);
    // Page 1: a full batch (500) → the loop must fetch a second page.
    const page1 = Array.from({ length: 500 }, (_, i) => ({ userId: `u${i}` }));
    // Page 2: a partial page (< batch) → the loop stops after this.
    const page2 = [{ userId: "u500" }, { userId: "u501" }];
    attentionGroupBy.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);

    await runDailyCalibrationSnapshots(NOW);

    // Two pages fetched, then the loop stops (partial page).
    expect(attentionGroupBy).toHaveBeenCalledTimes(2);
    // skip advanced by the batch size between the two page fetches.
    expect(attentionGroupBy.mock.calls[0][0]).toMatchObject({
      by: ["userId"],
      orderBy: { userId: "asc" },
      take: 500,
      skip: 0,
    });
    expect(attentionGroupBy.mock.calls[1][0]).toMatchObject({ take: 500, skip: 500 });
    // Every user across both pages was snapshotted (500 + 2 = 502).
    expect(snapshotUpsert).toHaveBeenCalledTimes(502);
  });

  it("stops after a single partial page without a second fetch", async () => {
    attentionFindMany.mockResolvedValue([]);
    attentionGroupBy.mockResolvedValueOnce([{ userId: "u1" }, { userId: "u2" }]);

    await runDailyCalibrationSnapshots(NOW);

    expect(attentionGroupBy).toHaveBeenCalledTimes(1);
    expect(snapshotUpsert).toHaveBeenCalledTimes(2);
  });

  it("isolates a per-user failure within a page and still processes the rest", async () => {
    attentionFindMany.mockResolvedValue([]);
    attentionGroupBy.mockResolvedValueOnce([{ userId: "u1" }, { userId: "u2" }]);
    snapshotUpsert.mockRejectedValueOnce(new Error("u1 write failed")).mockResolvedValueOnce({});

    await runDailyCalibrationSnapshots(NOW);

    expect(snapshotUpsert).toHaveBeenCalledTimes(2);
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
  });
});

describe("weekly correction eval merge", () => {
  // NOW (2026-06-13) is a Saturday; SUNDAY is the weekly trigger day.
  const SUNDAY = new Date("2026-06-14T01:00:00.000Z");

  it("daily upsert preserves an existing correctionEval section", async () => {
    attentionFindMany.mockResolvedValue([]);
    snapshotFindUnique.mockResolvedValue({
      payload: { windowDays: 7, correctionEval: { n: 12, agreement: 0.75 } },
    });

    await snapshotUserCalibration("u1", NOW);

    const args = snapshotUpsert.mock.calls[0][0];
    expect(args.create.payload.correctionEval).toEqual({ n: 12, agreement: 0.75 });
    expect(args.update.payload.correctionEval).toEqual({ n: 12, agreement: 0.75 });
  });

  it("on Sunday, runs the correction eval and merges it into the day's snapshot", async () => {
    attentionGroupBy.mockResolvedValue([{ userId: "u1" }]);
    attentionFindMany.mockResolvedValue([]);
    snapshotFindUnique.mockResolvedValue({ payload: { windowDays: 7 } });
    runCorrectionEvalMock.mockResolvedValue({ n: 9, agreement: 0.78 });

    await runDailyCalibrationSnapshots(SUNDAY);

    expect(runCorrectionEvalMock).toHaveBeenCalledWith("u1", SUNDAY);
    expect(snapshotUpdate).toHaveBeenCalledTimes(1);
    const updateArgs = snapshotUpdate.mock.calls[0][0];
    expect(updateArgs.where).toEqual({
      userId_dayKey: { userId: "u1", dayKey: "2026-06-14" },
    });
    expect(updateArgs.data.payload.correctionEval).toEqual({ n: 9, agreement: 0.78 });
  });

  it("does not run the correction eval on non-Sundays", async () => {
    attentionGroupBy.mockResolvedValue([{ userId: "u1" }]);
    attentionFindMany.mockResolvedValue([]);

    await runDailyCalibrationSnapshots(NOW); // Saturday

    expect(runCorrectionEvalMock).not.toHaveBeenCalled();
  });

  it("is idempotent: skips the eval when today's snapshot already has one", async () => {
    attentionGroupBy.mockResolvedValue([{ userId: "u1" }]);
    attentionFindMany.mockResolvedValue([]);
    snapshotFindUnique.mockResolvedValue({
      payload: { windowDays: 7, correctionEval: { n: 5, agreement: 0.6 } },
    });

    await runDailyCalibrationSnapshots(SUNDAY);

    expect(runCorrectionEvalMock).not.toHaveBeenCalled();
    expect(snapshotUpdate).not.toHaveBeenCalled();
  });

  it("leaves the snapshot untouched when the eval returns null (no key / no corrections)", async () => {
    attentionGroupBy.mockResolvedValue([{ userId: "u1" }]);
    attentionFindMany.mockResolvedValue([]);
    snapshotFindUnique.mockResolvedValue({ payload: { windowDays: 7 } });
    runCorrectionEvalMock.mockResolvedValue(null);

    await runDailyCalibrationSnapshots(SUNDAY);

    expect(snapshotUpdate).not.toHaveBeenCalled();
  });
});
