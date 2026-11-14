/**
 * The pooled Klorn Teams LLM budget (pricing-tiers.md: $0.80 / seat / day,
 * pooled across the team). A seat holder's daily cap is what the pool has
 * left after the other seated members' spend today, bounded by the 10x
 * anomaly brake, and never below what their own plan already gives them.
 * While TEAMS_ENABLED is off the cap is exactly what it was before seats.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  orgMembership: { findUnique: vi.fn(), findMany: vi.fn() },
  llmCostLedger: { findUnique: vi.fn(), aggregate: vi.fn(), upsert: vi.fn() },
  globalCostLedger: { findUnique: vi.fn(), upsert: vi.fn() },
}));
const captureError = vi.hoisted(() => vi.fn());
vi.mock("../db.js", () => ({ prisma: db, db }));
vi.mock("../sentry.js", () => ({ captureError }));
vi.mock("../billing/cost-trip-alert.js", () => ({ notifyCostCapTrip: vi.fn() }));

const ORIGINAL_ENV = { ...process.env };
const TODAY = new Date().toISOString().slice(0, 10);

function env(vars: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
}

async function gate() {
  return import("../billing/cost-guard.js");
}

const seated = (id: string, userId: string, role: "OWNER" | "MEMBER", day: number) => ({
  id,
  userId,
  orgId: "org-1",
  role,
  joinedAt: new Date(Date.UTC(2026, 10, day)),
});

/** me (u-me) holds a seat in org-1 with `seats` seats; u-owner and u-other are seated too. */
function seatHeld(seats = 2, othersSpentCents = 0) {
  db.orgMembership.findUnique.mockResolvedValue({
    id: "m-me",
    orgId: "org-1",
    org: { seatsPurchased: seats, subscriptionStatus: "active" },
  });
  db.orgMembership.findMany.mockResolvedValue([
    seated("m-owner", "u-owner", "OWNER", 1),
    seated("m-me", "u-me", "MEMBER", 2),
    seated("m-other", "u-other", "MEMBER", 3),
  ]);
  db.llmCostLedger.aggregate.mockResolvedValue({ _sum: { cents: othersSpentCents } });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.llmCostLedger.findUnique.mockResolvedValue({ cents: 0 });
  env({
    TEAMS_ENABLED: undefined,
    ROLLOUT_COHORT_USER_IDS: undefined,
    PAYWALL_ENABLED: "true",
    DAILY_COST_CAP_CENTS: "100",
    FREE_DAILY_COST_CAP_CENTS: "10",
    TEAM_SEAT_DAILY_COST_CAP_CENTS: undefined,
    JUDGE_BUDGET_RESERVE_CENTS: "0",
  });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("cost cap — TEAMS_ENABLED off (identical to before seats)", () => {
  it("keeps the plan caps and never looks up a seat or the pool", async () => {
    seatHeld(20, 0);
    const { checkCostGate } = await gate();
    db.user.findUnique.mockResolvedValue({ plan: "FREE", role: "USER" });
    expect(await checkCostGate("u-me")).toMatchObject({ capCents: 10, freeCapApplied: true });
    db.user.findUnique.mockResolvedValue({ plan: "PRO", role: "USER" });
    expect(await checkCostGate("u-me")).toMatchObject({ capCents: 100, freeCapApplied: false });
    db.user.findUnique.mockResolvedValue({ plan: "FREE", role: "ADMIN" });
    expect(await checkCostGate("u-me")).toMatchObject({ capCents: 100, freeCapApplied: false });
    expect(db.orgMembership.findUnique).not.toHaveBeenCalled();
    expect(db.llmCostLedger.aggregate).not.toHaveBeenCalled();
  });

  it("keeps the full cap with no lookup at all while the paywall is off", async () => {
    env({ PAYWALL_ENABLED: undefined });
    const { checkCostGate } = await gate();
    expect(await checkCostGate("u-me")).toMatchObject({ capCents: 100, freeCapApplied: false });
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(db.orgMembership.findUnique).not.toHaveBeenCalled();
  });
});

describe("cost cap — TEAMS_ENABLED on, seat holder", () => {
  beforeEach(() => {
    env({ TEAMS_ENABLED: "on" });
  });

  it("gives a FREE-plan seat holder the pool left after the others' spend", async () => {
    seatHeld(2, 30);
    db.user.findUnique.mockResolvedValue({ plan: "FREE", role: "USER" });
    const { checkCostGate } = await gate();
    // pool 2 x 80 = 160, others spent 30 → 130; above the 10¢ free cap.
    expect(await checkCostGate("u-me")).toMatchObject({ capCents: 130, freeCapApplied: false });
    const where = db.llmCostLedger.aggregate.mock.calls[0]?.[0]?.where;
    // Only the OTHER seated members (seats 2: owner + me), today, cost only.
    expect(where).toEqual({ userId: { in: ["u-owner"] }, dayKey: TODAY });
  });

  it("keeps a personal Pro cap when the pool has less left (the higher one wins)", async () => {
    seatHeld(2, 100);
    db.user.findUnique.mockResolvedValue({ plan: "PRO", role: "USER" });
    const { checkCostGate } = await gate();
    expect(await checkCostGate("u-me")).toMatchObject({ capCents: 100, freeCapApplied: false });
  });

  it("raises a personal Pro cap when the pool has more left, paywall off too", async () => {
    env({ PAYWALL_ENABLED: undefined });
    seatHeld(3, 0);
    const { checkCostGate } = await gate();
    // pool 3 x 80 = 240 > the 100¢ everyone gets while the paywall is off.
    expect(await checkCostGate("u-me")).toMatchObject({ capCents: 240 });
  });

  it("falls back to the own plan's cap once the pool is spent", async () => {
    seatHeld(2, 500);
    db.user.findUnique.mockResolvedValue({ plan: "FREE", role: "USER" });
    const { checkCostGate } = await gate();
    // A seat holder is entitled, so the upgrade nudge would be wrong.
    expect(await checkCostGate("u-me")).toMatchObject({ capCents: 10, freeCapApplied: false });
  });

  it("bounds one member at the 10x anomaly brake however large the pool", async () => {
    seatHeld(20, 0);
    db.user.findUnique.mockResolvedValue({ plan: "FREE", role: "USER" });
    const { checkCostGate } = await gate();
    // pool 20 x 80 = 1600; one member stops at 10 x 80 = 800.
    expect(await checkCostGate("u-me")).toMatchObject({ capCents: 800 });
  });

  it("uses TEAM_SEAT_DAILY_COST_CAP_CENTS for the seat target", async () => {
    env({ TEAM_SEAT_DAILY_COST_CAP_CENTS: "50" });
    seatHeld(4, 20);
    db.user.findUnique.mockResolvedValue({ plan: "FREE", role: "USER" });
    const { checkCostGate } = await gate();
    expect(await checkCostGate("u-me")).toMatchObject({ capCents: 180 });
  });

  it("leaves a disabled gate (cap 0) disabled", async () => {
    env({ DAILY_COST_CAP_CENTS: "0", PAYWALL_ENABLED: undefined });
    seatHeld(2, 0);
    const { checkCostGate } = await gate();
    expect(await checkCostGate("u-me")).toMatchObject({ allowed: true, capCents: 0 });
    expect(db.orgMembership.findUnique).not.toHaveBeenCalled();
  });

  it("keeps the own plan's cap without a held seat", async () => {
    db.orgMembership.findUnique.mockResolvedValue(null);
    db.user.findUnique.mockResolvedValue({ plan: "FREE", role: "USER" });
    const { checkCostGate } = await gate();
    expect(await checkCostGate("u-me")).toMatchObject({ capCents: 10, freeCapApplied: true });
    expect(db.llmCostLedger.aggregate).not.toHaveBeenCalled();
  });

  it("reports a failed pool lookup and keeps the own plan's cap", async () => {
    db.orgMembership.findUnique.mockRejectedValue(new Error("db down"));
    db.user.findUnique.mockResolvedValue({ plan: "FREE", role: "USER" });
    const { checkCostGate } = await gate();
    expect(await checkCostGate("u-me")).toMatchObject({ capCents: 10, freeCapApplied: true });
    expect(captureError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { scope: "cost-guard.team-pool" } }),
    );
  });

  it("caches the pool for a short window instead of querying on every call", async () => {
    seatHeld(2, 0);
    db.user.findUnique.mockResolvedValue({ plan: "FREE", role: "USER" });
    const { checkCostGate } = await gate();
    await checkCostGate("u-me");
    await checkCostGate("u-me");
    expect(db.orgMembership.findUnique).toHaveBeenCalledTimes(1);
    expect(db.llmCostLedger.aggregate).toHaveBeenCalledTimes(1);
  });

  it("ignores a user outside the cohort in cohort mode", async () => {
    env({ TEAMS_ENABLED: "cohort", ROLLOUT_COHORT_USER_IDS: "someone-else" });
    seatHeld(2, 0);
    db.user.findUnique.mockResolvedValue({ plan: "FREE", role: "USER" });
    const { checkCostGate } = await gate();
    expect(await checkCostGate("u-me")).toMatchObject({ capCents: 10, freeCapApplied: true });
    expect(db.orgMembership.findUnique).not.toHaveBeenCalled();
  });
});
