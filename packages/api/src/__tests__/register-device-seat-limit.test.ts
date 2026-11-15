/**
 * The device limit a Klorn Teams seat raises (PLANS.TEAM) evicts the oldest
 * sessions at sign-in. A failed seat lookup must never shrink that limit to
 * the own plan's and sign a seat holder out elsewhere: the sign-in proceeds,
 * the failure is reported, and nothing is evicted on that path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  orgMembership: { findUnique: vi.fn(), findMany: vi.fn() },
  device: { create: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
}));
const captureError = vi.hoisted(() => vi.fn());
vi.mock("../db.js", () => ({ prisma: db, db }));
vi.mock("../sentry.js", () => ({ captureError }));

const ORIGINAL_ENV = { ...process.env };
const tenDevices = Array.from({ length: 10 }, (_, i) => ({ id: `d-${i}` }));

beforeEach(() => {
  vi.resetAllMocks();
  db.user.findUnique.mockResolvedValue({ plan: "FREE", role: "USER" });
  db.device.create.mockResolvedValue({ id: "d-new" });
  db.device.findMany.mockResolvedValue(tenDevices);
  db.device.deleteMany.mockResolvedValue({ count: 0 });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("registerDevice and the seat's device limit", () => {
  it("evicts past the own plan's limit while TEAMS_ENABLED is off (unchanged)", async () => {
    delete process.env.TEAMS_ENABLED;
    const { registerDevice } = await import("../auth.js");
    await registerDevice("u-1", "tok", { deviceType: "web" });
    expect(db.orgMembership.findUnique).not.toHaveBeenCalled();
    const removed = db.device.deleteMany.mock.calls[0]?.[0]?.where.id.in;
    expect(removed).toEqual(tenDevices.slice(3).map((d) => d.id));
  });

  it("signs in but evicts nothing when the seat lookup fails", async () => {
    process.env.TEAMS_ENABLED = "on";
    db.orgMembership.findUnique.mockRejectedValue(new Error("db down"));
    const { registerDevice } = await import("../auth.js");
    expect(await registerDevice("u-1", "tok", { deviceType: "web" })).toBe("d-new");
    expect(db.device.deleteMany).not.toHaveBeenCalled();
    expect(captureError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { scope: "auth.device-limit.seat-lookup" } }),
    );
  });
});
