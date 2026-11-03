import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const aggregate = vi.hoisted(() => vi.fn());
const pacerLoad = vi.hoisted(() => vi.fn(() => ({ active: 0, waiting: 0, maxConcurrent: 2 })));
const globalGate = vi.hoisted(() =>
  vi.fn(async () => ({ allowed: true, remainingCents: Number.POSITIVE_INFINITY })),
);

vi.mock("../db.js", () => ({ db: { attentionFacts: { aggregate } }, prisma: {} }));
vi.mock("../billing/cost-guard.js", () => ({
  checkCostGate: vi.fn(async () => ({ allowed: true, remainingCents: 80, capCents: 75 })),
  checkGlobalCostGate: globalGate,
}));
vi.mock("../billing/quota-limiter.js", () => ({
  getUserUsage: () => ({ rpmUsed: 0, rpmCap: 10, backgroundDailyUsed: 0, backgroundDailyCap: 200 }),
}));
vi.mock("../llm/background-pacer.js", () => ({ backgroundLlmPacer: { load: pacerLoad } }));

import {
  _resetGlobalShadowSpendCache,
  globalShadowDailyUsd,
  globalShadowReserveCents,
  pacerHasRoom,
  shadowBudgetVerdict,
} from "../judge/v3/shadow-budget.js";

/** The per-user sum has a userId in its where; the global one does not. */
function spend(user: number, global: number) {
  aggregate.mockImplementation(async ({ where }: { where: { userId?: string } }) => ({
    _sum: { costUsd: where.userId ? user : global },
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetGlobalShadowSpendCache();
  spend(0.01, 0.5);
  // Pin the cap so the test does not depend on the runner's GLOBAL_DAILY_COST_CAP_CENTS.
  process.env.JUDGE_V3_SHADOW_GLOBAL_DAILY_USD = "5";
});
afterEach(() => {
  delete process.env.JUDGE_V3_SHADOW_GLOBAL_DAILY_USD;
});

describe("global shadow spend", () => {
  it("defaults to 10% of the global ceiling, $5/day when the ceiling is off, env wins", () => {
    delete process.env.JUDGE_V3_SHADOW_GLOBAL_DAILY_USD;
    expect(globalShadowDailyUsd(5000)).toBe(5);
    expect(globalShadowDailyUsd(2000)).toBe(2);
    expect(globalShadowDailyUsd(0)).toBe(5);
    process.env.JUDGE_V3_SHADOW_GLOBAL_DAILY_USD = "1.5";
    expect(globalShadowDailyUsd(5000)).toBe(1.5);
    process.env.JUDGE_V3_SHADOW_GLOBAL_DAILY_USD = "";
    expect(globalShadowDailyUsd(5000)).toBe(5);
  });

  it("stops every user's shadow once today's total reaches the cap", async () => {
    spend(0.01, 4.99);
    expect(await shadowBudgetVerdict("u1")).toBe("ok");
    _resetGlobalShadowSpendCache();
    spend(0.01, 5);
    expect(await shadowBudgetVerdict("u1")).toBe("global_shadow_budget");
  });

  it("reads the all-users sum at most once a minute (it scans the day)", async () => {
    await shadowBudgetVerdict("u1");
    await shadowBudgetVerdict("u2");
    const globalReads = aggregate.mock.calls.filter(
      ([arg]) => !(arg as { where: { userId?: string } }).where.userId,
    );
    expect(globalReads).toHaveLength(1);
  });

  it("keeps the last 10% of the global ceiling free of shadow spend", async () => {
    expect(globalShadowReserveCents(5000)).toBe(500);
    expect(globalShadowReserveCents(0)).toBe(0);
    globalGate.mockResolvedValueOnce({ allowed: true, remainingCents: 400 });
    expect(await shadowBudgetVerdict("u1")).toBe("global_budget");
  });
});

describe("pacer room", () => {
  it("runs only with a free slot and nobody queued, so it never waits behind the judge", async () => {
    expect(pacerHasRoom({ active: 1, waiting: 0, maxConcurrent: 2 })).toBe(true);
    expect(pacerHasRoom({ active: 2, waiting: 0, maxConcurrent: 2 })).toBe(false);
    expect(pacerHasRoom({ active: 0, waiting: 1, maxConcurrent: 2 })).toBe(false);
    pacerLoad.mockReturnValueOnce({ active: 2, waiting: 3, maxConcurrent: 2 });
    expect(await shadowBudgetVerdict("u1")).toBe("pacer_busy");
    expect(aggregate).not.toHaveBeenCalled();
  });
});
