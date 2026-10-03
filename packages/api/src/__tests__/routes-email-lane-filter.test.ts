/**
 * Mail v2 (productization plan P5, MAIL_V2): the lane is Mail's primary
 * filter, so GET /api/email takes `tier` and GET /api/email/lane-counts feeds
 * the segmented control. Both are user-scoped and compose with the existing
 * `inbox` account scope. With MAIL_V2 off the list ignores `tier` (what it did
 * before the param existed) and the counts route answers 404.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const userTokenFindFirst = vi.hoisted(() => vi.fn(async () => null as unknown));
const emailFindMany = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const emailCount = vi.hoisted(() => vi.fn(async () => 0));
const attentionFindMany = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const queryRaw = vi.hoisted(() => vi.fn(async () => [] as unknown[]));

vi.mock("../db.js", () => {
  const prisma = {
    userToken: { findFirst: userTokenFindFirst },
    emailMessage: { findMany: emailFindMany, count: emailCount },
    attentionItem: { findMany: attentionFindMany },
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
  process.env.MAIL_V2 = "true";
});

afterEach(() => {
  delete process.env.MAIL_V2;
});

/** The AttentionItem query that resolves a lane to mail ids. */
function laneLookupArgs() {
  const call = attentionFindMany.mock.calls.find(
    ([args]) => (args as { select?: { tier?: boolean } }).select?.tier === undefined,
  );
  return call?.[0] as {
    where: Record<string, unknown>;
    take: number;
    orderBy: unknown;
  };
}

function listWhere() {
  return (emailFindMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;
}

describe("GET /api/email?tier= — lane filter", () => {
  it("scopes the list to the lane's mail ids, looked up for this user only", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    attentionFindMany.mockImplementation(async (args: unknown) =>
      (args as { select: { tier?: boolean } }).select.tier
        ? [{ sourceId: "e1", tier: "PUSH" }]
        : [{ sourceId: "e1" }, { sourceId: "e9" }],
    );
    emailFindMany.mockResolvedValue([dbRow("e1")]);
    emailCount.mockResolvedValue(1);

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email?tier=PUSH", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().emails.map((e: { id: string }) => e.id)).toEqual(["e1"]);

    const lookup = laneLookupArgs();
    expect(lookup.where).toMatchObject({ userId: "user-1", source: "EMAIL" });
    // CALL is a retired value that reads as PUSH, so it belongs to this lane.
    expect(lookup.where.tier).toEqual({ in: ["PUSH", "CALL"] });
    expect(listWhere()).toMatchObject({ userId: "user-1", id: { in: ["e1", "e9"] } });
    await app.close();
  });

  it("QUEUE also holds the rows that read as QUEUE: AUTO, null and unknown values", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    const app = await buildApp();
    await app.inject({ method: "GET", url: "/api/email?tier=QUEUE", headers: auth() });
    const lookup = laneLookupArgs();
    expect(lookup.where.OR).toEqual([
      { tier: null },
      { tier: { notIn: ["PUSH", "CALL", "MEETING", "INFO", "SILENT"] } },
    ]);
    await app.close();
  });

  it("composes with the account scope and the legacy filters", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    attentionFindMany.mockResolvedValue([{ sourceId: "e1" }]);
    const app = await buildApp();
    await app.inject({
      method: "GET",
      url: "/api/email?tier=INFO&inbox=linked-1&filter=unread",
      headers: auth(),
    });
    expect(listWhere()).toMatchObject({
      userId: "user-1",
      id: { in: ["e1"] },
      linkedInboxAccountId: "linked-1",
      isRead: false,
    });
    await app.close();
  });

  it("ALL and an absent tier do not filter by lane", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    const app = await buildApp();
    await app.inject({ method: "GET", url: "/api/email?tier=ALL", headers: auth() });
    await app.inject({ method: "GET", url: "/api/email", headers: auth() });
    for (const [args] of emailFindMany.mock.calls) {
      expect((args as { where: Record<string, unknown> }).where.id).toBeUndefined();
    }
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
    await app.close();
  });

  it("a failed lane lookup fails the request instead of returning the unfiltered list", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    attentionFindMany.mockRejectedValue(new Error("db down"));
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

  it("MAIL_V2 off: tier is ignored, valid or not — the list is what it was", async () => {
    delete process.env.MAIL_V2;
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    const app = await buildApp();
    for (const tier of ["PUSH", "anything"]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/email?tier=${tier}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
    }
    for (const [args] of emailFindMany.mock.calls) {
      expect((args as { where: Record<string, unknown> }).where).toEqual({ userId: "user-1" });
    }
    await app.close();
  });
});

describe("GET /api/email/lane-counts", () => {
  it("folds stored values into the five live lanes, total and unread", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    queryRaw.mockResolvedValue([
      { tier: "PUSH", total: 3, unread: 2 },
      { tier: "CALL", total: 1, unread: 1 },
      { tier: "AUTO", total: 4, unread: 0 },
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

  it("binds the caller's user id and the account scope as parameters", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    const app = await buildApp();
    await app.inject({
      method: "GET",
      url: "/api/email/lane-counts?inbox=linked-1",
      headers: auth(),
    });
    const [strings, ...values] = queryRaw.mock.calls[0] as unknown as [
      { strings?: string[]; values?: unknown[] } | string[],
      ...unknown[],
    ];
    const flat = JSON.stringify([strings, values]);
    expect(flat).toContain("user-1");
    expect(flat).toContain("linked-1");
    // Bound, never interpolated into the SQL text.
    const text = Array.isArray(strings) ? strings.join("?") : (strings.strings ?? []).join("?");
    expect(text).not.toContain("linked-1");
    expect(text).not.toContain("user-1");
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

  it("MAIL_V2 off: the route does not exist", async () => {
    delete process.env.MAIL_V2;
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email/lane-counts", headers: auth() });
    expect(res.statusCode).toBe(404);
    expect(queryRaw).not.toHaveBeenCalled();
    await app.close();
  });
});
