/**
 * Briefing picks are measurable: GET /today returns them with the note, and
 * POST /:id/picks/:rank/open stamps the first time the user opened a pick's
 * mail from the briefing — once, on the caller's own note only.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const store = vi.hoisted(() => ({
  notes: [] as Array<{
    id: string;
    userId: string;
    title: string;
    content: string;
    createdAt: Date;
    picks: unknown;
  }>,
  updates: [] as Array<{ where: Record<string, unknown>; data: { picks: unknown } }>,
}));

vi.mock("../llm/openai.js", () => ({ MODEL: "test-model", createCompletion: vi.fn() }));
vi.mock("../pim/briefing-structure.js", () => ({
  buildBriefingStructure: vi.fn(async () => null),
}));
vi.mock("../db.js", () => {
  const matches = (
    row: (typeof store.notes)[number],
    where: { id?: string; userId?: string; title?: { startsWith: string } },
  ) =>
    (!where.id || row.id === where.id) &&
    (!where.userId || row.userId === where.userId) &&
    (!where.title || row.title.startsWith(where.title.startsWith));
  const prisma = {
    note: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, never> }) => {
        return store.notes.find((row) => matches(row, where)) ?? null;
      }),
      updateMany: vi.fn(
        async (args: { where: { id: string; userId: string }; data: { picks: unknown } }) => {
          store.updates.push(args);
          for (const row of store.notes) {
            if (matches(row, args.where)) row.picks = args.data.picks;
          }
          return { count: 1 };
        },
      ),
    },
    automationConfig: { findUnique: vi.fn(async () => ({ timezone: "UTC" })) },
    user: { findUnique: vi.fn(async () => ({ id: "user-1", plan: "FREE", role: "USER" })) },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      count: vi.fn(async () => 0),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});

const PICK = {
  rank: 1,
  emailId: "email-1",
  action: "Sign the contract",
  reason: "Sarah waits",
  quote: "by Friday",
  openedAt: null,
};

function auth(userId = "user-1") {
  return { authorization: `Bearer ${signToken({ userId, email: `${userId}@example.com` })}` };
}

async function buildApp() {
  const { briefingRoutes } = await import("../pim/briefing.js");
  const app = Fastify();
  await app.register(briefingRoutes, { prefix: "/api/briefing" });
  return app;
}

beforeEach(() => {
  store.updates = [];
  store.notes = [
    {
      id: "note-1",
      userId: "user-1",
      title: "Daily Briefing — 1/6/2099",
      content: "The contract shapes today.",
      createdAt: new Date(),
      picks: [PICK, { rank: 2, emailId: "malformed" }],
    },
  ];
});

describe("briefing picks routes", () => {
  it("GET /today returns the stored picks, malformed entries dropped", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/briefing/today", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().briefing.picks).toEqual([PICK]);
  });

  it("stamps the first open of a pick, and only the first", async () => {
    const app = await buildApp();
    const first = await app.inject({
      method: "POST",
      url: "/api/briefing/note-1/picks/1/open",
      headers: auth(),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ emailId: "email-1", first: true });
    expect(store.updates[0]?.where).toEqual({ id: "note-1", userId: "user-1" });

    const again = await app.inject({
      method: "POST",
      url: "/api/briefing/note-1/picks/1/open",
      headers: auth(),
    });
    expect(again.json()).toMatchObject({ first: false, openedAt: first.json().openedAt });
    expect(store.updates).toHaveLength(1);
  });

  it("404s for a rank without a pick and for another user's briefing", async () => {
    const app = await buildApp();
    const missing = await app.inject({
      method: "POST",
      url: "/api/briefing/note-1/picks/2/open",
      headers: auth(),
    });
    expect(missing.statusCode).toBe(404);
    const foreign = await app.inject({
      method: "POST",
      url: "/api/briefing/note-1/picks/1/open",
      headers: auth("user-2"),
    });
    expect(foreign.statusCode).toBe(404);
    expect(store.updates).toHaveLength(0);
  });

  it("400s for a rank outside 1-3", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/briefing/note-1/picks/9/open",
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
  });
});
