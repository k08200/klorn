import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Founder decision 2026-11-07: a FREE account keeps up to 3 signed-in devices,
 * the same as Pro. Every login registers a device; with the old limit of 1, a
 * FREE user signing in on the Mac app logged their web session out (and the
 * upgrade link-out to web /billing logged the Mac app out). Past the limit the
 * OLDEST session is the one removed.
 */

const state: { plan: string; sessions: string[]; created: number } = {
  plan: "FREE",
  sessions: [],
  created: 0,
};

vi.mock("../db.js", () => {
  const device = {
    create: vi.fn(async () => {
      state.created += 1;
      const id = `d${state.created}`;
      state.sessions = [id, ...state.sessions]; // newest first, like createdAt desc
      return { id };
    }),
    findMany: vi.fn(async () => state.sessions.map((id) => ({ id }))),
    deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
      state.sessions = state.sessions.filter((id) => !where.id.in.includes(id));
      return { count: where.id.in.length };
    }),
  };
  const user = { findUnique: vi.fn(async () => ({ plan: state.plan, role: "USER" })) };
  const prisma = { device, user };
  return { prisma, db: prisma };
});

const { registerDevice, signToken } = await import("../auth.js");

async function login(n: number) {
  for (let i = 0; i < n; i += 1) {
    await registerDevice("u-1", signToken({ userId: "u-1", email: "u@example.com" }), {});
  }
}

describe("registerDevice — signed-in device limit", () => {
  beforeEach(() => {
    state.sessions = [];
    state.created = 0;
  });

  it("lets a FREE user stay signed in on web, Mac and phone at once", async () => {
    state.plan = "FREE";
    await login(3);
    expect(state.sessions).toEqual(["d3", "d2", "d1"]);
  });

  it("removes only the oldest session when a FREE user signs in on a 4th device", async () => {
    state.plan = "FREE";
    await login(4);
    expect(state.sessions).toEqual(["d4", "d3", "d2"]);
  });

  it("gives Pro the same 3 sessions", async () => {
    state.plan = "PRO";
    await login(4);
    expect(state.sessions).toEqual(["d4", "d3", "d2"]);
  });
});
