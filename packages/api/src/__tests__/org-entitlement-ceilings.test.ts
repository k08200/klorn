/**
 * Klorn Teams v1 — seat entitlement derived at read time (never written to
 * User.plan) and the admin ceilings (auto-reply off, agent mode cap). The
 * gated helpers must not touch the database while TEAMS_ENABLED is off, so a
 * dark flag costs nothing on the scheduler paths that call them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  orgMembership: { findUnique: vi.fn(), findMany: vi.fn() },
  user: { update: vi.fn(), updateMany: vi.fn() },
}));
vi.mock("../db.js", () => ({ prisma: db, db }));

import { capAgentMode, normalizeAgentModeCap, orgCeilingsFor } from "../org/ceilings.js";
import {
  effectiveTier,
  higherTier,
  seatedMembershipIds,
  seatsActive,
} from "../org/effective-tier.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.TEAMS_ENABLED;
  delete process.env.ROLLOUT_COHORT_USER_IDS;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function membership(id: string, role: "OWNER" | "MEMBER", joinedAt: string) {
  return { id, role, joinedAt: new Date(joinedAt) };
}

describe("seat entitlement (derived from membership, read time)", () => {
  it("orders tiers FREE < PRO < TEAM < ENTERPRISE", () => {
    expect(higherTier("FREE", "TEAM")).toBe("TEAM");
    expect(higherTier("PRO", "TEAM")).toBe("TEAM");
    expect(higherTier("ENTERPRISE", "TEAM")).toBe("ENTERPRISE");
    expect(higherTier("TEAM", "FREE")).toBe("TEAM");
  });

  it("counts a subscription as seat-bearing only while active or trialing", () => {
    expect(seatsActive("active")).toBe(true);
    expect(seatsActive("trialing")).toBe(true);
    for (const status of ["past_due", "paused", "canceled", null, undefined, ""]) {
      expect(seatsActive(status)).toBe(false);
    }
  });

  it("seats the owner first, then members by join time, up to the purchased count", () => {
    const members = [
      membership("m-late", "MEMBER", "2026-11-03T00:00:00Z"),
      membership("m-early", "MEMBER", "2026-11-01T00:00:00Z"),
      membership("owner", "OWNER", "2026-11-02T00:00:00Z"),
    ];
    expect([...seatedMembershipIds(members, 2, "active")]).toEqual(["owner", "m-early"]);
    expect(seatedMembershipIds(members, 5, "active").size).toBe(3);
    expect(seatedMembershipIds(members, 5, "canceled").size).toBe(0);
    expect(seatedMembershipIds(members, 0, "active").size).toBe(0);
  });

  it("breaks a join-time tie by id, so the seat list is stable", () => {
    const at = "2026-11-01T00:00:00Z";
    const members = [membership("b", "MEMBER", at), membership("a", "MEMBER", at)];
    expect([...seatedMembershipIds(members, 1, "active")]).toEqual(["a"]);
  });

  it("returns the user's own plan without a query while TEAMS_ENABLED is off", async () => {
    expect(await effectiveTier({ id: "u1", plan: "PRO" })).toBe("PRO");
    expect(await effectiveTier({ id: "u1", plan: "nonsense" })).toBe("FREE");
    expect(db.orgMembership.findUnique).not.toHaveBeenCalled();
  });

  it("returns the user's own plan for someone outside the cohort", async () => {
    process.env.TEAMS_ENABLED = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = "someone-else";
    expect(await effectiveTier({ id: "u1", plan: "FREE" })).toBe("FREE");
    expect(db.orgMembership.findUnique).not.toHaveBeenCalled();
  });

  it("raises a seated member to TEAM and writes nothing to User.plan", async () => {
    process.env.TEAMS_ENABLED = "true";
    db.orgMembership.findUnique.mockResolvedValue({
      id: "mine",
      org: { seatsPurchased: 2, subscriptionStatus: "active" },
      orgId: "org-1",
    });
    db.orgMembership.findMany.mockResolvedValue([
      membership("owner", "OWNER", "2026-11-01T00:00:00Z"),
      membership("mine", "MEMBER", "2026-11-02T00:00:00Z"),
    ]);
    expect(await effectiveTier({ id: "u1", plan: "FREE" })).toBe("TEAM");
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  it("leaves a member past the purchased seats on their own plan", async () => {
    process.env.TEAMS_ENABLED = "true";
    db.orgMembership.findUnique.mockResolvedValue({
      id: "mine",
      org: { seatsPurchased: 1, subscriptionStatus: "active" },
      orgId: "org-1",
    });
    db.orgMembership.findMany.mockResolvedValue([
      membership("owner", "OWNER", "2026-11-01T00:00:00Z"),
      membership("mine", "MEMBER", "2026-11-02T00:00:00Z"),
    ]);
    expect(await effectiveTier({ id: "u1", plan: "FREE" })).toBe("FREE");
  });

  it("gives no seat when the subscription is not active, and none without a membership", async () => {
    process.env.TEAMS_ENABLED = "true";
    db.orgMembership.findUnique.mockResolvedValueOnce({
      id: "mine",
      org: { seatsPurchased: 10, subscriptionStatus: "past_due" },
      orgId: "org-1",
    });
    expect(await effectiveTier({ id: "u1", plan: "PRO" })).toBe("PRO");
    db.orgMembership.findUnique.mockResolvedValueOnce(null);
    expect(await effectiveTier({ id: "u1", plan: "FREE" })).toBe("FREE");
  });
});

describe("admin ceilings", () => {
  it("accepts only OFF, SHADOW and SUGGEST as an agent mode cap", () => {
    expect(normalizeAgentModeCap("OFF")).toBe("OFF");
    expect(normalizeAgentModeCap("SHADOW")).toBe("SHADOW");
    expect(normalizeAgentModeCap("SUGGEST")).toBe("SUGGEST");
    for (const value of ["AUTO", "ADMIN", "", null, undefined, 3, "suggest"]) {
      expect(normalizeAgentModeCap(value)).toBeNull();
    }
  });

  it("caps the configured agent mode at the org ceiling and never raises it", () => {
    expect(capAgentMode("AUTO", null)).toBe("AUTO");
    expect(capAgentMode("AUTO", "SUGGEST")).toBe("SUGGEST");
    expect(capAgentMode("AUTO", "SHADOW")).toBe("SHADOW");
    expect(capAgentMode("AUTO", "OFF")).toBe("OFF");
    expect(capAgentMode("SUGGEST", "SHADOW")).toBe("SHADOW");
    expect(capAgentMode("SHADOW", "SUGGEST")).toBe("SHADOW");
    expect(capAgentMode("SUGGEST", "OFF")).toBe("OFF");
  });

  it("applies no ceiling and reads nothing while TEAMS_ENABLED is off", async () => {
    expect(await orgCeilingsFor("u1")).toEqual({ autoReplyDisabled: false, agentModeCap: null });
    expect(db.orgMembership.findUnique).not.toHaveBeenCalled();
  });

  it("reads the member's org ceilings when the flag is open to them", async () => {
    process.env.TEAMS_ENABLED = "true";
    db.orgMembership.findUnique.mockResolvedValue({
      org: { autoReplyDisabled: true, agentModeCap: "SHADOW" },
    });
    expect(await orgCeilingsFor("u1")).toEqual({ autoReplyDisabled: true, agentModeCap: "SHADOW" });
  });

  it("treats a stored cap it does not know as no cap, and no membership as no ceiling", async () => {
    process.env.TEAMS_ENABLED = "true";
    db.orgMembership.findUnique.mockResolvedValueOnce({
      org: { autoReplyDisabled: false, agentModeCap: "AUTO" },
    });
    expect(await orgCeilingsFor("u1")).toEqual({ autoReplyDisabled: false, agentModeCap: null });
    db.orgMembership.findUnique.mockResolvedValueOnce(null);
    expect(await orgCeilingsFor("u1")).toEqual({ autoReplyDisabled: false, agentModeCap: null });
  });

  it("propagates a failed lookup instead of guessing that no ceiling applies", async () => {
    process.env.TEAMS_ENABLED = "true";
    db.orgMembership.findUnique.mockRejectedValue(new Error("db down"));
    await expect(orgCeilingsFor("u1")).rejects.toThrow("db down");
  });
});
