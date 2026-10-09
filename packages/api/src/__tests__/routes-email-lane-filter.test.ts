/**
 * Mail v2 (productization plan P5, MAIL_V2): the lane is Mail's primary
 * filter, so GET /api/email takes `tier` and GET /api/email/lane-counts feeds
 * the segmented control. A lane page is paged by a join (EmailMessage ⟕
 * AttentionItem), newest mail first, so its total is the number the control
 * shows; mail the judge has not reached yet reads as QUEUE in both. Both are
 * user-scoped and compose with the `inbox` account scope. With MAIL_V2 off the
 * list ignores `tier` (what it did before the param existed) and the counts
 * route answers 404. The same two queries are run against a real Postgres in
 * the PR's test plan; here the SQL text and its bound values are pinned.
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
  process.env.MAIL_V2 = "true";
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

describe("GET /api/email?tier= — lane page", () => {
  it("pages the lane by a user-scoped join, newest mail first, and keeps that order", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    lanePage(["e2", "e1"], 137);
    // The row fetch may answer in any order; the page order is the join's.
    emailFindMany.mockResolvedValue([dbRow("e1"), dbRow("e2")]);

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email?tier=PUSH", headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.emails.map((e: { id: string }) => e.id)).toEqual(["e2", "e1"]);
    // The total is the join's count — the same number the lane control shows.
    expect(body.total).toBe(137);

    const page = pageQuery();
    expect(page.text).toContain(`FROM "EmailMessage" e`);
    expect(page.text).toContain(`a."sourceId" = e."id" AND a."userId" = e."userId"`);
    expect(page.text).toContain(`a."source" = 'EMAIL'`);
    expect(page.text).toContain(`e."userId" = ?`);
    expect(page.text).toContain(`ORDER BY e."receivedAt" DESC`);
    expect(page.text).toMatch(/LIMIT \? OFFSET \?/);
    // CALL is a retired value that reads as PUSH, so it belongs to this lane.
    expect(page.values).toEqual(expect.arrayContaining(["user-1", "PUSH", "CALL", 50, 0]));
    // Bound, never interpolated.
    expect(page.text).not.toContain("user-1");
    // No id window: the lane is not cut off at some number of items.
    expect(attentionFindMany.mock.calls.every(([args]) => "select" in (args as object))).toBe(true);
    expect(listWhere()).toEqual({ userId: "user-1", id: { in: ["e2", "e1"] } });
    await app.close();
  });

  it("the total query uses the same join and predicate as the page", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    lanePage(["e1"]);
    emailFindMany.mockResolvedValue([dbRow("e1")]);
    const app = await buildApp();
    await app.inject({
      method: "GET",
      url: "/api/email?tier=INFO&inbox=primary&filter=unread&page=3",
      headers: auth(),
    });
    const fromOf = (text: string) => text.slice(text.indexOf("FROM"), text.indexOf("ORDER BY"));
    const total = totalQuery();
    expect(total.text.slice(total.text.indexOf("FROM")).trim()).toBe(
      fromOf(pageQuery().text).trim(),
    );
    // Page 3 of 50 skips 100.
    expect(pageQuery().values.slice(-2)).toEqual([50, 100]);
    await app.close();
  });

  it("QUEUE holds what reads as QUEUE — AUTO, null, unknown — and mail not judged yet", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    lanePage(["e1"]);
    emailFindMany.mockResolvedValue([dbRow("e1")]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email?tier=QUEUE", headers: auth() });
    const page = pageQuery();
    // LEFT JOIN: a mail with no AttentionItem row is still in the page.
    expect(page.text).toContain(`LEFT JOIN "AttentionItem" a`);
    expect(page.text).toContain(`a."id" IS NULL OR a."tier" IS NULL OR a."tier" NOT IN`);
    expect(page.values).toEqual(
      expect.arrayContaining(["PUSH", "CALL", "MEETING", "INFO", "SILENT"]),
    );
    // …and it carries no lane: the judge has not assigned one.
    expect(res.json().emails[0].tier).toBeNull();
    await app.close();
  });

  it("the other lanes are judged mail only", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    const app = await buildApp();
    for (const lane of ["PUSH", "MEETING", "INFO", "SILENT"]) {
      queryRaw.mockClear();
      await app.inject({ method: "GET", url: `/api/email?tier=${lane}`, headers: auth() });
      expect(pageQuery().text).toContain(`INNER JOIN "AttentionItem" a`);
      expect(pageQuery().text).not.toContain("IS NULL OR");
    }
    await app.close();
  });

  it("composes with the account scope and the legacy filters", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    linkedInboxFindFirst.mockResolvedValue({ id: "linked-1" });
    const app = await buildApp();
    const get = async (query: string) => {
      queryRaw.mockClear();
      await app.inject({ method: "GET", url: `/api/email?tier=QUEUE&${query}`, headers: auth() });
      return pageQuery();
    };

    const linked = await get("inbox=linked-1");
    expect(linked.text).toContain(`e."linkedInboxAccountId" = ?`);
    expect(linked.values).toContain("linked-1");
    expect(linkedInboxFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "linked-1", userId: "user-1" } }),
    );
    expect((await get("inbox=primary")).text).toContain(`e."linkedInboxAccountId" IS NULL`);
    expect((await get("filter=unread")).text).toContain(`e."isRead" = false`);
    expect((await get("filter=reply-needed")).text).toContain(`e."needsReply" = true`);
    expect((await get("filter=urgent")).text).toContain(`e."priority" = 'URGENT'`);
    expect((await get("filter=attachments")).text).toContain(
      `EXISTS (SELECT 1 FROM "EmailAttachment" x WHERE x."emailId" = e."id")`,
    );
    const category = await get("category=billing");
    expect(category.text).toContain(`e."category" = ?`);
    expect(category.values).toContain("billing");
    await app.close();
  });

  it("search is a bound, wildcard-escaped pattern over the same fields as the legacy search", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    const app = await buildApp();
    await app.inject({
      method: "GET",
      url: `/api/email?tier=QUEUE&search=${encodeURIComponent("50%_off\\")}`,
      headers: auth(),
    });
    const page = pageQuery();
    for (const column of ["subject", "from", "snippet", "body", "summary"]) {
      expect(page.text).toContain(`e."${column}" ILIKE ?`);
    }
    for (const column of ["filename", "summary", "contentText"]) {
      expect(page.text).toContain(`x."${column}" ILIKE ?`);
    }
    expect(page.values).toContain("%50\\%\\_off\\\\%");
    expect(page.text).not.toContain("50%");
    await app.close();
  });

  it("an account that is not the caller's is an empty page, and no mail query runs", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    linkedInboxFindFirst.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email?tier=QUEUE&inbox=someone-elses-inbox",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ emails: [], total: 0 });
    expect(queryRaw).not.toHaveBeenCalled();
    expect(emailFindMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("candidates cannot be narrowed by lane: refused rather than silently unfiltered", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email?tier=QUEUE&filter=candidates",
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
    expect(queryRaw).not.toHaveBeenCalled();
    await app.close();
  });

  it("an inherited object key is not a lane filter: refused, never interpolated", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    const app = await buildApp();
    for (const filter of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/email?tier=PUSH&filter=${filter}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(400);
    }
    expect(queryRaw).not.toHaveBeenCalled();
    await app.close();
  });

  it("ALL and an absent tier take the list path that existed before", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    const app = await buildApp();
    await app.inject({ method: "GET", url: "/api/email?tier=ALL", headers: auth() });
    await app.inject({ method: "GET", url: "/api/email", headers: auth() });
    expect(queryRaw).not.toHaveBeenCalled();
    for (const [args] of emailFindMany.mock.calls) {
      expect((args as { where: Record<string, unknown> }).where).toEqual({ userId: "user-1" });
    }
    // Mail v2's All view breaks a timestamp tie by id, like the lane pages and
    // the reader's previous / next; without `tier` the order is the legacy one.
    const orders = emailFindMany.mock.calls.map(([args]) => (args as { orderBy: unknown }).orderBy);
    expect(orders).toEqual([[{ receivedAt: "desc" }, { id: "desc" }], { receivedAt: "desc" }]);
    await app.close();
  });

  it("MAIL_V2 off: tier=ALL keeps the legacy ordering too", async () => {
    delete process.env.MAIL_V2;
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    const app = await buildApp();
    await app.inject({ method: "GET", url: "/api/email?tier=ALL", headers: auth() });
    expect((emailFindMany.mock.calls[0]?.[0] as { orderBy: unknown }).orderBy).toEqual({
      receivedAt: "desc",
    });
    await app.close();
  });

  it("rejects a value that is not a live lane — retired AUTO included", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    const app = await buildApp();
    for (const tier of ["AUTO", "CALL", "push", "anything"]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/email?tier=${tier}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(400);
    }
    expect(emailFindMany).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
    await app.close();
  });

  it("a failed lane query fails the request instead of returning the unfiltered list", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    queryRaw.mockRejectedValue(new Error("db down"));
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email?tier=PUSH", headers: auth() });
    expect(res.statusCode).toBe(500);
    expect(emailFindMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("filters the demo rows by lane too", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email?tier=PUSH", headers: auth() });
    const body = res.json();
    expect(body.source).toBe("demo");
    expect(body.emails.length).toBeGreaterThan(0);
    for (const email of body.emails) expect(email.tier).toBe("PUSH");
    expect(body.total).toBe(body.emails.length);
    await app.close();
  });

  it("UNIFIED_HOME on, MAIL_V2 off: Today reads lanes, so tier is honoured", async () => {
    delete process.env.MAIL_V2;
    process.env.UNIFIED_HOME = "true";
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    const app = await buildApp();
    const lane = await app.inject({ method: "GET", url: "/api/email?tier=PUSH", headers: auth() });
    expect(lane.statusCode).toBe(200);
    // The lane page is the raw join, never the unfiltered Prisma list.
    expect(queryRaw).toHaveBeenCalled();
    const bad = await app.inject({ method: "GET", url: "/api/email?tier=nope", headers: auth() });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it("MAIL_V2 off: tier is ignored, valid or not — the list is what it was", async () => {
    delete process.env.MAIL_V2;
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    const app = await buildApp();
    for (const query of ["tier=PUSH", "tier=anything", "tier=QUEUE&inbox=linked-9&filter=unread"]) {
      const res = await app.inject({ method: "GET", url: `/api/email?${query}`, headers: auth() });
      expect(res.statusCode).toBe(200);
    }
    const wheres = emailFindMany.mock.calls.map(
      ([args]) => (args as { where: Record<string, unknown> }).where,
    );
    expect(wheres).toEqual([
      { userId: "user-1" },
      { userId: "user-1" },
      { userId: "user-1", linkedInboxAccountId: "linked-9", isRead: false },
    ]);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(linkedInboxFindFirst).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("GET /api/email/lane-counts", () => {
  it("folds stored values into the five live lanes; unjudged mail counts as QUEUE", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    queryRaw.mockResolvedValue([
      { tier: "PUSH", total: 3, unread: 2 },
      { tier: "CALL", total: 1, unread: 1 },
      { tier: "AUTO", total: 4, unread: 0 },
      // null covers both a judged row with no tier and a mail with no row at all.
      { tier: null, total: 2, unread: 1 },
      { tier: "QUEUE", total: 10, unread: 5 },
      { tier: "SILENT", total: 7, unread: 7 },
    ]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email/lane-counts", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      source: "gmail",
      counts: {
        PUSH: { total: 4, unread: 3 },
        MEETING: { total: 0, unread: 0 },
        QUEUE: { total: 16, unread: 6 },
        INFO: { total: 0, unread: 0 },
        SILENT: { total: 7, unread: 7 },
      },
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("counts every mail once — mail first, lane joined on — so the lanes sum to All", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    const app = await buildApp();
    await app.inject({ method: "GET", url: "/api/email/lane-counts", headers: auth() });
    const [call] = rawCalls();
    expect(call.text).toContain(`FROM "EmailMessage" e LEFT JOIN "AttentionItem" a`);
    expect(call.text).toContain(`a."sourceId" = e."id" AND a."userId" = e."userId"`);
    expect(call.text).toContain(`GROUP BY a."tier"`);
    expect(call.values).toEqual(["user-1"]);
    expect(call.text).not.toContain("user-1");
    await app.close();
  });

  it("scopes to one of the caller's accounts, bound as a parameter", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    linkedInboxFindFirst.mockResolvedValue({ id: "linked-1" });
    const app = await buildApp();
    await app.inject({
      method: "GET",
      url: "/api/email/lane-counts?inbox=linked-1",
      headers: auth(),
    });
    const [call] = rawCalls();
    expect(call.values).toEqual(["user-1", "linked-1"]);
    expect(call.text).not.toContain("linked-1");
    await app.close();
  });

  it("an account that is not the caller's counts nothing, and no mail query runs", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    linkedInboxFindFirst.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email/lane-counts?inbox=someone-elses-inbox",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(linkedInboxFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "someone-elses-inbox", userId: "user-1" } }),
    );
    const { counts } = res.json();
    for (const lane of Object.keys(counts)) expect(counts[lane]).toEqual({ total: 0, unread: 0 });
    expect(queryRaw).not.toHaveBeenCalled();
    await app.close();
  });

  it("is rate limited like its sibling routes", async () => {
    const { emailRoutes } = await import("../routes/email.js");
    const app = Fastify();
    const limits: unknown[] = [];
    app.addHook("onRoute", (route) => {
      if (route.url === "/api/email/lane-counts" && route.method === "GET") {
        limits.push(route.config?.rateLimit);
      }
    });
    await app.register(emailRoutes, { prefix: "/api/email" });
    await app.ready();
    expect(limits).toEqual([{ max: 120, timeWindow: "1 minute" }]);
    await app.close();
  });

  it("counts the demo rows when no mail account is connected", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email/lane-counts", headers: auth() });
    const body = res.json();
    expect(body.source).toBe("demo");
    expect(Object.keys(body.counts).sort()).toEqual(["INFO", "MEETING", "PUSH", "QUEUE", "SILENT"]);
    expect(body.counts.PUSH.total).toBeGreaterThan(0);
    expect(queryRaw).not.toHaveBeenCalled();
    await app.close();
  });

  it("UNIFIED_HOME on, MAIL_V2 off: the counts are served for Today", async () => {
    delete process.env.MAIL_V2;
    process.env.UNIFIED_HOME = "true";
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email/lane-counts", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().counts).sort()).toEqual([
      "INFO",
      "MEETING",
      "PUSH",
      "QUEUE",
      "SILENT",
    ]);
    await app.close();
  });

  it("MAIL_V2 off: the route does not exist", async () => {
    delete process.env.MAIL_V2;
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email/lane-counts", headers: auth() });
    expect(res.statusCode).toBe(404);
    expect(queryRaw).not.toHaveBeenCalled();
    await app.close();
  });
});
