import { afterEach, describe, expect, it, vi } from "vitest";

let mockRow: { cents: number } | null = null;
let mockUpsertCents = 0;
let upsertShouldThrow = false;
let mockUser: { plan: string; role: string | null } | null = null;
let userLookupShouldThrow = false;
const upserts: Array<{ userId: string; dayKey: string; data: Record<string, unknown> }> = [];

vi.mock("../db.js", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => {
        if (userLookupShouldThrow) throw new Error("db down");
        return mockUser;
      }),
    },
    llmCostLedger: {
      findUnique: vi.fn(async () => mockRow),
      upsert: vi.fn(async (args: unknown) => {
        if (upsertShouldThrow) throw new Error("db down");
        const a = args as {
          where: { userId_dayKey: { userId: string; dayKey: string } };
          create: Record<string, unknown>;
        };
        upserts.push({
          userId: a.where.userId_dayKey.userId,
          dayKey: a.where.userId_dayKey.dayKey,
          data: a.create,
        });
        // Post-increment total the real DB would return from `select: { cents }`.
        return { cents: mockUpsertCents };
      }),
    },
  },
}));

const ORIGINAL_CAP = process.env.DAILY_COST_CAP_CENTS;
const ORIGINAL_GLOBAL_CAP = process.env.GLOBAL_DAILY_COST_CAP_CENTS;
const ORIGINAL_FREE_CAP = process.env.FREE_DAILY_COST_CAP_CENTS;
const ORIGINAL_PAYWALL = process.env.PAYWALL_ENABLED;

afterEach(() => {
  mockRow = null;
  mockUpsertCents = 0;
  upsertShouldThrow = false;
  mockUser = null;
  userLookupShouldThrow = false;
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
  if (ORIGINAL_FREE_CAP === undefined) {
    delete process.env.FREE_DAILY_COST_CAP_CENTS;
  } else {
    process.env.FREE_DAILY_COST_CAP_CENTS = ORIGINAL_FREE_CAP;
  }
  if (ORIGINAL_PAYWALL === undefined) {
    delete process.env.PAYWALL_ENABLED;
  } else {
    process.env.PAYWALL_ENABLED = ORIGINAL_PAYWALL;
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

describe("checkCostGate — free-tier plan-aware cap (paywall on)", () => {
  const enablePaywall = () => {
    process.env.PAYWALL_ENABLED = "true";
    process.env.DAILY_COST_CAP_CENTS = "100";
    process.env.FREE_DAILY_COST_CAP_CENTS = "10";
    vi.resetModules();
  };

  it("caps a free (non-entitled) user at the free cap, not the full cap", async () => {
    enablePaywall();
    mockUser = { plan: "FREE", role: "USER" };
    mockRow = { cents: 5 };
    const { checkCostGate } = await import("../cost-guard.js");
    const result = await checkCostGate("free-1");
    expect(result.capCents).toBe(10);
    expect(result.allowed).toBe(true);
    expect(result.remainingCents).toBe(5);
  });

  it("blocks a free user once they reach the free cap", async () => {
    enablePaywall();
    mockUser = { plan: "FREE", role: "USER" };
    mockRow = { cents: 10 };
    const { checkCostGate } = await import("../cost-guard.js");
    const result = await checkCostGate("free-1");
    expect(result.allowed).toBe(false);
    expect(result.capCents).toBe(10);
  });

  it("keeps the full cap for an entitled (PRO) user", async () => {
    enablePaywall();
    mockUser = { plan: "PRO", role: "USER" };
    mockRow = { cents: 50 };
    const { checkCostGate } = await import("../cost-guard.js");
    const result = await checkCostGate("pro-1");
    expect(result.capCents).toBe(100);
    expect(result.allowed).toBe(true);
  });

  it("keeps the full cap for an ADMIN even on the free plan", async () => {
    enablePaywall();
    mockUser = { plan: "FREE", role: "ADMIN" };
    mockRow = { cents: 50 };
    const { checkCostGate } = await import("../cost-guard.js");
    const result = await checkCostGate("admin-1");
    expect(result.capCents).toBe(100);
    expect(result.allowed).toBe(true);
  });

  it("fails safe to the full cap when the plan lookup throws", async () => {
    enablePaywall();
    userLookupShouldThrow = true;
    mockRow = { cents: 50 };
    const { checkCostGate } = await import("../cost-guard.js");
    const result = await checkCostGate("free-1");
    // A DB blip must not wrongly block a free user nor throw on the hot path.
    expect(result.capCents).toBe(100);
    expect(result.allowed).toBe(true);
  });

  it("ignores plan and uses the full cap when the paywall is off", async () => {
    process.env.PAYWALL_ENABLED = "false";
    process.env.DAILY_COST_CAP_CENTS = "100";
    process.env.FREE_DAILY_COST_CAP_CENTS = "10";
    vi.resetModules();
    mockUser = { plan: "FREE", role: "USER" };
    mockRow = { cents: 50 };
    const { checkCostGate } = await import("../cost-guard.js");
    const result = await checkCostGate("free-1");
    expect(result.capCents).toBe(100);
    expect(result.allowed).toBe(true);
  });
});

describe("checkCostGate — freeCapApplied signal (drives the upgrade-vs-BYOK cap message)", () => {
  const enablePaywall = () => {
    process.env.PAYWALL_ENABLED = "true";
    process.env.DAILY_COST_CAP_CENTS = "100";
    process.env.FREE_DAILY_COST_CAP_CENTS = "10";
    vi.resetModules();
  };

  it("flags freeCapApplied when the free-tier cap gated a non-entitled user", async () => {
    enablePaywall();
    mockUser = { plan: "FREE", role: "USER" };
    mockRow = { cents: 10 };
    const { checkCostGate } = await import("../cost-guard.js");
    const result = await checkCostGate("free-1");
    expect(result.allowed).toBe(false);
    expect(result.freeCapApplied).toBe(true);
  });

  it("flags freeCapApplied even while the free user is still under the cap", async () => {
    enablePaywall();
    mockUser = { plan: "FREE", role: "USER" };
    mockRow = { cents: 3 };
    const { checkCostGate } = await import("../cost-guard.js");
    const result = await checkCostGate("free-1");
    expect(result.allowed).toBe(true);
    expect(result.freeCapApplied).toBe(true);
  });

  it("does not flag freeCapApplied for an entitled (PRO) user", async () => {
    enablePaywall();
    mockUser = { plan: "PRO", role: "USER" };
    mockRow = { cents: 100 };
    const { checkCostGate } = await import("../cost-guard.js");
    const result = await checkCostGate("pro-1");
    expect(result.freeCapApplied).toBe(false);
  });

  it("does not flag freeCapApplied when the paywall is off", async () => {
    process.env.PAYWALL_ENABLED = "false";
    process.env.DAILY_COST_CAP_CENTS = "100";
    process.env.FREE_DAILY_COST_CAP_CENTS = "10";
    vi.resetModules();
    mockUser = { plan: "FREE", role: "USER" };
    mockRow = { cents: 100 };
    const { checkCostGate } = await import("../cost-guard.js");
    const result = await checkCostGate("free-1");
    expect(result.freeCapApplied).toBe(false);
  });

  it("does not flag freeCapApplied when the plan lookup fails (fail-open path)", async () => {
    enablePaywall();
    userLookupShouldThrow = true;
    mockRow = { cents: 100 };
    const { checkCostGate } = await import("../cost-guard.js");
    const result = await checkCostGate("free-1");
    // Fail-open resolves to the FULL cap, so the message must not claim a free
    // quota was exhausted.
    expect(result.freeCapApplied).toBe(false);
  });
});

describe("recordCostUsage — atomic pre-bill with post-increment over-cap signal (M3/L)", () => {
  it("returns the post-increment total and flags overCap when the atomic increment crosses the cap", async () => {
    process.env.DAILY_COST_CAP_CENTS = "100";
    vi.resetModules();
    mockUpsertCents = 130; // two concurrent calls both passed the read gate, total now 130
    const { recordCostUsage } = await import("../cost-guard.js");
    const usage = await recordCostUsage("user-1", 20, "gpt-x");
    expect(usage).toEqual({ totalCents: 130, overCap: true });
    // select cents so the caller can short-circuit on the real total
    expect(upserts).toHaveLength(1);
  });

  it("does not flag overCap when the post-increment total is under the cap", async () => {
    process.env.DAILY_COST_CAP_CENTS = "100";
    vi.resetModules();
    mockUpsertCents = 80;
    const { recordCostUsage } = await import("../cost-guard.js");
    expect(await recordCostUsage("user-1", 20, "gpt-x")).toEqual({
      totalCents: 80,
      overCap: false,
    });
  });

  it("never flags overCap when the cap is disabled (0)", async () => {
    process.env.DAILY_COST_CAP_CENTS = "0";
    vi.resetModules();
    mockUpsertCents = 9999;
    const { recordCostUsage } = await import("../cost-guard.js");
    expect(await recordCostUsage("user-1", 20, "gpt-x")).toEqual({
      totalCents: 9999,
      overCap: false,
    });
  });

  it("returns null on a ledger write failure (best-effort, never throws)", async () => {
    process.env.DAILY_COST_CAP_CENTS = "100";
    vi.resetModules();
    upsertShouldThrow = true;
    const { recordCostUsage } = await import("../cost-guard.js");
    expect(await recordCostUsage("user-1", 20, "gpt-x")).toBeNull();
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
