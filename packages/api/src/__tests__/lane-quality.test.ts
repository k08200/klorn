/**
 * Lane-quality report builder: folds storage tiers into the five live lanes,
 * computes shares with honest denominators (null, never a fake 0%), and
 * keeps override flows lane-to-lane; and queryLaneQuality runs only inside a
 * READ ONLY transaction. Prisma is mocked here — decision-outcome-pg.test.ts
 * runs the SQL against a real Postgres.
 */

import { describe, expect, it, vi } from "vitest";

type Sql = { sql: string; values: unknown[] };
const tx = vi.hoisted(() => ({ ops: [] as Sql[] }));

vi.mock("../db.js", () => {
  const tag = (strings: TemplateStringsArray, ...values: unknown[]): Sql => ({
    sql: strings.join("?"),
    values,
  });
  const prisma = {
    $executeRaw: tag,
    $queryRaw: (query: { strings: readonly string[]; values: unknown[] }): Sql => ({
      sql: query.strings.join("?"),
      values: query.values,
    }),
    $transaction: async (ops: Sql[]) => {
      tx.ops = ops;
      return ops.map((op) => (op.sql.startsWith("SET") ? 0 : []));
    },
  };
  return { prisma, db: prisma };
});

import {
  buildLaneQualityReport,
  type LaneCountRow,
  queryLaneQuality,
  REPORT_LANES,
  renderLaneQualityReport,
} from "../judge/lane-quality.js";

const META = {
  since: new Date("2026-10-25T00:00:00Z"),
  until: new Date("2026-11-01T00:00:00Z"),
  source: "EMAIL" as const,
};

function row(over: Partial<LaneCountRow>): LaneCountRow {
  return {
    shownTier: "QUEUE",
    decidedBy: "llm",
    judged: 0,
    matured: 0,
    anyOutcome: 0,
    opened: 0,
    replied24h: 0,
    archived: 0,
    dismissed: 0,
    snoozed: 0,
    starred: 0,
    unsubscribed: 0,
    overridden: 0,
    confirmed: 0,
    ...over,
  };
}

describe("buildLaneQualityReport", () => {
  it("always lists the five lanes in fixed order, with null shares for an empty lane", () => {
    const report = buildLaneQualityReport([], [], META);

    expect(report.lanes.map((l) => l.lane)).toEqual([...REPORT_LANES]);
    expect(report.lanes.map((l) => l.lane)).toEqual(["PUSH", "MEETING", "QUEUE", "INFO", "SILENT"]);
    for (const lane of report.lanes) {
      expect(lane.judged).toBe(0);
      expect(lane.shares.opened).toBeNull();
      expect(lane.shares.replied24h).toBeNull();
    }
  });

  it("computes each share over judged, and replied-within-24h over matured rows only", () => {
    const report = buildLaneQualityReport(
      [
        row({
          shownTier: "PUSH",
          judged: 10,
          matured: 4,
          anyOutcome: 8,
          opened: 7,
          replied24h: 2,
          dismissed: 1,
        }),
      ],
      [],
      META,
    );
    const push = report.lanes[0];

    expect(push.lane).toBe("PUSH");
    expect(push.shares.anyOutcome).toBeCloseTo(0.8);
    expect(push.shares.opened).toBeCloseTo(0.7);
    expect(push.shares.replied24h).toBeCloseTo(0.5); // 2 of 4 matured, not 2 of 10
    expect(push.shares.dismissed).toBeCloseTo(0.1);
  });

  it("folds legacy AUTO into QUEUE and CALL into PUSH, summing their counts", () => {
    const report = buildLaneQualityReport(
      [
        row({ shownTier: "QUEUE", judged: 3, opened: 1 }),
        row({ shownTier: "AUTO", judged: 2, opened: 2 }),
        row({ shownTier: "CALL", judged: 1, opened: 1 }),
      ],
      [],
      META,
    );
    const lane = (name: string) => report.lanes.find((l) => l.lane === name);

    expect(lane("QUEUE")).toMatchObject({ judged: 5, opened: 3 });
    expect(lane("PUSH")).toMatchObject({ judged: 1, opened: 1 });
    expect(report.lanes.some((l) => (l.lane as string) === "AUTO")).toBe(false);
  });

  it("breaks each lane down by decidedBy, loudest lane first then biggest cell", () => {
    const report = buildLaneQualityReport(
      [
        row({ shownTier: "SILENT", decidedBy: "sender-prior", judged: 5 }),
        row({ shownTier: "SILENT", decidedBy: "llm", judged: 9, opened: 3 }),
        row({ shownTier: "PUSH", decidedBy: "keyword-fallback", judged: 1 }),
      ],
      [],
      META,
    );

    expect(report.byDecidedBy.map((c) => `${c.lane}/${c.decidedBy}`)).toEqual([
      "PUSH/keyword-fallback",
      "SILENT/llm",
      "SILENT/sender-prior",
    ]);
    expect(report.byDecidedBy[1].shares.opened).toBeCloseTo(3 / 9);
  });

  it("folds override flows into live lanes and sorts by count", () => {
    const report = buildLaneQualityReport(
      [],
      [
        { fromTier: "QUEUE", toTier: "SILENT", count: 1 },
        { fromTier: "AUTO", toTier: "SILENT", count: 2 },
        { fromTier: "SILENT", toTier: "PUSH", count: 1 },
      ],
      META,
    );

    expect(report.overrideFlows).toEqual([
      { from: "QUEUE", to: "SILENT", count: 3 },
      { from: "SILENT", to: "PUSH", count: 1 },
    ]);
  });

  it("carries the window and source", () => {
    const report = buildLaneQualityReport([], [], META);
    expect(report.window).toEqual({
      since: "2026-10-25T00:00:00.000Z",
      until: "2026-11-01T00:00:00.000Z",
    });
    expect(report.source).toBe("EMAIL");
  });
});

describe("renderLaneQualityReport", () => {
  it("prints every lane, a dash for an undefined share, and the override flows", () => {
    const text = renderLaneQualityReport(
      buildLaneQualityReport(
        [row({ shownTier: "PUSH", judged: 4, matured: 4, opened: 2, replied24h: 1 })],
        [{ fromTier: "QUEUE", toTier: "SILENT", count: 1 }],
        META,
      ),
    );

    for (const lane of REPORT_LANES) expect(text).toContain(lane);
    expect(text).toContain("50.0%");
    expect(text).toContain("25.0% (n=4)");
    expect(text).toContain("—");
    expect(text).toContain("QUEUE → SILENT: 1");
  });
});

describe("queryLaneQuality", () => {
  it("opens its transaction READ ONLY, with a statement timeout, before either query", async () => {
    const report = await queryLaneQuality({
      since: new Date("2026-10-25T00:00:00Z"),
      until: new Date("2026-11-01T00:00:00Z"),
      userId: "user-1",
    });

    expect(tx.ops).toHaveLength(4);
    expect(tx.ops[0].sql).toBe("SET TRANSACTION READ ONLY");
    expect(tx.ops[1].sql).toMatch(/^SET LOCAL statement_timeout/);
    expect(tx.ops.slice(2).every((op) => op.sql.includes('FROM "DecisionLabel"'))).toBe(true);
    expect(report.lanes.map((l) => l.judged)).toEqual([0, 0, 0, 0, 0]);
  });

  it("binds every value as a parameter (user, window, source)", async () => {
    const since = new Date("2026-10-25T00:00:00Z");
    const until = new Date("2026-11-01T00:00:00Z");
    await queryLaneQuality({ since, until, userId: "user-1", source: "GITHUB" });

    const counts = tx.ops[2];
    expect(counts.values).toEqual(expect.arrayContaining([since, until, "user-1", "GITHUB"]));
    expect(counts.sql).not.toContain("user-1");
    expect(counts.sql).not.toContain("GITHUB");
  });

  it("never counts a row as matured past now, even for a future --until", async () => {
    const until = new Date(Date.now() + 7 * 86_400_000);
    const before = Date.now();
    await queryLaneQuality({ since: new Date(before - 86_400_000), until });

    const cutoffs = tx.ops[2].values.filter(
      (v): v is Date => v instanceof Date && v !== until && v.getTime() < before,
    );
    expect(cutoffs.length).toBeGreaterThan(0);
    for (const cutoff of cutoffs) {
      expect(cutoff.getTime()).toBeLessThanOrEqual(Date.now() - 24 * 3_600_000);
    }
  });
});
