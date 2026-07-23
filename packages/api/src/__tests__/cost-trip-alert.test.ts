/**
 * Cost-cap trip visibility.
 *
 * Before this module existed, tripping the global $10/day ceiling silently
 * degraded the judge to keyword-fallback — PUSH died with zero founder or
 * user signal. A trip must now: console.error + Sentry captureError, and
 * create a once-per-day deduped Notification row for every ADMIN user
 * (same P2002 winner-only idiom as ensureDailyBriefingNotification).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const createdNotifications = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const createBehavior = vi.hoisted(() => ({ failWith: null as unknown }));
const adminUsers = vi.hoisted(() => [{ id: "admin-1" }, { id: "admin-2" }]);

vi.mock("../db.js", () => ({
  prisma: {
    user: {
      findMany: vi.fn(async () => adminUsers),
    },
    notification: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        if (createBehavior.failWith) throw createBehavior.failWith;
        createdNotifications.push(args.data);
        return { id: `n-${createdNotifications.length}`, createdAt: new Date() };
      }),
    },
  },
}));

const capturedErrors = vi.hoisted(() => [] as unknown[]);
vi.mock("../sentry.js", () => ({
  captureError: vi.fn((err: unknown) => {
    capturedErrors.push(err);
  }),
}));

afterEach(() => {
  createdNotifications.length = 0;
  capturedErrors.length = 0;
  createBehavior.failWith = null;
  vi.restoreAllMocks();
});

async function freshModule() {
  vi.resetModules();
  return import("../billing/cost-trip-alert.js");
}

describe("notifyCostCapTrip — global ceiling", () => {
  it("logs, captures to Sentry, and creates one deduped Notification per ADMIN", async () => {
    const { notifyCostCapTrip } = await freshModule();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await notifyCostCapTrip({ scope: "global", usedCents: 1000.25, capCents: 1000 });

    expect(errorSpy).toHaveBeenCalled();
    expect(capturedErrors).toHaveLength(1);
    expect(createdNotifications).toHaveLength(2);
    const dayKey = new Date().toISOString().slice(0, 10);
    for (const data of createdNotifications) {
      expect(data.dedupeKey).toBe(`cost-cap-trip:global:${dayKey}`);
    }
    expect(createdNotifications.map((d) => d.userId).sort()).toEqual(["admin-1", "admin-2"]);
  });

  it("dedupes to one alert per day (second trip is a no-op)", async () => {
    const { notifyCostCapTrip } = await freshModule();
    vi.spyOn(console, "error").mockImplementation(() => {});

    await notifyCostCapTrip({ scope: "global", usedCents: 1000, capCents: 1000 });
    await notifyCostCapTrip({ scope: "global", usedCents: 1200, capCents: 1000 });

    expect(capturedErrors).toHaveLength(1);
    expect(createdNotifications).toHaveLength(2); // 2 admins × 1 trip, not ×2
  });

  it("swallows P2002 duplicates (another instance already won the create)", async () => {
    const { notifyCostCapTrip } = await freshModule();
    vi.spyOn(console, "error").mockImplementation(() => {});
    createBehavior.failWith = Object.assign(new Error("unique"), { code: "P2002" });

    await expect(
      notifyCostCapTrip({ scope: "global", usedCents: 1000, capCents: 1000 }),
    ).resolves.toBeUndefined();
  });

  it("never throws on a DB failure (alerting must not break the call path)", async () => {
    const { notifyCostCapTrip } = await freshModule();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    createBehavior.failWith = new Error("db down");

    await expect(
      notifyCostCapTrip({ scope: "global", usedCents: 1000, capCents: 1000 }),
    ).resolves.toBeUndefined();
  });
});

describe("notifyCostCapTrip — per-user cap", () => {
  it("dedupes per user per day and uses a user-scoped dedupeKey", async () => {
    const { notifyCostCapTrip } = await freshModule();
    vi.spyOn(console, "error").mockImplementation(() => {});

    await notifyCostCapTrip({ scope: "user", userId: "u1", usedCents: 101, capCents: 100 });
    await notifyCostCapTrip({ scope: "user", userId: "u1", usedCents: 105, capCents: 100 });
    await notifyCostCapTrip({ scope: "user", userId: "u2", usedCents: 11, capCents: 10 });

    // 2 admins × 2 distinct tripped users
    expect(createdNotifications).toHaveLength(4);
    const dayKey = new Date().toISOString().slice(0, 10);
    const keys = new Set(createdNotifications.map((d) => d.dedupeKey));
    expect(keys).toEqual(
      new Set([`cost-cap-trip:user:u1:${dayKey}`, `cost-cap-trip:user:u2:${dayKey}`]),
    );
  });

  it("ignores a user trip without a userId", async () => {
    const { notifyCostCapTrip } = await freshModule();
    await notifyCostCapTrip({ scope: "user", usedCents: 101, capCents: 100 });
    expect(createdNotifications).toHaveLength(0);
  });
});

describe("getCostTripSnapshot — admin surface (/api/admin/flags)", () => {
  it("starts clean and reflects trips for today", async () => {
    const { getCostTripSnapshot, notifyCostCapTrip } = await freshModule();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const before = getCostTripSnapshot();
    expect(before.globalTrippedToday).toBe(false);
    expect(before.userTrippedToday).toEqual([]);

    await notifyCostCapTrip({ scope: "global", usedCents: 1000, capCents: 1000 });
    await notifyCostCapTrip({ scope: "user", userId: "u1", usedCents: 11, capCents: 10 });

    const after = getCostTripSnapshot();
    expect(after.globalTrippedToday).toBe(true);
    expect(after.userTrippedToday).toEqual(["u1"]);
    expect(after.dayKey).toBe(new Date().toISOString().slice(0, 10));
  });
});
