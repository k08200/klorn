/**
 * GET /api/email — two additive pieces for the web detail pass:
 * - `threads=1` (opt-in, lane views only): one row per thread — its newest
 *   message in the view, carrying `threadCount` — and `total` counts threads.
 *   Without a lane in effect it is ignored and the list is exactly as before.
 * - `tierReason` on every row: the stored AttentionItem reason, resolved in the
 *   user's notification language, batched with the lane chip. A failed lookup
 *   is no chip and no reason, never a 500.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const userTokenFindFirst = vi.hoisted(() => vi.fn(async () => null as unknown));
const emailFindMany = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const emailCount = vi.hoisted(() => vi.fn(async () => 0));
const attentionFindMany = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const queryRaw = vi.hoisted(() => vi.fn(async (_sql: unknown) => [] as unknown[]));
const linkedInboxFindFirst = vi.hoisted(() => vi.fn(async () => null as unknown));
const automationConfigFindUnique = vi.hoisted(() => vi.fn(async () => null as unknown));

vi.mock("../db.js", () => {
  const prisma = {
    userToken: { findFirst: userTokenFindFirst },
    emailMessage: { findMany: emailFindMany, count: emailCount },
    attentionItem: { findMany: attentionFindMany },
    linkedInboxAccount: { findFirst: linkedInboxFindFirst },
    automationConfig: { findUnique: automationConfigFindUnique },
    $queryRaw: queryRaw,
    user: { findUnique: vi.fn(async () => ({ id: "user-1", plan: "FREE", role: "USER" })) },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../mail/email-attachments.js", () => ({
  summarizeEmailAttachmentsByEmail: vi.fn(async () => ({})),
  listCandidateProfilesByEmail: vi.fn(async () => ({})),
}));
vi.mock("../mail/email-candidate-intake.js", () => ({
  listCandidateIntakesByEmail: vi.fn(async () => ({})),
  syncCandidateIntakeForEmail: vi.fn(async () => null),
}));
vi.mock("../learning/trust-score.js", () => ({
  getTrustScoresBulk: vi.fn(async () => new Map()),
}));

const TOKEN = signToken({ userId: "user-1", email: "t@e.com" });
const auth = () => ({ authorization: `Bearer ${TOKEN}` });

async function buildApp() {
  const { emailRoutes } = await import("../routes/email.js");
  const app = Fastify();
  await app.register(emailRoutes, { prefix: "/api/email" });
  return app;
}

const GOOGLE_TOKEN = { id: "token-1", userId: "user-1", provider: "google" };

function dbRow(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    gmailId: `g-${id}`,
    threadId: `t-${id}`,
    linkedInboxAccountId: null,
    from: "Sender <sender@x.com>",
    to: "me@x.com",
    subject: "Subject",
    snippet: "snippet",
    labels: ["INBOX"],
    isRead: false,
    isStarred: false,
    priority: "NORMAL",
    category: null,
    summary: null,
    keyPoints: null,
    actionItems: null,
    sentiment: null,
    needsReply: false,
    receivedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

interface RawCall {
  text: string;
  values: unknown[];
}

function rawCalls(): RawCall[] {
  return queryRaw.mock.calls.map(([sql]) => {
    const { strings, values } = sql as { strings: string[]; values: unknown[] };
    return { text: strings.join("?").replace(/\s+/g, " "), values };
  });
}

/** Answer the grouped page's two queries: the thread page, then the thread total. */
function threadPage(rows: Array<{ id: string; threadCount: number }>, total = rows.length) {
  queryRaw.mockImplementation(async (sql: unknown) => {
    const text = (sql as { strings: string[] }).strings.join("?");
    return text.includes("COUNT(DISTINCT") ? [{ total }] : rows;
  });
}

beforeEach(() => {
  userTokenFindFirst.mockReset();
  userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
  emailFindMany.mockReset();
  emailFindMany.mockResolvedValue([]);
  emailCount.mockReset();
  emailCount.mockResolvedValue(0);
  attentionFindMany.mockReset();
  attentionFindMany.mockResolvedValue([]);
  queryRaw.mockReset();
  queryRaw.mockResolvedValue([]);
  linkedInboxFindFirst.mockReset();
  linkedInboxFindFirst.mockResolvedValue(null);
  automationConfigFindUnique.mockReset();
  automationConfigFindUnique.mockResolvedValue(null);
  process.env.MAIL_V2 = "true";
});

afterEach(() => {
  delete process.env.MAIL_V2;
});

describe("GET /api/email?threads=1", () => {
  it("with tier=QUEUE: one row per thread, newest message first, threadCount and a thread total", async () => {
    threadPage(
      [
        { id: "e9", threadCount: 3 },
        { id: "e4", threadCount: 1 },
      ],
      41,
    );
    emailFindMany.mockResolvedValue([dbRow("e4"), dbRow("e9")]);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email?tier=QUEUE&threads=1",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(
      body.emails.map((e: { id: string; threadCount: number }) => [e.id, e.threadCount]),
    ).toEqual([
      ["e9", 3],
      ["e4", 1],
    ]);
    expect(body.total).toBe(41);

    const [page, total] = rawCalls();
    expect(page.text).toContain("SELECT DISTINCT ON (");
    expect(page.text).toContain(
      `PARTITION BY (COALESCE(e."linkedInboxAccountId", '') || ':' || COALESCE(e."threadId", e."id"))`,
    );
    expect(page.text).toContain(
      `LEFT JOIN "AttentionItem" a ON a."sourceId" = e."id" AND a."userId" = e."userId"`,
    );
    expect(page.values).toEqual(expect.arrayContaining(["user-1", 50, 0]));
    expect(page.text).not.toContain("user-1");
    expect(total.text).toContain("COUNT(DISTINCT");
    // Rows are re-read by id, owner-scoped.
    expect(emailFindMany).toHaveBeenCalledWith({
      where: { userId: "user-1", id: { in: ["e9", "e4"] } },
    });
    await app.close();
  });

  it("with tier=ALL: pages through the SQL view (no lane join), not the Prisma list", async () => {
    threadPage([{ id: "e1", threadCount: 2 }], 1);
    emailFindMany.mockResolvedValue([dbRow("e1")]);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email?tier=ALL&threads=true&hideHandled=1",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    expect(res.json().emails[0].threadCount).toBe(2);
    const [page] = rawCalls();
    expect(page.text).toContain("DISTINCT ON");
    expect(page.text).not.toContain(`"AttentionItem" a`);
    expect(page.text).toContain(`h."status" = 'DISMISSED'`);
    // Only the unread badge count runs on Prisma; the total is the thread count.
    expect(emailCount).toHaveBeenCalledTimes(1);
    expect(emailCount).toHaveBeenCalledWith({ where: { userId: "user-1", isRead: false } });
    await app.close();
  });

  it("without a lane it is ignored: the unchanged Prisma list, no threadCount", async () => {
    emailFindMany.mockResolvedValue([dbRow("e1")]);
    emailCount.mockResolvedValue(1);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email?threads=1", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(emailFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" }, orderBy: { receivedAt: "desc" } }),
    );
    expect(res.json().emails[0]).not.toHaveProperty("threadCount");
    await app.close();
  });

  it("lane reads off (MAIL_V2 unset): tier and threads are both ignored", async () => {
    delete process.env.MAIL_V2;
    emailFindMany.mockResolvedValue([dbRow("e1")]);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email?tier=QUEUE&threads=1",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(res.json().emails[0]).not.toHaveProperty("threadCount");
    await app.close();
  });

  it("threads=0 with a lane is the ungrouped lane page", async () => {
    queryRaw.mockImplementation(async (sql: unknown) => {
      const text = (sql as { strings: string[] }).strings.join("?");
      return text.includes("COUNT(*)") ? [{ total: 1 }] : [{ id: "e1" }];
    });
    emailFindMany.mockResolvedValue([dbRow("e1")]);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email?tier=QUEUE&threads=0",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    for (const call of rawCalls()) expect(call.text).not.toContain("DISTINCT ON");
    expect(res.json().emails[0]).not.toHaveProperty("threadCount");
    await app.close();
  });

  it("an invalid value is a 400 from the schema", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email?tier=QUEUE&threads=yes",
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
    expect(queryRaw).not.toHaveBeenCalled();
    await app.close();
  });

  it("filter=candidates cannot be grouped (the SQL view cannot apply it)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email?tier=ALL&threads=1&filter=candidates",
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
    expect(queryRaw).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("GET /api/email — tierReason on every row", () => {
  it("a static key is localized to the notification language; free text passes through", async () => {
    emailFindMany.mockResolvedValue([dbRow("e1"), dbRow("e2"), dbRow("e3"), dbRow("e4")]);
    attentionFindMany.mockResolvedValue([
      { sourceId: "e1", tier: "QUEUE", tierReason: "action.awaitingApproval" },
      { sourceId: "e2", tier: "PUSH", tierReason: "Your manager asked for this by Friday" },
      { sourceId: "e3", tier: "INFO", tierReason: null },
    ]);
    automationConfigFindUnique.mockResolvedValue({ notificationLanguage: "ko" });
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email", headers: auth() });
    expect(res.statusCode).toBe(200);
    const byId = Object.fromEntries(
      res
        .json()
        .emails.map((e: { id: string; tier: string | null; tierReason: string | null }) => [
          e.id,
          [e.tier, e.tierReason],
        ]),
    );
    expect(byId).toEqual({
      e1: ["QUEUE", "승인을 기다리는 중"],
      e2: ["PUSH", "Your manager asked for this by Friday"],
      e3: ["INFO", null],
      e4: [null, null],
    });
    expect(attentionFindMany).toHaveBeenCalledTimes(1);
    expect(automationConfigFindUnique).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("no stored reason on the page: the language is never read", async () => {
    emailFindMany.mockResolvedValue([dbRow("e1")]);
    attentionFindMany.mockResolvedValue([{ sourceId: "e1", tier: "SILENT", tierReason: null }]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email", headers: auth() });
    expect(res.json().emails[0].tierReason).toBeNull();
    expect(automationConfigFindUnique).not.toHaveBeenCalled();
    await app.close();
  });

  it("a failed lane lookup is no chip and no reason, never a 500", async () => {
    emailFindMany.mockResolvedValue([dbRow("e1")]);
    attentionFindMany.mockRejectedValue(new Error("db down"));
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().emails[0].tier).toBeNull();
    expect(res.json().emails[0].tierReason).toBeNull();
    await app.close();
  });

  it("a failed language read falls back to English, never a 500", async () => {
    emailFindMany.mockResolvedValue([dbRow("e1")]);
    attentionFindMany.mockResolvedValue([
      { sourceId: "e1", tier: "QUEUE", tierReason: "action.awaitingApproval" },
    ]);
    automationConfigFindUnique.mockRejectedValue(new Error("db down"));
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().emails[0].tierReason).toBe("Awaiting your approval");
    await app.close();
  });

  it("grouped rows carry the reason too", async () => {
    threadPage([{ id: "e1", threadCount: 2 }]);
    emailFindMany.mockResolvedValue([dbRow("e1")]);
    attentionFindMany.mockResolvedValue([
      { sourceId: "e1", tier: "PUSH", tierReason: "Deadline today" },
    ]);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email?tier=PUSH&threads=1",
      headers: auth(),
    });
    expect(res.json().emails[0]).toMatchObject({
      tier: "PUSH",
      tierReason: "Deadline today",
      threadCount: 2,
    });
    await app.close();
  });
});
