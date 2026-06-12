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
const captureErrorMock = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({
  prisma: {
    attentionItem: { findMany: attentionFindMany, groupBy: attentionGroupBy },
    feedbackEvent: { findMany: feedbackFindMany },
    calibrationSnapshot: { upsert: snapshotUpsert },
  },
  db: {},
}));

vi.mock("../sentry.js", () => ({
  captureError: captureErrorMock,
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
  captureErrorMock.mockReset();
  snapshotUpsert.mockResolvedValue({});
  feedbackFindMany.mockResolvedValue([]);
});

describe("buildSnapshotPayload", () => {
  it("counts manual tier overrides from the tierReason prefix", () => {
    const payload = buildSnapshotPayload({
      thisRows: [
        emailRow("a", "QUEUE", { tierReason: "Manual override — user moved to QUEUE" }),
        emailRow("b", "QUEUE", { tierReason: "Visible in queue for manual review" }),
        emailRow("c", "SILENT", { tierReason: "Manual override — user moved to SILENT" }),
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
});
