/**
 * effectivePlan / effectivePlans: the one resolver every plan gate reads
 * (Klorn Teams v1.1, gap 1). While TEAMS_ENABLED is closed to a user it must
 * hand back that user's own plan value untouched and run no query, so every
 * gate helper answers exactly what it answered before seats existed. With the
 * flag open, a held paid seat raises the plan to TEAM.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  orgMembership: { findUnique: vi.fn(), findMany: vi.fn() },
}));
const captureError = vi.hoisted(() => vi.fn());
vi.mock("../db.js", () => ({ prisma: db, db }));
vi.mock("../sentry.js", () => ({ captureError }));

const ORIGINAL_ENV = { ...process.env };
const PLANS_UNDER_TEST = ["FREE", "PRO", "TEAM", "ENTERPRISE"] as const;
const ROLES_UNDER_TEST = [undefined, "USER", "ADMIN"] as const;

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.TEAMS_ENABLED;
  delete process.env.ROLLOUT_COHORT_USER_IDS;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

const member = (id: string, role: "OWNER" | "MEMBER", joinedAt: string, orgId = "org-1") => ({
  id,
  orgId,
  role,
  joinedAt: new Date(joinedAt),
});

/** u-1 holds membership m-1 in org-1 (2 seats, owner m-0 + m-1 seated). */
function seatHeld(status = "active", seats = 2) {
  db.orgMembership.findUnique.mockResolvedValue({
    id: "m-1",
    orgId: "org-1",
    org: { seatsPurchased: seats, subscriptionStatus: status },
  });
  db.orgMembership.findMany.mockResolvedValue([
    member("m-0", "OWNER", "2026-11-01T00:00:00Z"),
    member("m-1", "MEMBER", "2026-11-02T00:00:00Z"),
  ]);
}

describe("effectivePlan — TEAMS_ENABLED off (byte-identical)", () => {
  it("returns the user's own plan value unchanged, with no query", async () => {
    const { effectivePlan } = await import("../org/effective-tier.js");
    for (const plan of [...PLANS_UNDER_TEST, "nonsense", ""]) {
      expect(await effectivePlan({ id: "u-1", plan })).toBe(plan);
    }
    expect(db.orgMembership.findUnique).not.toHaveBeenCalled();
    expect(db.orgMembership.findMany).not.toHaveBeenCalled();
  });

  it("is ignored for a user outside the cohort", async () => {
    process.env.TEAMS_ENABLED = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = "someone-else";
    seatHeld();
    const { effectivePlan } = await import("../org/effective-tier.js");
    expect(await effectivePlan({ id: "u-1", plan: "FREE" })).toBe("FREE");
    expect(db.orgMembership.findUnique).not.toHaveBeenCalled();
  });

  it("gives every gate helper the same answer as the raw plan (paywall on)", async () => {
    process.env.PAYWALL_ENABLED = "true";
    vi.resetModules();
    const { effectivePlan } = await import("../org/effective-tier.js");
    const stripe = await import("../billing/stripe.js");
    const features = Object.keys(stripe.TOOL_FEATURE_MAP).map(
      (tool) => stripe.TOOL_FEATURE_MAP[tool],
    );
    const allFeatures = [
      ...new Set([
        ...features,
        "autonomous_agent",
        "agent_mode_auto",
        "daily_briefing",
        "email_auto_classify",
        "email_auto_reply",
        "pattern_learning",
        "multi_account",
      ]),
    ] as Parameters<typeof stripe.planHasFeature>[1][];
    for (const plan of PLANS_UNDER_TEST) {
      const resolved = await effectivePlan({ id: "u-1", plan });
      for (const role of ROLES_UNDER_TEST) {
        expect(stripe.isEntitled(resolved, role)).toBe(stripe.isEntitled(plan, role));
        expect(stripe.isHardPaywalled(resolved, role)).toBe(stripe.isHardPaywalled(plan, role));
        expect(stripe.getEffectivePlan(resolved, role)).toBe(stripe.getEffectivePlan(plan, role));
        for (const feature of allFeatures) {
          expect(stripe.planHasFeature(resolved, feature, role)).toBe(
            stripe.planHasFeature(plan, feature, role),
          );
        }
      }
    }
    expect(stripe.isEntitled("FREE", "USER")).toBe(false);
    expect(db.orgMembership.findUnique).not.toHaveBeenCalled();
  });
});

describe("effectivePlans (batch) — TEAMS_ENABLED off", () => {
  it("maps every user to their own plan with zero queries", async () => {
    const { effectivePlans } = await import("../org/effective-tier.js");
    const users = PLANS_UNDER_TEST.map((plan, i) => ({ id: `u-${i}`, plan }));
    const plans = await effectivePlans(users);
    expect([...plans.entries()]).toEqual(users.map((u) => [u.id, u.plan]));
    expect(db.orgMembership.findUnique).not.toHaveBeenCalled();
    expect(db.orgMembership.findMany).not.toHaveBeenCalled();
  });
});

describe("effectivePlan — TEAMS_ENABLED on", () => {
  beforeEach(() => {
    process.env.TEAMS_ENABLED = "on";
  });

  it("raises FREE and PRO to TEAM for a seat holder", async () => {
    seatHeld();
    const { effectivePlan } = await import("../org/effective-tier.js");
    expect(await effectivePlan({ id: "u-1", plan: "FREE" })).toBe("TEAM");
    expect(await effectivePlan({ id: "u-1", plan: "PRO" })).toBe("TEAM");
  });

  it("never lowers TEAM or ENTERPRISE and skips the lookup for them", async () => {
    seatHeld();
    const { effectivePlan } = await import("../org/effective-tier.js");
    expect(await effectivePlan({ id: "u-1", plan: "TEAM" })).toBe("TEAM");
    expect(await effectivePlan({ id: "u-1", plan: "ENTERPRISE" })).toBe("ENTERPRISE");
    expect(db.orgMembership.findUnique).not.toHaveBeenCalled();
  });

  it("keeps the own plan with no membership, a lapsed org, or no free seat", async () => {
    const { effectivePlan } = await import("../org/effective-tier.js");
    db.orgMembership.findUnique.mockResolvedValue(null);
    expect(await effectivePlan({ id: "u-1", plan: "PRO" })).toBe("PRO");
    seatHeld("past_due");
    expect(await effectivePlan({ id: "u-1", plan: "FREE" })).toBe("FREE");
    seatHeld("active", 1);
    expect(await effectivePlan({ id: "u-1", plan: "FREE" })).toBe("FREE");
  });

  it("names the held seat for the cost pool: org, seats, seated user ids", async () => {
    db.orgMembership.findUnique.mockResolvedValue({
      id: "m-1",
      orgId: "org-1",
      org: { seatsPurchased: 3, subscriptionStatus: "trialing" },
    });
    db.orgMembership.findMany.mockResolvedValue([
      { ...member("m-0", "OWNER", "2026-11-01T00:00:00Z"), userId: "u-0" },
      { ...member("m-1", "MEMBER", "2026-11-02T00:00:00Z"), userId: "u-1" },
      { ...member("m-2", "MEMBER", "2026-11-03T00:00:00Z"), userId: "u-2" },
      { ...member("m-3", "MEMBER", "2026-11-04T00:00:00Z"), userId: "u-3" },
    ]);
    const { heldTeamSeat } = await import("../org/effective-tier.js");
    expect(await heldTeamSeat("u-1")).toEqual({
      orgId: "org-1",
      seatsPurchased: 3,
      seatedUserIds: ["u-0", "u-1", "u-2"],
    });
  });
});

describe("effectivePlans (batch) — TEAMS_ENABLED on", () => {
  beforeEach(() => {
    process.env.TEAMS_ENABLED = "on";
  });

  it("resolves N users in at most two queries", async () => {
    db.orgMembership.findMany
      .mockResolvedValueOnce([
        {
          id: "m-1",
          userId: "u-1",
          orgId: "org-1",
          org: { seatsPurchased: 2, subscriptionStatus: "active" },
        },
        {
          id: "m-9",
          userId: "u-9",
          orgId: "org-1",
          org: { seatsPurchased: 2, subscriptionStatus: "active" },
        },
        {
          id: "m-5",
          userId: "u-5",
          orgId: "org-2",
          org: { seatsPurchased: 5, subscriptionStatus: "canceled" },
        },
      ])
      .mockResolvedValueOnce([
        member("m-0", "OWNER", "2026-11-01T00:00:00Z"),
        member("m-1", "MEMBER", "2026-11-02T00:00:00Z"),
        member("m-9", "MEMBER", "2026-11-09T00:00:00Z"),
      ]);
    const { effectivePlans } = await import("../org/effective-tier.js");
    const users = [
      { id: "u-1", plan: "FREE" },
      { id: "u-9", plan: "PRO" },
      { id: "u-5", plan: "FREE" },
      { id: "u-7", plan: "ENTERPRISE" },
      { id: "u-8", plan: "PRO" },
    ];
    const plans = await effectivePlans(users);
    expect(Object.fromEntries(plans)).toEqual({
      "u-1": "TEAM",
      "u-9": "PRO",
      "u-5": "FREE",
      "u-7": "ENTERPRISE",
      "u-8": "PRO",
    });
    expect(db.orgMembership.findMany).toHaveBeenCalledTimes(2);
    const firstWhere = db.orgMembership.findMany.mock.calls[0]?.[0]?.where;
    // ENTERPRISE cannot be raised, so it is not looked up.
    expect(firstWhere.userId.in).toEqual(["u-1", "u-9", "u-5", "u-8"]);
    const secondWhere = db.orgMembership.findMany.mock.calls[1]?.[0]?.where;
    expect(secondWhere.orgId.in).toEqual(["org-1"]);
    expect(db.orgMembership.findUnique).not.toHaveBeenCalled();
  });

  it("looks up only cohort users in cohort mode", async () => {
    process.env.TEAMS_ENABLED = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = "u-2";
    db.orgMembership.findMany.mockResolvedValueOnce([]);
    const { effectivePlans } = await import("../org/effective-tier.js");
    const plans = await effectivePlans([
      { id: "u-1", plan: "FREE" },
      { id: "u-2", plan: "FREE" },
    ]);
    expect(Object.fromEntries(plans)).toEqual({ "u-1": "FREE", "u-2": "FREE" });
    expect(db.orgMembership.findMany).toHaveBeenCalledTimes(1);
    expect(db.orgMembership.findMany.mock.calls[0]?.[0]?.where.userId.in).toEqual(["u-2"]);
  });
});

describe("total variants for non-gate paths (TEAMS_ENABLED on)", () => {
  beforeEach(() => {
    process.env.TEAMS_ENABLED = "on";
  });

  it("falls back to the own plan, reported, when the seat lookup fails", async () => {
    db.orgMembership.findUnique.mockRejectedValue(new Error("db down"));
    const { effectivePlan, effectivePlanOrOwn } = await import("../org/effective-tier.js");
    expect(await effectivePlanOrOwn({ id: "u-1", plan: "FREE" })).toBe("FREE");
    expect(captureError).toHaveBeenCalledTimes(1);
    // The strict resolver (access gates) still fails closed by throwing.
    await expect(effectivePlan({ id: "u-1", plan: "FREE" })).rejects.toThrow("db down");
  });

  it("keeps every scheduler user on their own plan when the batch lookup fails", async () => {
    db.orgMembership.findMany.mockRejectedValue(new Error("db down"));
    const { effectivePlansOrOwn } = await import("../org/effective-tier.js");
    const plans = await effectivePlansOrOwn([
      { id: "u-1", plan: "FREE" },
      { id: "u-2", plan: "PRO" },
    ]);
    expect(Object.fromEntries(plans)).toEqual({ "u-1": "FREE", "u-2": "PRO" });
    expect(captureError).toHaveBeenCalledTimes(1);
  });
});

describe("seatCoversPersonalPlan", () => {
  const live = {
    paddleSubscriptionId: "sub_1",
    subscriptionStatus: "active",
    subscriptionCancelAt: null,
  };

  it("is true only for a live, renewing personal Paddle Pro under a seat", async () => {
    const { seatCoversPersonalPlan } = await import("../org/effective-tier.js");
    expect(seatCoversPersonalPlan("PRO", "TEAM", live)).toBe(true);
    expect(seatCoversPersonalPlan("PRO", "TEAM", { ...live, subscriptionStatus: "trialing" })).toBe(
      true,
    );
  });

  it("stays false without a seat, a scheduled cancel, or a stored live subscription", async () => {
    const { seatCoversPersonalPlan } = await import("../org/effective-tier.js");
    expect(seatCoversPersonalPlan("PRO", "PRO", live)).toBe(false);
    expect(seatCoversPersonalPlan("FREE", "TEAM", live)).toBe(false);
    expect(
      seatCoversPersonalPlan("PRO", "TEAM", { ...live, subscriptionCancelAt: new Date() }),
    ).toBe(false);
    // A comped Pro, a Stripe customer or an IAP subscriber: no Paddle record.
    expect(seatCoversPersonalPlan("PRO", "TEAM", { ...live, paddleSubscriptionId: null })).toBe(
      false,
    );
    expect(seatCoversPersonalPlan("PRO", "TEAM", { ...live, subscriptionStatus: "past_due" })).toBe(
      false,
    );
  });
});
