/**
 * BYOK on a Klorn Teams seat (llm-credentials.ts byokEntitled) runs on every
 * LLM call of a user whose own plan is not entitled. The seat lookup behind it
 * is cached for a short, bounded window: one membership read per window
 * instead of one per call, and a removed seat stops granting BYOK once the
 * window (SEAT_CACHE_TTL_MS, 30 s) has passed. While TEAMS_ENABLED is off it
 * reads no seat at all, as before.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  orgMembership: { findUnique: vi.fn(), findMany: vi.fn() },
}));
const captureError = vi.hoisted(() => vi.fn());
vi.mock("../db.js", () => ({ prisma: db, db }));
vi.mock("../sentry.js", () => ({ captureError }));
vi.mock("../crypto-tokens.js", () => ({
  decryptOptional: (v: string | null | undefined) => (v ? String(v).replace("cipher:", "") : null),
}));

const ORIGINAL_ENV = { ...process.env };
const T0 = Date.UTC(2026, 10, 17, 12, 0, 0);

const member = (id: string, userId: string, role: "OWNER" | "MEMBER", day: number) => ({
  id,
  userId,
  orgId: "org-1",
  role,
  joinedAt: new Date(Date.UTC(2026, 10, day)),
});

/** u-me holds one of org-1's two seats (the owner holds the other). */
function seatHeld() {
  db.orgMembership.findUnique.mockImplementation(async (args: { where: { userId: string } }) =>
    ["u-owner", "u-me"].includes(args.where.userId)
      ? {
          id: args.where.userId === "u-me" ? "m-me" : "m-owner",
          orgId: "org-1",
          org: { seatsPurchased: 2, subscriptionStatus: "active" },
        }
      : null,
  );
  db.orgMembership.findMany.mockResolvedValue([
    member("m-owner", "u-owner", "OWNER", 1),
    member("m-me", "u-me", "MEMBER", 2),
  ]);
}

async function credentials() {
  const { getUserLlmCredentials } = await import("../llm/llm-credentials.js");
  return getUserLlmCredentials;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  process.env.PAYWALL_ENABLED = "true";
  delete process.env.TEAMS_ENABLED;
  delete process.env.ROLLOUT_COHORT_USER_IDS;
  vi.resetModules();
  db.user.findUnique.mockResolvedValue({
    anthropicApiKey: "cipher:sk-ant-mine",
    geminiApiKey: null,
    chatModel: null,
    plan: "FREE",
    role: "USER",
  });
});

afterEach(() => {
  vi.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("BYOK on a seat — TEAMS_ENABLED off", () => {
  it("ignores a FREE user's key and reads no seat", async () => {
    seatHeld();
    const get = await credentials();
    expect(await get("u-me")).toEqual({ userModel: undefined });
    expect(db.orgMembership.findUnique).not.toHaveBeenCalled();
    expect(db.orgMembership.findMany).not.toHaveBeenCalled();
  });
});

describe("BYOK on a seat — TEAMS_ENABLED on", () => {
  beforeEach(() => {
    process.env.TEAMS_ENABLED = "on";
  });

  it("reads the seat once per window, not on every call", async () => {
    seatHeld();
    const get = await credentials();
    for (let i = 0; i < 20; i++) {
      expect(await get("u-me")).toMatchObject({
        anthropicApiKey: "sk-ant-mine",
        quotaScope: "u-me",
      });
    }
    expect(db.orgMembership.findUnique).toHaveBeenCalledTimes(1);
    expect(db.orgMembership.findMany).toHaveBeenCalledTimes(1);
  });

  it("stops granting BYOK once a removed seat's window has passed", async () => {
    seatHeld();
    const get = await credentials();
    expect(await get("u-me")).toMatchObject({ anthropicApiKey: "sk-ant-mine" });
    db.orgMembership.findUnique.mockResolvedValue(null);
    vi.setSystemTime(T0 + 29_999);
    expect(await get("u-me")).toMatchObject({ anthropicApiKey: "sk-ant-mine" });
    vi.setSystemTime(T0 + 30_000);
    expect(await get("u-me")).toEqual({ userModel: undefined });
  });

  it("treats a failed seat lookup as no seat, reported once per short window", async () => {
    db.orgMembership.findUnique.mockRejectedValue(new Error("db down"));
    const get = await credentials();
    expect(await get("u-me")).toEqual({ userModel: undefined });
    expect(await get("u-me")).toEqual({ userModel: undefined });
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { scope: "byok.seat-lookup" } }),
    );
  });

  it("skips the seat lookup for an own plan that is already entitled", async () => {
    seatHeld();
    db.user.findUnique.mockResolvedValue({
      anthropicApiKey: "cipher:sk-ant-mine",
      plan: "PRO",
      role: "USER",
    });
    const get = await credentials();
    expect(await get("u-me")).toMatchObject({ anthropicApiKey: "sk-ant-mine" });
    expect(db.orgMembership.findUnique).not.toHaveBeenCalled();
  });
});
