import { afterEach, describe, expect, it, vi } from "vitest";

let mockRow: { cents: number } | null = null;
const upserts: Array<{ userId: string; dayKey: string; data: Record<string, unknown> }> = [];

vi.mock("../db.js", () => ({
  prisma: {
    llmCostLedger: {
      findUnique: vi.fn(async () => mockRow),
      upsert: vi.fn(async (args: unknown) => {
        const a = args as {
          where: { userId_dayKey: { userId: string; dayKey: string } };
          create: Record<string, unknown>;
        };
        upserts.push({
          userId: a.where.userId_dayKey.userId,
          dayKey: a.where.userId_dayKey.dayKey,
          data: a.create,
        });
        return {};
      }),
    },
  },
}));

const ORIGINAL_CAP = process.env.DAILY_COST_CAP_CENTS;
const ORIGINAL_GLOBAL_CAP = process.env.GLOBAL_DAILY_COST_CAP_CENTS;

afterEach(() => {
  mockRow = null;
  upserts.length = 0;
  if (ORIGINAL_CAP === undefined) {
    delete process.env.DAILY_COST_CAP_CENTS;
  } else {
    process.env.DAILY_COST_CAP_CENTS = ORIGINAL_CAP;
  }
  if (ORIGINAL_GLOBAL_CAP === undefined) {
    delete process.env.GLOBAL_DAILY_COST_CAP_CENTS;
  } else {
    process.env.GLOBAL_DAILY_COST_CAP_CENTS = ORIGINAL_GLOBAL_CAP;
  }
});

describe("usdToCents", () => {
  it("returns 0 for zero/negative", async () => {
    const { usdToCents } = await import("../cost-guard.js");
    expect(usdToCents(0)).toBe(0);
    expect(usdToCents(-1)).toBe(0);
  });

  it("rounds up so sub-cent calls still register as 1¢", async () => {
    const { usdToCents } = await import("../cost-guard.js");
    expect(usdToCents(0.0001)).toBe(1); // 0.01¢ → 1¢ (paid-model floor)
    expect(usdToCents(0.012)).toBe(2); // 1.2¢ → 2¢
    expect(usdToCents(1.5)).toBe(150);
  });
});

describe("checkCostGate", () => {
  it("returns allowed=true with infinite remaining when cap is 0", async () => {
    // Re-import after env mutation: vi.resetModules + dynamic import keeps
    // the module reading the current env at evaluation time.
    process.env.DAILY_COST_CAP_CENTS = "0";
    vi.resetModules();
    const { checkCostGate } = await import("../cost-guard.js");
    const result = await checkCostGate("user-1");
    expect(result.allowed).toBe(true);
    expect(result.capCents).toBe(0);
  });

  it("allows when usage is below the cap", async () => {
    process.env.DAILY_COST_CAP_CENTS = "100";
    vi.resetModules();
    mockRow = { cents: 42 };
    const { checkCostGate } = await import("../cost-guard.js");
    const result = await checkCostGate("user-1");
    expect(result.allowed).toBe(true);
    expect(result.remainingCents).toBe(58);
    expect(result.usedCents).toBe(42);
  });

  it("blocks when usage has reached the cap exactly", async () => {
    process.env.DAILY_COST_CAP_CENTS = "100";
    vi.resetModules();
    mockRow = { cents: 100 };
    const { checkCostGate } = await import("../cost-guard.js");
    const result = await checkCostGate("user-1");
    expect(result.allowed).toBe(false);
    expect(result.remainingCents).toBe(0);
    expect(result.reason).toMatch(/cap/i);
  });

  it("blocks when usage exceeds the cap", async () => {
    process.env.DAILY_COST_CAP_CENTS = "100";
    vi.resetModules();
    mockRow = { cents: 200 };
    const { checkCostGate } = await import("../cost-guard.js");
    const result = await checkCostGate("user-1");
    expect(result.allowed).toBe(false);
  });
});

describe("checkGlobalCostGate", () => {
  it("is disabled (infinite) when the global cap is 0", async () => {
    process.env.GLOBAL_DAILY_COST_CAP_CENTS = "0";
    vi.resetModules();
    const { checkGlobalCostGate } = await import("../cost-guard.js");
    expect(checkGlobalCostGate().allowed).toBe(true);
    expect(checkGlobalCostGate().capCents).toBe(0);
  });

  it("blocks system (userId-less) spend once the aggregate reaches the cap", async () => {
    process.env.GLOBAL_DAILY_COST_CAP_CENTS = "50";
    vi.resetModules();
    const { checkGlobalCostGate, recordGlobalCostUsage, __resetGlobalSpendForTest } = await import(
      "../cost-guard.js"
    );
    __resetGlobalSpendForTest();
    expect(checkGlobalCostGate().allowed).toBe(true);
    recordGlobalCostUsage(30);
    expect(checkGlobalCostGate().allowed).toBe(true);
    expect(checkGlobalCostGate().remainingCents).toBe(20);
    recordGlobalCostUsage(20); // now at 50, the cap
    const blocked = checkGlobalCostGate();
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/global/i);
  });
});
