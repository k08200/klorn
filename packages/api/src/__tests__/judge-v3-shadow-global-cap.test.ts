import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const aggregate = vi.hoisted(() => vi.fn());
const pacerLoad = vi.hoisted(() => vi.fn(() => ({ active: 0, waiting: 0, maxConcurrent: 2 })));

vi.mock("../db.js", () => ({ db: { attentionFacts: { aggregate } }, prisma: {} }));
vi.mock("../billing/cost-guard.js", () => ({
  checkCostGate: vi.fn(async () => ({ allowed: true, remainingCents: 80, capCents: 75 })),
  checkGlobalCostGate: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("../billing/quota-limiter.js", () => ({
  getUserUsage: () => ({ rpmUsed: 0, rpmCap: 10, backgroundDailyUsed: 0, backgroundDailyCap: 200 }),
}));
vi.mock("../llm/background-pacer.js", () => ({ backgroundLlmPacer: { load: pacerLoad } }));

import {
  globalShadowDailyUsd,
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
  spend(0.01, 0.5);
});
afterEach(() => {
  delete process.env.JUDGE_V3_SHADOW_GLOBAL_DAILY_USD;
});

describe("global shadow spend", () => {
  it("defaults to 10% of the global ceiling, $5/day when the ceiling is off, env wins", () => {
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
    spend(0.01, 5);
    expect(await shadowBudgetVerdict("u1")).toBe("global_shadow_budget");
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
