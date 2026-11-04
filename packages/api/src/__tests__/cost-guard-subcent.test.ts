/**
 * Sub-cent cost accounting.
 *
 * The old pipeline rounded EVERY paid call up to a 1¢ minimum (usdToCents),
 * so a ~0.05¢ flash classification pre-billed 1¢ — a ~20x overcharge that
 * tripped the $10 global ceiling at ~1,000 classifications/day. The fix:
 * fractional-cent (0.01¢ precision) accumulation. The per-user DB ledger
 * keeps its integer-cents column (no schema change) via an in-memory
 * fractional carry that flushes whole cents; the in-memory global ledger
 * accumulates floats directly. Cap constants keep their meaning ($1, $10).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// Per-user simulated ledger rows: userId -> total cents (integer, like the DB).
const rows = vi.hoisted(() => new Map<string, number>());
// Every upsert's effective increment, in call order.
const increments = vi.hoisted(() => [] as number[]);

/** Stands in for GlobalCostLedger: dayKey -> integer micro-cents. */
const globalTable = new Map<string, number>();

vi.mock("../db.js", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    notification: {
      create: vi.fn(async () => ({ id: "n-1", createdAt: new Date() })),
    },
    globalCostLedger: {
      findUnique: vi.fn(async (args: { where: { dayKey: string } }) => {
        const microCents = globalTable.get(args.where.dayKey);
        return microCents === undefined ? null : { microCents };
      }),
      upsert: vi.fn(
        async (args: {
          where: { dayKey: string };
          create: { microCents: number };
          update: { microCents: { increment: number } };
        }) => {
          const key = args.where.dayKey;
          const next = globalTable.has(key)
            ? (globalTable.get(key) ?? 0) + args.update.microCents.increment
            : args.create.microCents;
          globalTable.set(key, next);
          return { microCents: next };
        },
      ),
    },
    llmCostLedger: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async (args: unknown) => {
        const a = args as {
          where: { userId_dayKey: { userId: string } };
          create: { cents: number };
          update: { cents: { increment: number } };
        };
        const userId = a.where.userId_dayKey.userId;
        const existing = rows.get(userId);
        const inc = existing === undefined ? a.create.cents : a.update.cents.increment;
        const total = (existing ?? 0) + inc;
        rows.set(userId, total);
        increments.push(inc);
        return { cents: total };
      }),
    },
  },
}));

const notifySpy = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../billing/cost-trip-alert.js", () => ({
  notifyCostCapTrip: notifySpy,
  getCostTripSnapshot: vi.fn(() => ({
    dayKey: "2026-07-23",
    globalTrippedToday: false,
    userTrippedToday: [],
  })),
}));

const ORIGINAL_CAP = process.env.DAILY_COST_CAP_CENTS;
const ORIGINAL_GLOBAL_CAP = process.env.GLOBAL_DAILY_COST_CAP_CENTS;

afterEach(() => {
  rows.clear();
  increments.length = 0;
  notifySpy.mockClear();
  if (ORIGINAL_CAP === undefined) delete process.env.DAILY_COST_CAP_CENTS;
  else process.env.DAILY_COST_CAP_CENTS = ORIGINAL_CAP;
  if (ORIGINAL_GLOBAL_CAP === undefined) delete process.env.GLOBAL_DAILY_COST_CAP_CENTS;
  else process.env.GLOBAL_DAILY_COST_CAP_CENTS = ORIGINAL_GLOBAL_CAP;
});

describe("usdToFractionalCents", () => {
  it("returns 0 for zero/negative/non-finite", async () => {
    const { usdToFractionalCents } = await import("../billing/cents.js");
    expect(usdToFractionalCents(0)).toBe(0);
    expect(usdToFractionalCents(-1)).toBe(0);
    expect(usdToFractionalCents(Number.NaN)).toBe(0);
  });

  it("keeps sub-cent costs sub-cent instead of flooring at 1¢", async () => {
    const { usdToFractionalCents } = await import("../billing/cents.js");
    expect(usdToFractionalCents(0.0006)).toBeCloseTo(0.06, 6); // $0.0006 → 0.06¢
    expect(usdToFractionalCents(0.0006)).toBeLessThan(1);
  });

  it("rounds UP at 0.01¢ granularity (conservative, never undercharges)", async () => {
    const { usdToFractionalCents } = await import("../billing/cents.js");
    expect(usdToFractionalCents(0.000151)).toBeCloseTo(0.02, 6); // 0.0151¢ → 0.02¢
    expect(usdToFractionalCents(1.5)).toBeCloseTo(150, 6);
  });

  it("leaves usdToCents (1¢-floor legacy helper) untouched", async () => {
    const { usdToCents } = await import("../billing/cents.js");
    expect(usdToCents(0.0001)).toBe(1);
  });
});

describe("estimatePrebillCents — fractional pre-bill", () => {
  it("pre-bills a flash classification well under 1¢ (was: 1¢ floor)", async () => {
    vi.resetModules();
    const { estimatePrebillCents } = await import("../billing/llm-usage.js");
    const cents = estimatePrebillCents("google/gemini-2.5-flash");
    expect(cents).toBeGreaterThan(0);
    expect(cents).toBeLessThan(1);
  });

  it("still pre-bills >= 1¢ for sonnet-class models", async () => {
    vi.resetModules();
    const { estimatePrebillCents } = await import("../billing/llm-usage.js");
    // Sonnet 4.6 bills $3/$15 → 2000/500 nominal tokens = 1.35¢. (Sonnet 5 is
    // $2/$10 on the native Claude API, so it pre-bills 0.9¢ and is not the
    // ">= 1¢" witness any more.)
    expect(estimatePrebillCents("claude-sonnet-4-6")).toBeGreaterThanOrEqual(1);
  });

  it("pre-bills the hosted default (claude-haiku-5-5) at its sub-cent true size", async () => {
    vi.resetModules();
    const { estimatePrebillCents } = await import("../billing/llm-usage.js");
    // $0.10/$0.50 per M → 2000/500 nominal tokens = $0.00045 = 0.045¢, rounded
    // UP to the 0.01¢ grid. The hosted judge runs on this model, so a 1¢
    // floor here would be a 20x overcharge against the caps.
    expect(estimatePrebillCents("claude-haiku-5-5")).toBeCloseTo(0.05, 6);
  });
});

describe("recordCostUsage — fractional carry over the integer-cents DB column", () => {
  it("accumulates sub-cent charges instead of writing 1¢ per call", async () => {
    process.env.DAILY_COST_CAP_CENTS = "100";
    vi.resetModules();
    const { recordCostUsage } = await import("../billing/cost-guard.js");
    await recordCostUsage("u1", 0.4, "flash");
    await recordCostUsage("u1", 0.4, "flash");
    await recordCostUsage("u1", 0.4, "flash");
    // 1.2¢ accumulated → exactly 1 whole cent flushed to the DB, 0.2¢ carried.
    expect(increments).toEqual([0, 0, 1]);
    expect(rows.get("u1")).toBe(1);
  });

  it("keeps integer-cent charges byte-identical to the old behavior", async () => {
    process.env.DAILY_COST_CAP_CENTS = "100";
    vi.resetModules();
    const { recordCostUsage } = await import("../billing/cost-guard.js");
    const usage = await recordCostUsage("u1", 20, "gpt-x");
    expect(increments).toEqual([20]);
    expect(usage).toEqual({ totalCents: 20, overCap: false });
  });

  it("keeps the fractional carry per user", async () => {
    process.env.DAILY_COST_CAP_CENTS = "100";
    vi.resetModules();
    const { recordCostUsage } = await import("../billing/cost-guard.js");
    await recordCostUsage("u1", 0.6, "flash");
    await recordCostUsage("u2", 0.6, "flash");
    await recordCostUsage("u1", 0.6, "flash");
    await recordCostUsage("u2", 0.6, "flash");
    expect(rows.get("u1")).toBe(1);
    expect(rows.get("u2")).toBe(1);
  });

  it("fires the user trip alert when the increment crosses the cap", async () => {
    process.env.DAILY_COST_CAP_CENTS = "100";
    vi.resetModules();
    rows.set("u1", 90);
    const { recordCostUsage } = await import("../billing/cost-guard.js");
    const usage = await recordCostUsage("u1", 20, "gpt-x");
    expect(usage?.overCap).toBe(true);
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "user", userId: "u1" }),
    );
  });
});

describe("global ceiling — float accumulation", () => {
  it("accumulates fractional cents without per-call rounding", async () => {
    process.env.GLOBAL_DAILY_COST_CAP_CENTS = "1";
    vi.resetModules();
    globalTable.clear();
    const { checkGlobalCostGate, recordGlobalCostUsage } = await import("../billing/cost-guard.js");
    await recordGlobalCostUsage(0.3);
    await recordGlobalCostUsage(0.3);
    await recordGlobalCostUsage(0.3);
    // Old behavior: 3 calls × round(0.3)=0 (or ×1¢ prebill) — either dead or
    // instantly tripped. New: exactly 0.9¢ accumulated, still under the 1¢ cap.
    const gate = await checkGlobalCostGate();
    expect(gate.allowed).toBe(true);
    expect(gate.usedCents).toBeCloseTo(0.9, 6);
    await recordGlobalCostUsage(0.1);
    expect((await checkGlobalCostGate()).allowed).toBe(false);
  });

  it("fires the global trip alert exactly when the accumulation crosses the cap", async () => {
    process.env.GLOBAL_DAILY_COST_CAP_CENTS = "1";
    vi.resetModules();
    globalTable.clear();
    const { recordGlobalCostUsage } = await import("../billing/cost-guard.js");
    await recordGlobalCostUsage(0.5);
    expect(notifySpy).not.toHaveBeenCalled();
    await recordGlobalCostUsage(0.5);
    expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({ scope: "global" }));
  });

  it("keeps integer accumulation identical to the old behavior", async () => {
    process.env.GLOBAL_DAILY_COST_CAP_CENTS = "50";
    vi.resetModules();
    globalTable.clear();
    const { checkGlobalCostGate, recordGlobalCostUsage } = await import("../billing/cost-guard.js");
    await recordGlobalCostUsage(30);
    expect((await checkGlobalCostGate()).remainingCents).toBe(20);
    await recordGlobalCostUsage(20);
    expect((await checkGlobalCostGate()).allowed).toBe(false);
  });
});
