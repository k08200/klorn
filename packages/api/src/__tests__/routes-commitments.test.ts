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
vi.mock("../judge/attention-mirror.js", () => ({
  upsertAttentionForCommitment: vi.fn(async () => undefined),
  deleteAttentionForCommitments: vi.fn(async () => undefined),
}));
vi.mock("../learning/feedback.js", () => ({ recordFeedback: vi.fn(async () => undefined) }));
vi.mock("../pim/commitment-completion.js", () => ({
  maybeRefreshCompletionSuggestions: vi.fn(async () => 0),
}));
vi.mock("../llm/openai.js", () => ({
  MODEL: "test-model",
  createCompletion: vi.fn(async () => ({ choices: [{ message: { content: "[]" } }] })),
}));

type CommitmentRow = {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  status: string;
  dueAt: Date | null;
  confidence?: number;
  confirmedAt?: Date | null;
};
type PathRow = { id: string; commitmentId: string; steps: unknown; builtAt: Date; model: string };
const commitments: CommitmentRow[] = [];
const paths: PathRow[] = [];
let nextId = 1;

/** True when `row` has every field of `where` (Prisma's equality filters). */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

vi.mock("../db.js", () => {
  const prisma = {
    commitment: {
      findMany: vi.fn(async ({ where }: { where: { userId: string; status?: string } }) =>
        commitments.filter(
          (c) => c.userId === where.userId && (!where.status || c.status === where.status),
        ),
      ),
      findUnique: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          commitments.find((c) => matches(c, where)) ?? null,
      ),
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          commitments.find((c) => matches(c, where)) ?? null,
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Partial<CommitmentRow>;
        }) => {
          const idx = commitments.findIndex((c) => matches(c, where));
          if (idx < 0) throw new Error("Not found");
          commitments[idx] = { ...(commitments[idx] as CommitmentRow), ...data };
          return commitments[idx];
        },
      ),
      delete: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const idx = commitments.findIndex((c) => matches(c, where));
        if (idx < 0) throw new Error("Not found");
        return commitments.splice(idx, 1)[0];
      }),
      deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const kept = commitments.filter((c) => !matches(c, where));
        const count = commitments.length - kept.length;
        commitments.splice(0, commitments.length, ...kept);
        return { count };
      }),
    },
    commitmentPath: {
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { commitmentId: string; commitment?: Record<string, unknown> };
        }) =>
          paths.find((p) => {
            if (p.commitmentId !== where.commitmentId) return false;
            const parent = commitments.find((c) => c.id === p.commitmentId);
            return !where.commitment || (parent !== undefined && matches(parent, where.commitment));
          }) ?? null,
      ),
      upsert: vi.fn(async () => {
        throw new Error("no path write expected");
      }),
      update: vi.fn(async () => {
        throw new Error("no path write expected");
      }),
    },
    task: {
      create: vi.fn(async () => {
        throw new Error("no task write expected");
      }),
    },
    attentionItem: {
      findFirst: vi.fn(async () => null),
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
  paths.length = 0;
  nextId = 1;
  vi.clearAllMocks();
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

  it("PATCH refuses an oversized title or description", async () => {
    const c = seed({ userId: "user-1", status: "OPEN" });
    const app = await buildApp();
    // `title: null` would be coerced to "" by ajv and blank the row — refused too.
    for (const payload of [
      { title: "x".repeat(501) },
      { description: "x".repeat(5001) },
      { title: null },
      { title: "" },
    ]) {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/commitments/${c.id}`,
        headers: auth(),
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it("says which rows are confirmed: ≥0.7 or the user's own Confirm", async () => {
    seed({ id: "suggested", confidence: 0.45 });
    seed({ id: "confirmed-by-user", confidence: 0.45, confirmedAt: new Date() });
    seed({ id: "confident", confidence: 0.8 });
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/commitments", headers: auth() });
    const byId = Object.fromEntries(
      res.json().commitments.map((c: { id: string; confirmed: boolean }) => [c.id, c.confirmed]),
    );
    expect(byId).toEqual({ suggested: false, "confirmed-by-user": true, confident: true });
    await app.close();
  });

  it("refreshes completion suggestions for the requesting user before listing open rows", async () => {
    const { maybeRefreshCompletionSuggestions: refreshCompletionSuggestions } = await import(
      "../pim/commitment-completion.js"
    );
    const app = await buildApp();
    await app.inject({ method: "GET", url: "/api/commitments?status=OPEN", headers: auth() });
    expect(vi.mocked(refreshCompletionSuggestions)).toHaveBeenCalledWith(
      "user-1",
      expect.any(Number),
    );
    vi.mocked(refreshCompletionSuggestions).mockClear();
    await app.inject({ method: "GET", url: "/api/commitments?status=DONE", headers: auth() });
    expect(vi.mocked(refreshCompletionSuggestions)).not.toHaveBeenCalled();
    await app.close();
  });

  it("PATCH confirmed:true stamps confirmedAt once and leaves the status alone", async () => {
    const c = seed({ userId: "user-1", status: "OPEN", confidence: 0.45 });
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/commitments/${c.id}`,
      headers: auth(),
      payload: { confirmed: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("OPEN");
    const first = commitments[0]?.confirmedAt;
    expect(first).toBeInstanceOf(Date);
    await app.inject({
      method: "PATCH",
      url: `/api/commitments/${c.id}`,
      headers: auth(),
      payload: { confirmed: true },
    });
    expect(commitments[0]?.confirmedAt).toBe(first);
    await app.close();
  });

  it("PATCH refuses confirmed:false (there is no un-confirm)", async () => {
    const c = seed({ userId: "user-1", status: "OPEN" });
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/commitments/${c.id}`,
      headers: auth(),
      payload: { confirmed: false },
    });
    expect(res.statusCode).toBe(400);
    expect(commitments[0]?.confirmedAt).toBeUndefined();
    await app.close();
  });

  it("PATCH confirmed:true on another user's commitment is refused and changes nothing", async () => {
    const c = seed({ userId: "user-1", status: "OPEN", confidence: 0.45 });
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/commitments/${c.id}`,
      headers: auth(OTHER),
      payload: { confirmed: true },
    });
    expect(res.statusCode).toBe(403);
    expect(commitments[0]?.confirmedAt).toBeUndefined();
    await app.close();
  });

  it("caps ?limit= so one request can't pull an unbounded list", async () => {
    const { prisma } = await import("../db.js");
    const findMany = vi.mocked(prisma.commitment.findMany);
    findMany.mockClear();
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/commitments?limit=1000000",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const take = (findMany.mock.calls.at(-1)?.[0] as { take?: number } | undefined)?.take;
    expect(take).toBeLessThanOrEqual(200);
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

describe("commitment routes — another user's commitment", () => {
  beforeEach(reset);

  const OWNER_ONLY = ["Owner-only title", "Owner-only description", "Owner-only step"];

  function seedOwned() {
    const c = seed({
      userId: "user-1",
      title: "Owner-only title",
      description: "Owner-only description",
      dueAt: new Date("2026-12-05T00:00:00.000Z"),
    });
    paths.push({
      id: "p-1",
      commitmentId: c.id,
      steps: [{ step: "Owner-only step", action: "write", dueIso: "2026-12-01T00:00:00.000Z" }],
      builtAt: new Date("2026-11-01T00:00:00.000Z"),
      model: "test-model",
    });
    return c;
  }

  const crossUserCalls = (id: string) => [
    { method: "GET" as const, url: `/api/commitments/${id}` },
    { method: "PATCH" as const, url: `/api/commitments/${id}`, payload: { status: "DONE" } },
    {
      method: "PATCH" as const,
      url: `/api/commitments/${id}`,
      payload: { title: "Taken over", description: null, dueAt: null, status: "DISMISSED" },
    },
    { method: "DELETE" as const, url: `/api/commitments/${id}` },
    { method: "GET" as const, url: `/api/commitments/${id}/path` },
    { method: "POST" as const, url: `/api/commitments/${id}/path/rebuild` },
    { method: "POST" as const, url: `/api/commitments/${id}/path/steps/0/materialize` },
    { method: "POST" as const, url: `/api/commitments/${id}/path/materialize-all` },
  ];

  it("refuses every route with 403, leaks none of the row, and writes nothing", async () => {
    const c = seedOwned();
    const before = JSON.stringify({ commitments, paths });
    const { prisma } = await import("../db.js");
    const { createCompletion } = await import("../llm/openai.js");
    const app = await buildApp();
    for (const call of crossUserCalls(c.id)) {
      const res = await app.inject({ ...call, headers: auth(OTHER) });
      expect(res.statusCode, `${call.method} ${call.url}`).toBe(403);
      for (const secret of OWNER_ONLY) expect(res.body).not.toContain(secret);
      expect(res.body).not.toContain(c.id);
    }
    expect(JSON.stringify({ commitments, paths })).toBe(before);
    expect(prisma.commitment.update).not.toHaveBeenCalled();
    expect(prisma.commitment.delete).not.toHaveBeenCalled();
    expect(prisma.commitment.deleteMany).not.toHaveBeenCalled();
    expect(prisma.commitmentPath.upsert).not.toHaveBeenCalled();
    expect(prisma.commitmentPath.update).not.toHaveBeenCalled();
    expect(prisma.task.create).not.toHaveBeenCalled();
    expect(createCompletion).not.toHaveBeenCalled();
    await app.close();
  });

  it("answers 404 for an id that does not exist, the same for every route", async () => {
    const app = await buildApp();
    for (const call of crossUserCalls("missing")) {
      const res = await app.inject({ ...call, headers: auth(OTHER) });
      expect(res.statusCode, `${call.method} ${call.url}`).toBe(404);
    }
    await app.close();
  });

  it("still serves the owner", async () => {
    const c = seedOwned();
    const app = await buildApp();
    const read = await app.inject({
      method: "GET",
      url: `/api/commitments/${c.id}`,
      headers: auth(),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().title).toBe("Owner-only title");
    const path = await app.inject({
      method: "GET",
      url: `/api/commitments/${c.id}/path`,
      headers: auth(),
    });
    expect(path.statusCode).toBe(200);
    expect(path.json().path.steps[0].step).toBe("Owner-only step");
    await app.close();
  });

  it("scopes the dismissal feedback lookup to the owner", async () => {
    const c = seed({ userId: "user-1", status: "OPEN" });
    const { prisma } = await import("../db.js");
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/commitments/${c.id}`,
      headers: auth(),
      payload: { status: "DISMISSED" },
    });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(prisma.attentionItem.findFirst).toHaveBeenCalled());
    expect(prisma.attentionItem.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", source: "COMMITMENT", sourceId: c.id },
      }),
    );
    await app.close();
  });
});
