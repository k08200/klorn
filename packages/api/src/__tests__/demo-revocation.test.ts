import { beforeEach, describe, expect, it, vi } from "vitest";

// Purpose-built db mock (the shared routes-auth mock hardcodes device.count,
// which would hide the already-revoked branch).
const state = {
  user: null as null | { id: string; sessionsInvalidatedAt: Date | null },
  deviceCount: 0,
  updated: null as null | { sessionsInvalidatedAt: Date },
  devicesDeleted: false,
};

vi.mock("../db.js", () => {
  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "demo-user" ? state.user : null,
      ),
      update: vi.fn(async ({ data }: { data: { sessionsInvalidatedAt: Date } }) => {
        state.updated = data;
        if (state.user) state.user.sessionsInvalidatedAt = data.sessionsInvalidatedAt;
        return state.user;
      }),
    },
    device: {
      count: vi.fn(async () => state.deviceCount),
      deleteMany: vi.fn(async () => {
        state.devicesDeleted = true;
        state.deviceCount = 0;
        return { count: 0 };
      }),
    },
  };
  return { prisma, db: prisma };
});

const { revokeDemoAccessIfDisabled } = await import("../auth.js");

function reset() {
  state.user = null;
  state.deviceCount = 0;
  state.updated = null;
  state.devicesDeleted = false;
  delete process.env.ENABLE_DEMO_USER; // demo access disabled (vitest NODE_ENV=test)
}

describe("revokeDemoAccessIfDisabled", () => {
  beforeEach(reset);

  it("is a no-op when demo access is enabled", async () => {
    process.env.ENABLE_DEMO_USER = "true";
    state.user = { id: "demo-user", sessionsInvalidatedAt: null };
    state.deviceCount = 3;
    await revokeDemoAccessIfDisabled();
    expect(state.updated).toBeNull();
    expect(state.devicesDeleted).toBe(false);
  });

  it("is a no-op when no demo row exists", async () => {
    state.user = null;
    await revokeDemoAccessIfDisabled();
    expect(state.updated).toBeNull();
    expect(state.devicesDeleted).toBe(false);
  });

  it("stamps the revocation epoch and drops devices for a seeded demo row", async () => {
    state.user = { id: "demo-user", sessionsInvalidatedAt: null };
    state.deviceCount = 2;
    await revokeDemoAccessIfDisabled();
    expect(state.updated?.sessionsInvalidatedAt).toBeInstanceOf(Date);
    expect(state.devicesDeleted).toBe(true);
  });

  it("is a no-op once already revoked with no devices (cheap on later boots)", async () => {
    state.user = { id: "demo-user", sessionsInvalidatedAt: new Date() };
    state.deviceCount = 0;
    await revokeDemoAccessIfDisabled();
    expect(state.updated).toBeNull();
    expect(state.devicesDeleted).toBe(false);
  });
});
