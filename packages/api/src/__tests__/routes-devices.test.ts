import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

vi.mock("../email.js", () => ({ sendVerificationEmail: vi.fn(), sendPasswordResetEmail: vi.fn() }));
vi.mock("../gmail.js", () => ({
  getAuthUrl: vi.fn(),
  getLoginAuthUrl: vi.fn(),
  getAuthedClient: vi.fn(),
  getGoogleUserInfo: vi.fn(),
  getOAuth2Client: vi.fn(),
}));

type Dev = {
  id: string;
  userId: string;
  deviceName: string;
  tokenHash: string;
  [k: string]: unknown;
};
const store = new Map<string, Dev>();
let nextId = 1;

vi.mock("../db.js", () => {
  const prisma = {
    user: { findUnique: vi.fn(async () => ({ id: "user-1", plan: "FREE", role: "USER" })) },
    device: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; tokenHash?: string } }) => {
        // tokenHash lookup = auth validation → always succeed
        if (where.tokenHash)
          return { id: "auth-device", userId: "user-1", tokenHash: where.tokenHash };
        return store.get(where.id || "") ?? null;
      }),
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) => {
        const r: Dev[] = [];
        for (const d of store.values()) if (d.userId === where.userId) r.push(d);
        return r;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => store.delete(where.id)),
      count: vi.fn(async () => store.size),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});

vi.mock("../billing/stripe.js", () => ({
  getEffectivePlan: vi.fn(() => ({ deviceLimit: 5, name: "FREE" })),
}));

const TOKEN = signToken({ userId: "user-1", email: "t@e.com" });
const auth = () => ({ authorization: `Bearer ${TOKEN}` });

async function buildApp() {
  const { deviceRoutes } = await import("../routes/devices.js");
  const app = Fastify();
  await app.register(deviceRoutes, { prefix: "/api/devices" });
  return app;
}

describe("devices routes", () => {
  beforeEach(() => {
    store.clear();
    nextId = 1;
    store.set("dev-1", { id: "dev-1", userId: "user-1", deviceName: "Chrome", tokenHash: "hash1" });
  });

  it("rejects unauthenticated with 401", async () => {
    const app = await buildApp();
    expect((await app.inject({ method: "GET", url: "/api/devices" })).statusCode).toBe(401);
    await app.close();
  });

  it("lists devices for authenticated user", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/devices", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().devices).toHaveLength(1);
    expect(res.json()).toHaveProperty("deviceLimit");
    await app.close();
  });

  it("deletes own device", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: "/api/devices/dev-1", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    await app.close();
  });

  it("returns 404 for other user's device", async () => {
    store.set("dev-2", {
      id: "dev-2",
      userId: "user-2",
      deviceName: "Firefox",
      tokenHash: "hash2",
    });
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: "/api/devices/dev-2", headers: auth() });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
