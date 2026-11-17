/**
 * cachedHeldTeamSeat / effectivePlanCached: the seat lookups that run on every
 * LLM call (the pooled cost cap and BYOK on a seat). One organization's roster
 * is read once per window for all of its members, the window is bounded
 * (SEAT_CACHE_TTL_MS) so a removed seat stops counting within it, a failed
 * read throws once and then reads as "no seat" for a short while, and the
 * cache holds a bounded number of users. While TEAMS_ENABLED is closed to a
 * user it reads nothing and hands the own plan back untouched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  orgMembership: { findUnique: vi.fn(), findMany: vi.fn() },
}));
vi.mock("../db.js", () => ({ prisma: db, db }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const ORIGINAL_ENV = { ...process.env };
const T0 = Date.UTC(2026, 10, 17, 12, 0, 0);

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.TEAMS_ENABLED;
  delete process.env.ROLLOUT_COHORT_USER_IDS;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

const userIdOf = (i: number) => `u-${i}`;

/**
 * org-1 with `members` members (u-0 the owner, then u-1, u-2, … by join time)
 * billing `seats` seats. Each findUnique answers the asking user's membership.
 */
function orgOf(members: number, seats: number, status = "active") {
  const roster = Array.from({ length: members }, (_, i) => ({
    id: `m-${i}`,
    userId: userIdOf(i),
    orgId: "org-1",
    role: i === 0 ? ("OWNER" as const) : ("MEMBER" as const),
    joinedAt: new Date(Date.UTC(2026, 10, 1) + i * 60_000),
  }));
  db.orgMembership.findUnique.mockImplementation(async (args: { where: { userId: string } }) => {
    const mine = roster.find((m) => m.userId === args.where.userId);
    return mine
      ? { id: mine.id, orgId: "org-1", org: { seatsPurchased: seats, subscriptionStatus: status } }
      : null;
  });
  db.orgMembership.findMany.mockResolvedValue(roster);
  return roster;
}

function seatQueries(): number {
  return (
    db.orgMembership.findUnique.mock.calls.length + db.orgMembership.findMany.mock.calls.length
  );
}

describe("cached seat lookup — TEAMS_ENABLED off (byte-identical)", () => {
  it("hands back the own plan value untouched and reads nothing", async () => {
    orgOf(3, 3);
    const { cachedHeldTeamSeat, effectivePlanCached } = await import("../org/seat-cache.js");
    for (const plan of ["FREE", "PRO", "TEAM", "ENTERPRISE", "nonsense", ""]) {
      expect(await effectivePlanCached({ id: "u-1", plan })).toBe(plan);
    }
    expect(await cachedHeldTeamSeat("u-1")).toBeNull();
    expect(seatQueries()).toBe(0);
  });

  it("reads nothing for a user outside the cohort", async () => {
    process.env.TEAMS_ENABLED = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = "someone-else";
    orgOf(3, 3);
    const { effectivePlanCached } = await import("../org/seat-cache.js");
    expect(await effectivePlanCached({ id: "u-1", plan: "FREE" })).toBe("FREE");
    expect(seatQueries()).toBe(0);
  });
});

describe("cached seat lookup — TEAMS_ENABLED on", () => {
  beforeEach(() => {
    process.env.TEAMS_ENABLED = "on";
  });

  it("names the same seat as the uncached resolver", async () => {
    orgOf(4, 3, "trialing");
    const { cachedHeldTeamSeat } = await import("../org/seat-cache.js");
    const { heldTeamSeat } = await import("../org/effective-tier.js");
    const cached = await cachedHeldTeamSeat("u-1", T0);
    expect(cached).toEqual({
      orgId: "org-1",
      seatsPurchased: 3,
      seatedUserIds: ["u-0", "u-1", "u-2"],
    });
    expect(cached).toEqual(await heldTeamSeat("u-1"));
    // The fourth member joined after the purchased seats ran out.
    expect(await cachedHeldTeamSeat("u-3", T0)).toBeNull();
  });

  it("reads one organization's roster once per window for all of its members", async () => {
    const members = 150;
    orgOf(members, members);
    const { cachedHeldTeamSeat, effectivePlanCached } = await import("../org/seat-cache.js");
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < members; i++) {
        expect(await cachedHeldTeamSeat(userIdOf(i), T0 + round * 1_000)).not.toBeNull();
        expect(await effectivePlanCached({ id: userIdOf(i), plan: "FREE" }, T0)).toBe("TEAM");
      }
    }
    // One membership read (the first member) and one roster read prime every
    // other member: two queries, not two per member (300).
    expect(db.orgMembership.findUnique).toHaveBeenCalledTimes(1);
    expect(db.orgMembership.findMany).toHaveBeenCalledTimes(1);
  });

  it("keeps a removed seat until the window has passed, then drops it", async () => {
    orgOf(3, 3);
    const { cachedHeldTeamSeat, effectivePlanCached, SEAT_CACHE_TTL_MS } = await import(
      "../org/seat-cache.js"
    );
    expect(SEAT_CACHE_TTL_MS).toBe(30_000);
    expect(await effectivePlanCached({ id: "u-2", plan: "FREE" }, T0)).toBe("TEAM");
    // The owner removes u-2: the next read finds no membership.
    db.orgMembership.findUnique.mockResolvedValue(null);
    db.orgMembership.findMany.mockResolvedValue([]);
    expect(await effectivePlanCached({ id: "u-2", plan: "FREE" }, T0 + SEAT_CACHE_TTL_MS - 1)).toBe(
      "TEAM",
    );
    expect(seatQueries()).toBe(2);
    expect(await effectivePlanCached({ id: "u-2", plan: "FREE" }, T0 + SEAT_CACHE_TTL_MS)).toBe(
      "FREE",
    );
    expect(await cachedHeldTeamSeat("u-2", T0 + SEAT_CACHE_TTL_MS)).toBeNull();
    expect(seatQueries()).toBe(3);
  });

  it("sees a lapsed subscription once the window has passed", async () => {
    orgOf(3, 3);
    const { cachedHeldTeamSeat, SEAT_CACHE_TTL_MS } = await import("../org/seat-cache.js");
    expect(await cachedHeldTeamSeat("u-1", T0)).not.toBeNull();
    orgOf(3, 3, "past_due");
    expect(await cachedHeldTeamSeat("u-1", T0 + SEAT_CACHE_TTL_MS)).toBeNull();
    expect(await cachedHeldTeamSeat("u-0", T0 + SEAT_CACHE_TTL_MS)).toBeNull();
  });

  it("caches a user without a membership too (one read per window)", async () => {
    db.orgMembership.findUnique.mockResolvedValue(null);
    const { effectivePlanCached } = await import("../org/seat-cache.js");
    for (let i = 0; i < 5; i++) {
      expect(await effectivePlanCached({ id: "u-9", plan: "FREE" }, T0 + i)).toBe("FREE");
    }
    expect(db.orgMembership.findUnique).toHaveBeenCalledTimes(1);
    expect(db.orgMembership.findMany).not.toHaveBeenCalled();
  });

  it("never lowers TEAM or ENTERPRISE and reads nothing for them", async () => {
    orgOf(3, 3);
    const { effectivePlanCached } = await import("../org/seat-cache.js");
    expect(await effectivePlanCached({ id: "u-1", plan: "TEAM" }, T0)).toBe("TEAM");
    expect(await effectivePlanCached({ id: "u-1", plan: "ENTERPRISE" }, T0)).toBe("ENTERPRISE");
    expect(seatQueries()).toBe(0);
  });

  it("throws a failed membership read once, then reads no seat for 5 s", async () => {
    db.orgMembership.findUnique.mockRejectedValue(new Error("db down"));
    const { cachedHeldTeamSeat } = await import("../org/seat-cache.js");
    await expect(cachedHeldTeamSeat("u-1", T0)).rejects.toThrow("db down");
    expect(await cachedHeldTeamSeat("u-1", T0 + 4_999)).toBeNull();
    expect(db.orgMembership.findUnique).toHaveBeenCalledTimes(1);
    await expect(cachedHeldTeamSeat("u-1", T0 + 5_000)).rejects.toThrow("db down");
  });

  it("throws a failed roster read once for the organization, then reads no seat for 5 s", async () => {
    orgOf(3, 3);
    db.orgMembership.findMany.mockRejectedValue(new Error("db down"));
    const { cachedHeldTeamSeat } = await import("../org/seat-cache.js");
    await expect(cachedHeldTeamSeat("u-1", T0)).rejects.toThrow("db down");
    // Another member of the same organization: no second report-worthy throw.
    expect(await cachedHeldTeamSeat("u-2", T0 + 1)).toBeNull();
    expect(db.orgMembership.findMany).toHaveBeenCalledTimes(1);
    orgOf(3, 3);
    expect(await cachedHeldTeamSeat("u-2", T0 + 5_001)).not.toBeNull();
  });

  it("shares one roster read among members whose first calls overlap", async () => {
    const members = 150;
    orgOf(members, members);
    const { cachedHeldTeamSeat } = await import("../org/seat-cache.js");
    const seats = await Promise.all(
      Array.from({ length: members }, (_, i) => cachedHeldTeamSeat(userIdOf(i), T0)),
    );
    expect(seats.every((seat) => seat?.seatsPurchased === members)).toBe(true);
    // Each member finds their organization once; the roster is read once.
    expect(db.orgMembership.findUnique).toHaveBeenCalledTimes(members);
    expect(db.orgMembership.findMany).toHaveBeenCalledTimes(1);
    // The same member's overlapping calls share their membership read too.
    db.orgMembership.findUnique.mockClear();
    await Promise.all([cachedHeldTeamSeat("u-loner", T0), cachedHeldTeamSeat("u-loner", T0)]);
    expect(db.orgMembership.findUnique).toHaveBeenCalledTimes(1);
  });

  it("reads no roster for an organization without seats", async () => {
    orgOf(3, 0);
    const { cachedHeldTeamSeat } = await import("../org/seat-cache.js");
    expect(await cachedHeldTeamSeat("u-0", T0)).toBeNull();
    expect(await cachedHeldTeamSeat("u-0", T0 + 1)).toBeNull();
    expect(db.orgMembership.findUnique).toHaveBeenCalledTimes(1);
    expect(db.orgMembership.findMany).not.toHaveBeenCalled();
  });

  it("holds a bounded number of users", async () => {
    db.orgMembership.findUnique.mockResolvedValue(null);
    const { effectivePlanCached, __seatCacheSizeForTest, SEAT_CACHE_MAX_USERS } = await import(
      "../org/seat-cache.js"
    );
    for (let i = 0; i < SEAT_CACHE_MAX_USERS + 50; i++) {
      await effectivePlanCached({ id: `loner-${i}`, plan: "FREE" }, T0);
    }
    expect(__seatCacheSizeForTest().users).toBe(SEAT_CACHE_MAX_USERS);
  });
});
