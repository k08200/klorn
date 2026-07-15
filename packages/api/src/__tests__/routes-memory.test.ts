import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

vi.mock("../mail/email.js", () => ({
  sendVerificationEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
}));
vi.mock("../mail/gmail.js", () => ({
  getAuthUrl: vi.fn(),
  getLoginAuthUrl: vi.fn(),
  getAuthedClient: vi.fn(),
  getGoogleUserInfo: vi.fn(),
  getOAuth2Client: vi.fn(),
}));

type Mem = {
  id: string;
  userId: string;
  type: string;
  key: string;
  content: string;
  updatedAt: Date;
  [k: string]: unknown;
};
const store = new Map<string, Mem>();
let nextId = 1;

vi.mock("../db.js", () => {
  const db = {
    memory: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const r: Mem[] = [];
        for (const m of store.values()) if (m.userId === where.userId) r.push(m);
        return r;
      }),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => store.get(where.id) ?? null,
      ),
      upsert: vi.fn(
        async ({
          create,
        }: {
          where: unknown;
          create: Record<string, unknown>;
          update: unknown;
        }) => {
          const id = `mem-${nextId++}`;
          const mem = { id, ...create, updatedAt: new Date() } as Mem;
          store.set(id, mem);
          return mem;
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => store.delete(where.id)),
      groupBy: vi.fn(async () => [{ type: "preference", _count: store.size }]),
    },
  };
  const device = {
    findUnique: vi.fn(async () => ({ id: "d1" })),
    findMany: vi.fn(async () => []),
    count: vi.fn(async () => 1),
    update: vi.fn(async () => ({})),
  };
  const prisma = {
    ...db,
    user: { findUnique: vi.fn(async () => ({ id: "user-1", plan: "FREE", role: "USER" })) },
    device,
  };
  return { prisma, db: { ...db, device } };
});

const TOKEN = signToken({ userId: "user-1", email: "t@e.com" });
const OTHER = signToken({ userId: "user-2", email: "o@e.com" });
const auth = (t = TOKEN) => ({ authorization: `Bearer ${t}` });

async function buildApp() {
  const { memoryRoutes } = await import("../routes/memory.js");
  const app = Fastify();
  await app.register(memoryRoutes, { prefix: "/api/memories" });
  return app;
}

describe("memory routes", () => {
  beforeEach(() => {
    store.clear();
    nextId = 1;
  });

  it("rejects unauthenticated with 401", async () => {
    const app = await buildApp();
    expect((await app.inject({ method: "GET", url: "/api/memories" })).statusCode).toBe(401);
    await app.close();
  });

  it("creates and lists memories", async () => {
    const app = await buildApp();
    const c = await app.inject({
      method: "POST",
      url: "/api/memories",
      headers: auth(),
      payload: { type: "preference", key: "lang", content: "ko" },
    });
    expect(c.statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: "/api/memories", headers: auth() });
    expect(list.json().memories).toHaveLength(1);
    await app.close();
  });

  it("deletes own memory", async () => {
    const app = await buildApp();
    const c = await app.inject({
      method: "POST",
      url: "/api/memories",
      headers: auth(),
      payload: { type: "fact", key: "k", content: "v" },
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/memories/${c.json().id}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("returns 403 when deleting other user's memory", async () => {
    const app = await buildApp();
    const c = await app.inject({
      method: "POST",
      url: "/api/memories",
      headers: auth(),
      payload: { type: "fact", key: "k", content: "v" },
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/memories/${c.json().id}`,
      headers: auth(OTHER),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("gets memory stats", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/memories/stats", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("total");
    await app.close();
  });
});
