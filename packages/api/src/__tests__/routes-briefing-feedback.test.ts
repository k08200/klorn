import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

vi.mock("../email.js", () => ({
  sendVerificationEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
}));
vi.mock("../gmail.js", () => ({
  listEmails: vi.fn(async () => ({ emails: [] })),
  getAuthUrl: vi.fn(),
  getLoginAuthUrl: vi.fn(),
  getAuthedClient: vi.fn(),
  getGoogleUserInfo: vi.fn(),
  getOAuth2Client: vi.fn(),
}));
vi.mock("../calendar.js", () => ({
  listEvents: vi.fn(async () => ({ events: [] })),
}));
vi.mock("../tasks.js", () => ({
  listTasks: vi.fn(async () => ({ tasks: [] })),
}));
vi.mock("../notes.js", () => ({
  listNotes: vi.fn(async () => ({ notes: [] })),
}));
vi.mock("../llm/openai.js", () => ({
  CHAT_SYSTEM_PROMPT: "system",
  MODEL: "test-model",
  openai: null,
  createCompletion: vi.fn(),
}));
vi.mock("../briefing-status.js", () => ({
  getBriefingStatus: vi.fn(async () => ({
    generated: false,
    note: null,
    push: { state: "not_sent", reason: null },
    automation: { configured: true, enabled: true, briefingTime: "09:00" },
  })),
}));

type NoteRow = {
  id: string;
  userId: string;
  title: string;
  content: string;
  createdAt: Date;
};

type FeedbackRow = {
  id: string;
  userId: string;
  source: string;
  sourceId: string;
  signal: string;
  toolName: string | null;
  recipient: string | null;
  threadId: string | null;
  evidence: string | null;
  createdAt: Date;
};

const store = vi.hoisted(() => ({
  notes: [] as NoteRow[],
  feedback: [] as FeedbackRow[],
  nextFeedbackId: 1,
}));

vi.mock("../db.js", () => ({
  prisma: {
    note: {
      create: vi.fn(({ data }: { data: { userId: string; title: string; content: string } }) => {
        const row = {
          id: `note-${store.notes.length + 1}`,
          userId: data.userId,
          title: data.title,
          content: data.content,
          createdAt: new Date("2026-05-03T09:00:00.000Z"),
        };
        store.notes.push(row);
        return { id: row.id, createdAt: row.createdAt };
      }),
      findFirst: vi.fn(
        ({
          where,
        }: {
          where: {
            id?: string;
            userId: string;
            title?: { startsWith: string };
            createdAt?: { gte: Date };
          };
        }) => {
          return (
            store.notes.find(
              (row) =>
                (!where.id || row.id === where.id) &&
                row.userId === where.userId &&
                (!where.title?.startsWith || row.title.startsWith(where.title.startsWith)) &&
                (!where.createdAt?.gte || row.createdAt >= where.createdAt.gte),
            ) ?? null
          );
        },
      ),
    },
    feedbackEvent: {
      create: vi.fn(
        ({
          data,
        }: {
          data: {
            userId: string;
            source: string;
            sourceId: string;
            signal: string;
            toolName?: string | null;
            recipient?: string | null;
            threadId?: string | null;
            evidence?: string | null;
          };
        }) => {
          const row = {
            id: `feedback-${store.nextFeedbackId++}`,
            userId: data.userId,
            source: data.source,
            sourceId: data.sourceId,
            signal: data.signal,
            toolName: data.toolName ?? null,
            recipient: data.recipient ?? null,
            threadId: data.threadId ?? null,
            evidence: data.evidence ?? null,
            createdAt: new Date(Date.now() + store.nextFeedbackId),
          };
          store.feedback.push(row);
          return row;
        },
      ),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { userId: string; source: string; toolName: string; sourceId: { in: string[] } };
        }) =>
          store.feedback
            .filter(
              (row) =>
                row.userId === where.userId &&
                row.source === where.source &&
                row.toolName === where.toolName &&
                where.sourceId.in.includes(row.sourceId),
            )
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      ),
      groupBy: vi.fn(({ where }: { where: { userId: string; createdAt: { gte: Date } } }) => {
        const counts = new Map<string, number>();
        for (const row of store.feedback) {
          if (row.userId !== where.userId || row.createdAt < where.createdAt.gte) continue;
          counts.set(row.signal, (counts.get(row.signal) ?? 0) + 1);
        }
        return Array.from(counts, ([signal, count]) => ({ signal, _count: { signal: count } }));
      }),
    },
    user: {
      findUnique: vi.fn(async () => ({ id: "user-1", plan: "FREE", role: "USER" })),
    },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      count: vi.fn(async () => 0),
      update: vi.fn(async () => ({})),
    },
  },
  db: {
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      count: vi.fn(async () => 0),
      update: vi.fn(async () => ({})),
    },
  },
}));

const TOKEN = signToken({ userId: "user-1", email: "test@example.com" });

function auth() {
  return { authorization: `Bearer ${TOKEN}` };
}

async function buildApp() {
  const { briefingRoutes } = await import("../briefing.js");
  const app = Fastify();
  await app.register(briefingRoutes, { prefix: "/api/briefing" });
  return app;
}

function resetStore() {
  store.notes.length = 0;
  store.feedback.length = 0;
  store.nextFeedbackId = 1;
  store.notes.push({
    id: "note-1",
    userId: "user-1",
    title: "Daily Briefing — 2026. 5. 3.",
    content: "오늘은 답장 1개가 있어요.\n\n**오늘의 Top 3**\n1. Sarah 답장하기 — 48시간 지남",
    createdAt: new Date("2026-05-03T09:00:00.000Z"),
  });
}

describe("briefing Top 3 feedback routes", () => {
  beforeEach(resetStore);

  it("records item-level feedback for a user's briefing", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/briefing/note-1/top-actions/1/feedback",
      headers: auth(),
      payload: { choice: "useful", label: "Sarah 답장하기" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().feedback).toMatchObject({
      noteId: "note-1",
      rank: 1,
      choice: "useful",
      signal: "APPROVED",
    });
    expect(store.feedback[0]).toMatchObject({
      userId: "user-1",
      source: "ATTENTION_ITEM",
      sourceId: "briefing:note-1:top:1",
      signal: "APPROVED",
      toolName: "briefing_top_action",
    });
    expect(JSON.parse(store.feedback[0]?.evidence ?? "{}")).toMatchObject({
      choice: "useful",
      rank: 1,
      label: "Sarah 답장하기",
    });
    await app.close();
  });

  it("rejects invalid ranks and choices", async () => {
    const app = await buildApp();
    const badRank = await app.inject({
      method: "POST",
      url: "/api/briefing/note-1/top-actions/4/feedback",
      headers: auth(),
      payload: { choice: "useful" },
    });
    const badChoice = await app.inject({
      method: "POST",
      url: "/api/briefing/note-1/top-actions/1/feedback",
      headers: auth(),
      payload: { choice: "maybe" },
    });

    expect(badRank.statusCode).toBe(400);
    expect(badChoice.statusCode).toBe(400);
    expect(store.feedback).toHaveLength(0);
    await app.close();
  });

  it("does not allow feedback on another user's briefing", async () => {
    store.notes[0].userId = "user-2";
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/briefing/note-1/top-actions/1/feedback",
      headers: auth(),
      payload: { choice: "useful" },
    });

    expect(res.statusCode).toBe(404);
    expect(store.feedback).toHaveLength(0);
    await app.close();
  });

  it("returns the latest feedback per Top 3 rank", async () => {
    store.feedback.push(
      {
        id: "old",
        userId: "user-1",
        source: "ATTENTION_ITEM",
        sourceId: "briefing:note-1:top:1",
        signal: "REJECTED",
        toolName: "briefing_top_action",
        recipient: null,
        threadId: null,
        evidence: null,
        createdAt: new Date("2026-05-03T09:01:00.000Z"),
      },
      {
        id: "fresh",
        userId: "user-1",
        source: "ATTENTION_ITEM",
        sourceId: "briefing:note-1:top:1",
        signal: "APPROVED",
        toolName: "briefing_top_action",
        recipient: null,
        threadId: null,
        evidence: null,
        createdAt: new Date("2026-05-03T09:02:00.000Z"),
      },
    );
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/briefing/note-1/top-actions/feedback",
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().feedback["1"]).toMatchObject({
      id: "fresh",
      rank: 1,
      choice: "useful",
    });
    await app.close();
  });
});
