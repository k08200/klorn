import { beforeEach, describe, expect, it, vi } from "vitest";
import { PUSH_WINDOW_10MIN_MS } from "../config.js";

// DB-backed limiter: PushRingEvent rows are the source of truth so caps
// survive process restarts (Render deploys) and horizontal scaling. The
// mock distinguishes the two windows by the `gte` cutoff each count uses.
const NOW = new Date("2026-06-12T12:00:00.000Z");

const state = {
  in10: 0,
  in60: 0,
  countError: null as Error | null,
};
const countWheres: Array<{ userId: string; gte: Date }> = [];
const createCalls: Array<{ userId: string }> = [];
const deleteCalls: Array<{ userId: string; lt: Date }> = [];

vi.mock("../db.js", () => ({
  prisma: {
    pushRingEvent: {
      count: vi.fn(async (args: { where: { userId: string; createdAt: { gte: Date } } }) => {
        if (state.countError) throw state.countError;
        countWheres.push({ userId: args.where.userId, gte: args.where.createdAt.gte });
        const isTenMinWindow =
          args.where.createdAt.gte.getTime() === NOW.getTime() - PUSH_WINDOW_10MIN_MS;
        return isTenMinWindow ? state.in10 : state.in60;
      }),
      create: vi.fn(async (args: { data: { userId: string } }) => {
        createCalls.push({ userId: args.data.userId });
        return { id: "ring-1" };
      }),
      deleteMany: vi.fn(async (args: { where: { userId: string; createdAt: { lt: Date } } }) => {
        deleteCalls.push({ userId: args.where.userId, lt: args.where.createdAt.lt });
        return { count: 0 };
      }),
    },
  },
}));

async function loadLimiter() {
  return await import("../notify/push-rate-limit.js");
}

describe("push-rate-limit (DB-backed)", () => {
  beforeEach(() => {
    state.in10 = 0;
    state.in60 = 0;
    state.countError = null;
    countWheres.length = 0;
    createCalls.length = 0;
    deleteCalls.length = 0;
  });

  it("allows a push under both caps and records a ring event", async () => {
    const { recordPushAttempt } = await loadLimiter();
    const result = await recordPushAttempt("user-a", NOW);
    expect(result.allowed).toBe(true);
    expect(createCalls).toEqual([{ userId: "user-a" }]);
  });

  it("prunes rows older than the 60-minute window on allowed attempts", async () => {
    const { PUSH_WINDOW_60MIN_MS, recordPushAttempt } = await loadLimiter();
    await recordPushAttempt("user-a", NOW);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]?.userId).toBe("user-a");
    expect(deleteCalls[0]?.lt.getTime()).toBe(NOW.getTime() - PUSH_WINDOW_60MIN_MS);
  });

  it("blocks at the 10-minute cap without recording a ring event", async () => {
    const { PUSH_CAP_10MIN, recordPushAttempt } = await loadLimiter();
    state.in10 = PUSH_CAP_10MIN;
    state.in60 = PUSH_CAP_10MIN;
    const result = await recordPushAttempt("user-a", NOW);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("10min cap");
    expect(createCalls).toHaveLength(0);
  });

  it("blocks at the 60-minute cap even when the 10-minute window is clear", async () => {
    const { PUSH_CAP_60MIN, recordPushAttempt } = await loadLimiter();
    state.in10 = 0;
    state.in60 = PUSH_CAP_60MIN;
    const result = await recordPushAttempt("user-a", NOW);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("60min cap");
    expect(createCalls).toHaveLength(0);
  });

  it("scopes both window counts to the requesting user", async () => {
    const { recordPushAttempt } = await loadLimiter();
    await recordPushAttempt("user-a", NOW);
    expect(countWheres).toHaveLength(2);
    for (const where of countWheres) {
      expect(where.userId).toBe("user-a");
    }
  });

  it("fails open when the DB is unreachable (push must not die with the limiter)", async () => {
    const { recordPushAttempt } = await loadLimiter();
    state.countError = new Error("connection refused");
    const result = await recordPushAttempt("user-a", NOW);
    expect(result.allowed).toBe(true);
    expect(createCalls).toHaveLength(0);
  });
});
