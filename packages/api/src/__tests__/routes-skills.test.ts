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

type SkillRow = {
  id: string;
  userId: string;
  key: string;
  name: string;
  description: string;
  prompt: string;
  createdAt: Date;
  updatedAt: Date;
};

const store = new Map<string, SkillRow>(); // composite "userId|key" → row

vi.mock("../db.js", () => {
  const skill = {
    findMany: vi.fn(
      async ({ where, orderBy: _orderBy }: { where: { userId: string }; orderBy?: unknown }) => {
        return Array.from(store.values())
          .filter((s) => s.userId === where.userId)
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      },
    ),
    findUnique: vi.fn(
      async ({ where }: { where: { userId_key: { userId: string; key: string } } }) => {
        return store.get(`${where.userId_key.userId}|${where.userId_key.key}`) ?? null;
      },
    ),
    upsert: vi.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: { userId_key: { userId: string; key: string } };
        create: Omit<SkillRow, "id" | "createdAt" | "updatedAt">;
        update: Partial<SkillRow>;
      }) => {
        const compositeKey = `${where.userId_key.userId}|${where.userId_key.key}`;
        const existing = store.get(compositeKey);
        const now = new Date();
        if (existing) {
          const updated = { ...existing, ...update, updatedAt: now };
          store.set(compositeKey, updated);
          return updated;
        }
        const created: SkillRow = {
          ...create,
          id: where.userId_key.key,
          createdAt: now,
          updatedAt: now,
        };
        store.set(compositeKey, created);
        return created;
      },
    ),
    deleteMany: vi.fn(async ({ where }: { where: { userId: string; key: string } }) => {
      const compositeKey = `${where.userId}|${where.key}`;
      const existed = store.delete(compositeKey);
      return { count: existed ? 1 : 0 };
    }),
  };
  const prismaMock = {
    skill,
    user: { findUnique: vi.fn(async () => ({ id: "user-1", plan: "FREE", role: "USER" })) },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma: prismaMock, db: prismaMock };
});

const TOKEN = signToken({ userId: "user-1", email: "t@e.com" });
const auth = () => ({ authorization: `Bearer ${TOKEN}` });

async function buildApp() {
  const { skillRoutes } = await import("../routes/skills.js");
  const app = Fastify();
  await app.register(skillRoutes, { prefix: "/api/skills" });
  return app;
}

describe("skills routes", () => {
  beforeEach(() => {
    store.clear();
  });

  it("rejects unauthenticated with 401", async () => {
    const app = await buildApp();
    expect((await app.inject({ method: "GET", url: "/api/skills" })).statusCode).toBe(401);
    await app.close();
  });

  it("creates and lists a skill", async () => {
    const app = await buildApp();
    const create = await app.inject({
      method: "POST",
      url: "/api/skills",
      headers: auth(),
      payload: {
        name: "Weekly Report",
        description: "Generate weekly summary",
        prompt: "Summarize this week's tasks and meetings",
      },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().name).toBe("Weekly Report");

    const list = await app.inject({ method: "GET", url: "/api/skills", headers: auth() });
    expect(list.json().skills).toHaveLength(1);
    await app.close();
  });

  it("rejects skill without name or prompt", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/skills",
      headers: auth(),
      payload: { name: "No Prompt" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("deletes a skill", async () => {
    const app = await buildApp();
    const create = await app.inject({
      method: "POST",
      url: "/api/skills",
      headers: auth(),
      payload: { name: "Temp", prompt: "temp prompt" },
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/skills/${create.json().id}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("executes a skill with variable substitution", async () => {
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/skills",
      headers: auth(),
      payload: { name: "Greet", prompt: "Say hello to {{name}}" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/skills/skill_greet/execute",
      headers: auth(),
      payload: { variables: { name: "Alice" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().prompt).toBe("Say hello to Alice");
    await app.close();
  });

  it("rejects a prompt over the length cap with 400", async () => {
    const { MAX_SKILL_PROMPT_LENGTH } = await import("../agentcore/skill-render.js");
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/skills",
      headers: auth(),
      payload: { name: "Huge", prompt: "a".repeat(MAX_SKILL_PROMPT_LENGTH + 1) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/at most/i);
    await app.close();
  });

  it("treats a regex-metacharacter variable key as a literal on execute (ReDoS-safe)", async () => {
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/skills",
      headers: auth(),
      payload: { name: "Redos", prompt: "x {{(a+)+}} y" },
    });
    const start = Date.now();
    const res = await app.inject({
      method: "POST",
      url: "/api/skills/skill_redos/execute",
      headers: auth(),
      payload: { variables: { "(a+)+": "Z" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().prompt).toBe("x Z y");
    expect(Date.now() - start).toBeLessThan(1000);
    await app.close();
  });
});
