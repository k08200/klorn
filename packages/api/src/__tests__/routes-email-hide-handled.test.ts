/**
 * GET /api/email?hideHandled=1 — an OPT-IN list that leaves out mail whose
 * attention item the user already handled: DISMISSED (Done), or SNOOZED
 * (Later) with a wake-up time still in the future. Without the param the list
 * is byte-for-byte what it was (the web and Mac clients never send it), so
 * Done on one device can disappear from another only for a client that asks.
 *
 * The exclusion is one NOT EXISTS over the user's own AttentionItem rows inside
 * the page query and the total query — two queries per page however many rows
 * it holds, never one per email — and the SQL text and bound values are pinned
 * here (the same SQL was run against a real Postgres in the PR's test plan).
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

vi.mock("../db.js", () => {
  const prisma = {
    userToken: { findFirst: userTokenFindFirst },
    emailMessage: { findMany: emailFindMany, count: emailCount },
    attentionItem: { findMany: attentionFindMany },
    linkedInboxAccount: { findFirst: linkedInboxFindFirst },
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

const GOOGLE_TOKEN = {
  id: "token-1",
  userId: "user-1",
  provider: "google",
  accessToken: "token",
  refreshToken: null,
  expiresAt: null,
  gmailWatchHistoryId: null,
  gmailWatchExpiresAt: null,
  createdAt: new Date("2026-05-03T00:00:00.000Z"),
  updatedAt: new Date("2026-05-03T00:00:00.000Z"),
};

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
    needsReplyReason: null,
    needsReplyConfidence: null,
    receivedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  userTokenFindFirst.mockReset();
  userTokenFindFirst.mockResolvedValue(null);
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
});

afterEach(() => {
  delete process.env.MAIL_V2;
  delete process.env.UNIFIED_HOME;
});

interface RawCall {
  text: string;
  values: unknown[];
}

/** Every $queryRaw call as its SQL text (placeholders as `?`) and bound values. */
function rawCalls(): RawCall[] {
  return queryRaw.mock.calls.map(([sql]) => {
    const { strings, values } = sql as { strings: string[]; values: unknown[] };
    return { text: strings.join("?").replace(/\s+/g, " "), values };
  });
}

/** Answer the lane page's two queries: the id page, then the total. */
function lanePage(ids: string[], total = ids.length) {
  queryRaw.mockImplementation(async (sql: unknown) => {
    const text = (sql as { strings: string[] }).strings.join("?");
    return text.includes("COUNT(*)") ? [{ total }] : ids.map((id) => ({ id }));
  });
}

const pageQuery = () => rawCalls().find((call) => !call.text.includes("COUNT(*)")) as RawCall;
const totalQuery = () => rawCalls().find((call) => call.text.includes("COUNT(*)")) as RawCall;

function listWhere() {
  return (emailFindMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;
}

const HANDLED = `NOT EXISTS ( SELECT 1 FROM "AttentionItem" h WHERE h."sourceId" = e."id" AND h."userId" = e."userId" AND h."source" = 'EMAIL' AND ( h."status" = 'DISMISSED' OR (h."status" = 'SNOOZED' AND h."snoozedUntil" > (now() AT TIME ZONE 'UTC')) ) )`;

describe("GET /api/email — default unchanged", () => {
  it("without hideHandled the list is the Prisma list it always was, with no handled filter", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    const app = await buildApp();
    for (const query of ["", "?hideHandled=0", "?hideHandled=false"]) {
      const res = await app.inject({ method: "GET", url: `/api/email${query}`, headers: auth() });
      expect(res.statusCode).toBe(200);
    }
    expect(queryRaw).not.toHaveBeenCalled();
    for (const [args] of emailFindMany.mock.calls) {
      expect((args as { where: Record<string, unknown> }).where).toEqual({ userId: "user-1" });
      expect((args as { orderBy: unknown }).orderBy).toEqual({ receivedAt: "desc" });
    }
    await app.close();
  });

  it("an unknown hideHandled value is refused, never guessed", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email?hideHandled=yes-please",
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
    expect(emailFindMany).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
    await app.close();
  });

  it("is behind auth like the rest of the list", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email?hideHandled=1" });
    expect(res.statusCode).toBe(401);
    expect(queryRaw).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("GET /api/email?hideHandled=1", () => {
  it.each([
    "1",
    "true",
  ])("hideHandled=%s pages by one user-scoped query with the handled exclusion", async (value) => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    lanePage(["e2", "e1"], 42);
    emailFindMany.mockResolvedValue([dbRow("e1"), dbRow("e2")]);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/email?hideHandled=${value}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.emails.map((e: { id: string }) => e.id)).toEqual(["e2", "e1"]);
    expect(body.total).toBe(42);

    const page = pageQuery();
    expect(page.text).toContain(`FROM "EmailMessage" e`);
    expect(page.text).toContain(`e."userId" = ?`);
    expect(page.text).toContain(HANDLED);
    expect(page.text).toContain(`ORDER BY e."receivedAt" DESC, e."id" DESC`);
    expect(page.values).toEqual(expect.arrayContaining(["user-1", 50, 0]));
    expect(page.text).not.toContain("user-1");
    // No lane join for the All view.
    expect(page.text).not.toContain(`JOIN "AttentionItem" a`);
    // The total counts the same rows.
    expect(totalQuery().text).toContain(HANDLED);
    // Rows are read back by id, user-scoped.
    expect(listWhere()).toEqual({ userId: "user-1", id: { in: ["e2", "e1"] } });
    await app.close();
  });

  it("costs two queries for the page however many rows it holds (no N+1)", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    const ids = Array.from({ length: 50 }, (_, i) => `e${i}`);
    lanePage(ids, 500);
    emailFindMany.mockResolvedValue(ids.map((id) => dbRow(id)));
    const app = await buildApp();
    await app.inject({ method: "GET", url: "/api/email?hideHandled=1", headers: auth() });
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(emailFindMany).toHaveBeenCalledTimes(1);
    // The chip lookup is the one batched query it always was.
    expect(attentionFindMany).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("composes with the account scope, search and the legacy filters", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    linkedInboxFindFirst.mockResolvedValue({ id: "linked-1" });
    const app = await buildApp();
    await app.inject({
      method: "GET",
      url: "/api/email?hideHandled=1&inbox=linked-1&filter=unread&search=invoice&page=2",
      headers: auth(),
    });
    const page = pageQuery();
    expect(page.text).toContain(HANDLED);
    expect(page.text).toContain(`e."linkedInboxAccountId" = ?`);
    expect(page.text).toContain(`e."isRead" = false`);
    expect(page.text).toContain(`e."subject" ILIKE ?`);
    expect(page.values).toEqual(
      expect.arrayContaining(["user-1", "linked-1", "%invoice%", 50, 50]),
    );
    expect(linkedInboxFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "linked-1", userId: "user-1" } }),
    );
    await app.close();
  });

  it("an account that is not the caller's is an empty page and no mail query runs", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    linkedInboxFindFirst.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email?hideHandled=1&inbox=someone-elses",
      headers: auth(),
    });
    expect(res.json()).toMatchObject({ emails: [], total: 0 });
    expect(queryRaw).not.toHaveBeenCalled();
    expect(emailFindMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("composes with a lane when a lane reader is on (MAIL_V2)", async () => {
    process.env.MAIL_V2 = "true";
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    const app = await buildApp();
    await app.inject({ method: "GET", url: "/api/email?hideHandled=1&tier=PUSH", headers: auth() });
    const page = pageQuery();
    expect(page.text).toContain(`INNER JOIN "AttentionItem" a`);
    expect(page.text).toContain(HANDLED);
    expect(page.values).toEqual(expect.arrayContaining(["PUSH", "CALL"]));
    await app.close();
  });

  it("a lane page without hideHandled carries no handled exclusion (MAIL_V2 unchanged)", async () => {
    process.env.MAIL_V2 = "true";
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    const app = await buildApp();
    await app.inject({ method: "GET", url: "/api/email?tier=PUSH", headers: auth() });
    expect(pageQuery().text).not.toContain(`"AttentionItem" h`);
    await app.close();
  });

  it("candidates cannot be combined with hideHandled: refused rather than silently unfiltered", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email?hideHandled=1&filter=candidates",
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(emailFindMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("a failed query fails the request instead of returning the unfiltered list", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    queryRaw.mockRejectedValue(new Error("db down"));
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email?hideHandled=1",
      headers: auth(),
    });
    expect(res.statusCode).toBe(500);
    expect(emailFindMany).not.toHaveBeenCalled();
    await app.close();
  });
});
