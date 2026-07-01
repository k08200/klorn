/**
 * Free-tier daily-limit nudge: when a FREE user's classify cycle is stopped by
 * the daily cost cap, drop at most one in-app upgrade nudge per UTC day.
 * Verifies plan gating (free only), the once-a-day dedup, paywall-off no-op,
 * and that a notification-write failure is caught (never breaks the tick).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  existing: null as { id: string } | null,
  created: [] as Array<Record<string, unknown>>,
  pushed: [] as Array<{ uid: string; payload: Record<string, unknown> }>,
  createThrows: false,
}));

vi.mock("../db.js", () => ({
  prisma: {
    notification: {
      findFirst: vi.fn(async () => state.existing),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (state.createThrows) throw new Error("db down");
        const row = { id: "notif-1", createdAt: new Date("2026-07-01T10:00:00Z"), ...data };
        state.created.push(row);
        return row;
      }),
    },
  },
}));
vi.mock("../websocket.js", () => ({
  pushNotification: vi.fn((uid: string, payload: Record<string, unknown>) => {
    state.pushed.push({ uid, payload });
  }),
}));
const captureError = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", () => ({ captureError }));

const ORIGINAL_PAYWALL = process.env.PAYWALL_ENABLED;

async function load(paywall: boolean) {
  if (paywall) process.env.PAYWALL_ENABLED = "true";
  else delete process.env.PAYWALL_ENABLED;
  vi.resetModules();
  return import("../automation-scheduler.js");
}

beforeEach(() => {
  state.existing = null;
  state.created.length = 0;
  state.pushed.length = 0;
  state.createThrows = false;
  captureError.mockReset();
});

afterEach(() => {
  if (ORIGINAL_PAYWALL === undefined) delete process.env.PAYWALL_ENABLED;
  else process.env.PAYWALL_ENABLED = ORIGINAL_PAYWALL;
  vi.resetModules();
});

describe("maybeNudgeFreeDailyLimit (paywall on)", () => {
  it("creates one upgrade nudge + pushes it for a FREE user with none today", async () => {
    const { maybeNudgeFreeDailyLimit } = await load(true);
    await maybeNudgeFreeDailyLimit("free-1", "FREE", "USER");
    expect(state.created).toHaveLength(1);
    expect(state.created[0]).toMatchObject({
      userId: "free-1",
      type: "reminder",
      title: "Daily free limit reached",
      link: "/settings",
    });
    expect(state.pushed).toHaveLength(1);
    expect(state.pushed[0].payload.link).toBe("/settings");
  });

  it("does not create a second nudge when one already exists today (dedup)", async () => {
    state.existing = { id: "already-today" };
    const { maybeNudgeFreeDailyLimit } = await load(true);
    await maybeNudgeFreeDailyLimit("free-1", "FREE", "USER");
    expect(state.created).toHaveLength(0);
    expect(state.pushed).toHaveLength(0);
  });

  it("no-ops for an entitled (PRO) user", async () => {
    const { maybeNudgeFreeDailyLimit } = await load(true);
    await maybeNudgeFreeDailyLimit("pro-1", "PRO", "USER");
    expect(state.created).toHaveLength(0);
  });

  it("no-ops for an ADMIN on FREE (comped)", async () => {
    const { maybeNudgeFreeDailyLimit } = await load(true);
    await maybeNudgeFreeDailyLimit("admin-1", "FREE", "ADMIN");
    expect(state.created).toHaveLength(0);
  });

  it("catches a notification-write failure instead of throwing (never breaks the tick)", async () => {
    state.createThrows = true;
    const { maybeNudgeFreeDailyLimit } = await load(true);
    await expect(maybeNudgeFreeDailyLimit("free-1", "FREE", "USER")).resolves.toBeUndefined();
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError.mock.calls[0][1].tags.scope).toBe("automation.free-limit-nudge");
  });
});

describe("maybeNudgeFreeDailyLimit (paywall off)", () => {
  it("no-ops for a FREE user — isEntitled is always true pre-launch", async () => {
    const { maybeNudgeFreeDailyLimit } = await load(false);
    await maybeNudgeFreeDailyLimit("free-1", "FREE", "USER");
    expect(state.created).toHaveLength(0);
  });
});
