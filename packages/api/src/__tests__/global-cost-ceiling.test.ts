/**
 * The global daily ceiling counts Klorn Teams' paid seat pools
 * (pricing-tiers.md: "The global breaker scales with active users (3 × the
 * sum of active users' targets + a system allowance)"). Until the full
 * scaling breaker (PR6) lands, the fixed GLOBAL_DAILY_COST_CAP_CENTS stays
 * the base for everyone else, and every active paid seat adds three seat
 * targets on top, so a team's pool can never sit above the all-users ceiling.
 * While TEAMS_ENABLED is off the ceiling is the base exactly, with no query.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  organization: { aggregate: vi.fn() },
  globalCostLedger: { findUnique: vi.fn(), upsert: vi.fn() },
}));
const captureError = vi.hoisted(() => vi.fn());
vi.mock("../db.js", () => ({ prisma: db, db }));
vi.mock("../sentry.js", () => ({ captureError }));
vi.mock("../billing/cost-trip-alert.js", () => ({ notifyCostCapTrip: vi.fn() }));

const ORIGINAL_ENV = { ...process.env };

function env(vars: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
}

async function guard() {
  return import("../billing/cost-guard.js");
}

async function ceiling() {
  return import("../billing/global-cost-ceiling.js");
}

function seatsBilled(seats: number | null) {
  db.organization.aggregate.mockResolvedValue({ _sum: { seatsPurchased: seats } });
}

beforeEach(() => {
  vi.resetAllMocks();
  db.globalCostLedger.findUnique.mockResolvedValue(null);
  env({
    TEAMS_ENABLED: undefined,
    ROLLOUT_COHORT_USER_IDS: undefined,
    GLOBAL_DAILY_COST_CAP_CENTS: "5000",
    TEAM_SEAT_DAILY_COST_CAP_CENTS: "80",
  });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("global ceiling while Teams is off", () => {
  it("is the fixed base exactly and queries no organization", async () => {
    seatsBilled(150);
    const { checkGlobalCostGate, recordGlobalCostUsage } = await guard();
    db.globalCostLedger.upsert.mockResolvedValue({ microCents: 5000 * 10_000 });

    expect((await checkGlobalCostGate()).capCents).toBe(5000);
    expect((await recordGlobalCostUsage(1))?.overCap).toBe(true);
    expect(db.organization.aggregate).not.toHaveBeenCalled();
  });
});

describe("global ceiling with Teams on", () => {
  it("adds three seat targets for every active paid seat, so a 150-seat pool fits", async () => {
    env({ TEAMS_ENABLED: "true" });
    seatsBilled(150);
    const { checkGlobalCostGate } = await guard();
    const gate = await checkGlobalCostGate();
    // 5000 + 3 × 80 × 150
    expect(gate.capCents).toBe(41_000);
    expect(gate.capCents).toBeGreaterThan(150 * 80);
    const where = db.organization.aggregate.mock.calls[0]?.[0]?.where;
    expect(where).toEqual({ subscriptionStatus: { in: ["active", "trialing"] } });
  });

  it("uses the raised ceiling for the record-side re-check too", async () => {
    env({ TEAMS_ENABLED: "true" });
    seatsBilled(10);
    const { recordGlobalCostUsage } = await guard();
    // 5000 + 3 × 80 × 10 = 7400: 6000¢ spent is under it.
    db.globalCostLedger.upsert.mockResolvedValue({ microCents: 6000 * 10_000 });
    expect(await recordGlobalCostUsage(1)).toEqual({ totalCents: 6000, overCap: false });
    db.globalCostLedger.upsert.mockResolvedValue({ microCents: 7400 * 10_000 });
    expect((await recordGlobalCostUsage(1))?.overCap).toBe(true);
  });

  it("counts only organizations with a cohort member in cohort mode, and none with an empty cohort", async () => {
    env({ TEAMS_ENABLED: "cohort", ROLLOUT_COHORT_USER_IDS: "u-1,u-2" });
    seatsBilled(4);
    const { globalDailyCapCents } = await ceiling();
    expect(await globalDailyCapCents()).toBe(5000 + 3 * 80 * 4);
    expect(db.organization.aggregate.mock.calls[0]?.[0]?.where).toEqual({
      subscriptionStatus: { in: ["active", "trialing"] },
      memberships: { some: { userId: { in: ["u-1", "u-2"] } } },
    });

    env({ TEAMS_ENABLED: "cohort", ROLLOUT_COHORT_USER_IDS: undefined });
    db.organization.aggregate.mockClear();
    const empty = await ceiling();
    expect(await empty.globalDailyCapCents()).toBe(5000);
    expect(db.organization.aggregate).not.toHaveBeenCalled();
  });

  it("reads the seats at most once a minute", async () => {
    env({ TEAMS_ENABLED: "true" });
    seatsBilled(2);
    const { teamSeatBreakerCents } = await ceiling();
    const t0 = Date.UTC(2026, 10, 15, 12);
    expect(await teamSeatBreakerCents(t0)).toBe(480);
    seatsBilled(3);
    expect(await teamSeatBreakerCents(t0 + 59_000)).toBe(480);
    expect(await teamSeatBreakerCents(t0 + 61_000)).toBe(720);
    expect(db.organization.aggregate).toHaveBeenCalledTimes(2);
  });

  it("falls back to the base on a failed read, reports it once, and retries after 5 s", async () => {
    env({ TEAMS_ENABLED: "true" });
    db.organization.aggregate.mockRejectedValue(new Error("db down"));
    const { teamSeatBreakerCents } = await ceiling();
    const t0 = Date.UTC(2026, 10, 15, 12);
    expect(await teamSeatBreakerCents(t0)).toBe(0);
    expect(await teamSeatBreakerCents(t0 + 1_000)).toBe(0);
    expect(captureError).toHaveBeenCalledTimes(1);
    seatsBilled(2);
    expect(await teamSeatBreakerCents(t0 + 6_000)).toBe(480);
  });

  it("keeps the last good value on a failed read, so a blip cannot trip the ceiling for everyone", async () => {
    env({ TEAMS_ENABLED: "true" });
    seatsBilled(10);
    const { teamSeatBreakerCents } = await ceiling();
    const t0 = Date.UTC(2026, 10, 15, 12);
    expect(await teamSeatBreakerCents(t0)).toBe(2400);
    db.organization.aggregate.mockRejectedValue(new Error("db blip"));
    expect(await teamSeatBreakerCents(t0 + 61_000)).toBe(2400);
    expect(captureError).toHaveBeenCalledTimes(1);
  });

  it("never lowers the base, even with a negative seat target configured", async () => {
    env({ TEAMS_ENABLED: "true", TEAM_SEAT_DAILY_COST_CAP_CENTS: "-80" });
    seatsBilled(150);
    const { globalDailyCapCents } = await ceiling();
    expect(await globalDailyCapCents()).toBe(5000);
  });

  it("stays disabled when the base is 0 (DB-less jobs), with no query", async () => {
    env({ TEAMS_ENABLED: "true", GLOBAL_DAILY_COST_CAP_CENTS: "0" });
    seatsBilled(150);
    const { checkGlobalCostGate, recordGlobalCostUsage } = await guard();
    expect((await checkGlobalCostGate()).capCents).toBe(0);
    expect(await recordGlobalCostUsage(5)).toBeNull();
    expect(db.organization.aggregate).not.toHaveBeenCalled();
    expect(db.globalCostLedger.upsert).not.toHaveBeenCalled();
  });

  it("treats no active organization as no extra headroom", async () => {
    env({ TEAMS_ENABLED: "true" });
    seatsBilled(null);
    const { globalDailyCapCents } = await ceiling();
    expect(await globalDailyCapCents()).toBe(5000);
  });
});
