/**
 * GET /api/email?window=today — Today's "Needs you now" window (founder
 * decision, 2026-10-23). Only Today sends it, for its PUSH block: the lane page
 * is narrowed to mail received within TODAY_PUSH_WINDOW_HOURS, so the block's
 * rows and its `total` (the header's Push count) are the same windowed set.
 * Without the parameter every lane page — Mail's lists — is unchanged.
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
  const prisma: Record<string, unknown> = {
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
    $executeRaw: vi.fn(async () => 0),
  };
  // The lane reads run inside withStatementTimeout's interactive transaction.
  prisma.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
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

/**
 * Answer the grouped page: the page carries the thread total on every row
 * (COUNT(*) OVER ()); the distinct count only answers a page past the end.
 */
function threadPage(rows: Array<{ id: string; threadCount: number }>, total = rows.length) {
  queryRaw.mockImplementation(async (sql: unknown) => {
    const text = (sql as { strings: string[] }).strings.join("?");
    return text.includes("COUNT(DISTINCT") ? [{ total }] : rows.map((row) => ({ ...row, total }));
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

const NOW = new Date("2026-10-23T12:00:00.000Z");

describe("GET /api/email?window=today", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("narrows the thread-grouped PUSH page to mail received in the last 72h", async () => {
    threadPage([{ id: "e1", threadCount: 1 }], 1);
    emailFindMany.mockResolvedValue([
      dbRow("e1", { receivedAt: new Date("2026-10-23T08:00:00Z") }),
    ]);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email?tier=PUSH&threads=1&window=today",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    // The header count and the block read the same number: the windowed thread total.
    expect(res.json().total).toBe(1);
    const [page] = rawCalls();
    expect(page.text).toContain(`AND e."receivedAt" >= ?`);
    const cutoff = page.values.find((value) => value instanceof Date) as Date;
    expect(cutoff.toISOString()).toBe("2026-10-20T12:00:00.000Z");
    expect(page.text).toContain(`a."tier" IN (`);
    await app.close();
  });

  it("narrows the ungrouped lane page the same way", async () => {
    queryRaw.mockResolvedValue([]);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email?tier=PUSH&window=today",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const calls = rawCalls();
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.text).toContain(`AND e."receivedAt" >= ?`);
    await app.close();
  });

  it("leaves Mail's lane pages unchanged when absent (no received-time predicate)", async () => {
    for (const url of [
      "/api/email?tier=PUSH&threads=1",
      "/api/email?tier=PUSH",
      "/api/email?tier=MEETING&threads=1",
      "/api/email?tier=ALL&threads=1",
    ]) {
      queryRaw.mockReset();
      threadPage([], 0);
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url, headers: auth() });
      expect(res.statusCode).toBe(200);
      for (const call of rawCalls()) expect(call.text).not.toContain(`"receivedAt" >=`);
      await app.close();
    }
  });

  it("refuses the window without a lane (it narrows a lane page, nothing else)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email?window=today",
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(emailFindMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses an unknown window value", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email?tier=PUSH&window=week",
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
