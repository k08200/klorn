import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

vi.mock("../email.js", () => ({
  sendVerificationEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
}));
vi.mock("../gmail.js", () => ({
  getAuthUrl: vi.fn(),
  getLoginAuthUrl: vi.fn(),
  getAuthedClient: vi.fn(),
  getGoogleUserInfo: vi.fn(),
  getOAuth2Client: vi.fn(),
}));
vi.mock("../judge/attention-mirror.js", () => ({
  upsertAttentionForCommitment: vi.fn(async () => undefined),
  deleteAttentionForCommitments: vi.fn(async () => undefined),
}));

type CommitmentRow = {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  status: string;
  dueAt: Date | null;
};
const commitments: CommitmentRow[] = [];
let nextId = 1;

vi.mock("../db.js", () => {
  const prisma = {
    commitment: {
      findMany: vi.fn(async ({ where }: { where: { userId: string; status?: string } }) =>
        commitments.filter(
          (c) => c.userId === where.userId && (!where.status || c.status === where.status),
        ),
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          commitments.find((c) => c.id === where.id) ?? null,
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<CommitmentRow> }) => {
          const idx = commitments.findIndex((c) => c.id === where.id);
          if (idx < 0) throw new Error("Not found");
          commitments[idx] = { ...commitments[idx], ...data };
          return commitments[idx];
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const idx = commitments.findIndex((c) => c.id === where.id);
        if (idx >= 0) commitments.splice(idx, 1);
        return { id: where.id };
      }),
    },
    user: {
      findUnique: vi.fn(async () => ({ id: "user-1", plan: "FREE", role: "USER" })),
    },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});

const TOKEN = signToken({ userId: "user-1", email: "test@example.com" });
const OTHER = signToken({ userId: "user-2", email: "other@example.com" });

function auth(token = TOKEN) {
  return { authorization: `Bearer ${token}` };
}

async function buildApp() {
  const { commitmentRoutes } = await import("../routes/commitments.js");
  const app = Fastify();
  await app.register(commitmentRoutes, { prefix: "/api/commitments" });
  return app;
}

function reset() {
  commitments.length = 0;
  nextId = 1;
}

function seed(over: Partial<CommitmentRow> = {}): CommitmentRow {
  const row: CommitmentRow = {
    id: `c-${nextId++}`,
    userId: "user-1",
    title: "Send the deck",
    description: null,
    status: "OPEN",
    dueAt: null,
    ...over,
  };
  commitments.push(row);
  return row;
}

describe("commitment routes", () => {
  beforeEach(reset);

  it("rejects unauthenticated requests with 401", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/commitments" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("lists only the requesting user's commitments", async () => {
    seed({ id: "mine", userId: "user-1" });
    seed({ id: "theirs", userId: "user-2" });
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/commitments",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.commitments).toHaveLength(1);
    expect(body.commitments[0].id).toBe("mine");
    await app.close();
  });

  it("filters by status when ?status=DONE", async () => {
    seed({ id: "open", userId: "user-1", status: "OPEN" });
    seed({ id: "done", userId: "user-1", status: "DONE" });
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/commitments?status=DONE",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().commitments.map((c: { id: string }) => c.id)).toEqual(["done"]);
    await app.close();
  });

  it("returns 403 when another user reads our commitment", async () => {
    const c = seed({ userId: "user-1" });
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/commitments/${c.id}`,
      headers: auth(OTHER),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("PATCH updates status and ignores unknown fields", async () => {
    const c = seed({ userId: "user-1", status: "OPEN" });
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/commitments/${c.id}`,
      headers: auth(),
      payload: { status: "DONE", malicious: "ignored" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("DONE");
    await app.close();
  });

  it("PATCH rejects an unknown status string", async () => {
    const c = seed({ userId: "user-1", status: "OPEN" });
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/commitments/${c.id}`,
      headers: auth(),
      payload: { status: "BANANA" },
    });
    expect(res.statusCode).toBe(200);
    // Unknown status is silently dropped — row stays OPEN
    expect(res.json().status).toBe("OPEN");
    await app.close();
  });

  it("DELETE removes the commitment", async () => {
    const c = seed({ userId: "user-1" });
    const app = await buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/commitments/${c.id}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(204);
    expect(commitments).toHaveLength(0);
    await app.close();
  });
});
