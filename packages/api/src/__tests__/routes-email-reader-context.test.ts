/**
 * GET /api/email/:id/reader-context (productization plan P5b, MAIL_V2): what
 * the Mail v2 reader header shows beyond the mail itself — the lane and why,
 * the account, the sender facts that left the list row — plus the previous /
 * next mail in the list view the reader was opened from. The neighbours use the
 * list's own FROM, WHERE and order, so "next" walks the rows the list shows.
 * User-scoped end to end: another user's mail is a 404 before anything else is
 * read, and a foreign account has no neighbours. With MAIL_V2 off the route
 * does not exist. The neighbour SQL is also run against a real Postgres in the
 * PR's test plan; here its text and bound values are pinned.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const emailFindFirst = vi.hoisted(() => vi.fn(async (_args: unknown) => null as unknown));
const attentionFindFirst = vi.hoisted(() => vi.fn(async (_args: unknown) => null as unknown));
const engagementFindFirst = vi.hoisted(() => vi.fn(async (_args: unknown) => null as unknown));
const senderLabelFindMany = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const linkedInboxFindFirst = vi.hoisted(() => vi.fn(async (_args: unknown) => null as unknown));
const userFindUnique = vi.hoisted(() => vi.fn(async (_args: unknown) => null as unknown));
const queryRaw = vi.hoisted(() => vi.fn(async (_sql: unknown) => [] as unknown[]));
const captureError = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => {
  const prisma = {
    userToken: { findFirst: vi.fn(async () => null) },
    emailMessage: { findFirst: emailFindFirst, findMany: vi.fn(async () => []) },
    attentionItem: { findFirst: attentionFindFirst, findMany: vi.fn(async () => []) },
    contactEngagementScore: { findFirst: engagementFindFirst },
    senderLabel: { findMany: senderLabelFindMany },
    linkedInboxAccount: { findFirst: linkedInboxFindFirst },
    automationConfig: { findUnique: vi.fn(async () => null) },
    $queryRaw: queryRaw,
    user: { findUnique: userFindUnique },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", async (original) => ({
  ...(await original<typeof import("../sentry.js")>()),
  captureError,
}));

const TOKEN = signToken({ userId: "user-1", email: "t@e.com" });
const auth = () => ({ authorization: `Bearer ${TOKEN}` });

async function buildApp() {
  const { emailRoutes } = await import("../routes/email.js");
  const app = Fastify();
  await app.register(emailRoutes, { prefix: "/api/email" });
  return app;
}

const MAIL = {
  id: "e5",
  from: "Ada Lovelace <Ada@Example.com>",
  category: null,
  labels: ["INBOX"],
  linkedInboxAccountId: null,
};

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

const olderQuery = () => rawCalls().find((call) => call.text.includes("DESC LIMIT 1")) as RawCall;
const newerQuery = () => rawCalls().find((call) => call.text.includes("ASC LIMIT 1")) as RawCall;

/** Answer the two neighbour queries: the older mail, then the newer one. */
function neighbours(olderId: string | null, newerId: string | null) {
  queryRaw.mockImplementation(async (sql: unknown) => {
    const text = (sql as { strings: string[] }).strings.join("?");
    const id = text.includes("ASC") ? newerId : olderId;
    return id ? [{ id }] : [];
  });
}

async function get(url: string) {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url, headers: auth() });
  await app.close();
  return res;
}

beforeEach(() => {
  for (const mock of [
    emailFindFirst,
    attentionFindFirst,
    engagementFindFirst,
    linkedInboxFindFirst,
    queryRaw,
    captureError,
  ]) {
    mock.mockReset();
  }
  emailFindFirst.mockResolvedValue(MAIL);
  attentionFindFirst.mockResolvedValue(null);
  engagementFindFirst.mockResolvedValue(null);
  linkedInboxFindFirst.mockResolvedValue(null);
  queryRaw.mockResolvedValue([]);
  senderLabelFindMany.mockReset();
  senderLabelFindMany.mockResolvedValue([]);
  userFindUnique.mockReset();
  userFindUnique.mockResolvedValue({
    id: "user-1",
    plan: "FREE",
    role: "USER",
    companyDomains: [],
    notificationLanguage: "en",
  });
  process.env.MAIL_V2 = "true";
});

afterEach(() => {
  delete process.env.MAIL_V2;
});

describe("GET /api/email/:id/reader-context — lane, reason, account", () => {
  it("reports the recorded lane with its reason and the account the mail arrived in", async () => {
    emailFindFirst.mockResolvedValue({ ...MAIL, linkedInboxAccountId: "linked-1" });
    attentionFindFirst.mockResolvedValue({ tier: "PUSH", tierReason: "Investor asked for a call" });
    const res = await get("/api/email/e5/reader-context");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      tier: "PUSH",
      tierReason: "Investor asked for a call",
      linkedInboxAccountId: "linked-1",
    });
    expect(attentionFindFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { userId: "user-1", source: "EMAIL", sourceId: "e5" },
    });
  });

  it("claims no lane for mail the judge has not reached", async () => {
    const body = (await get("/api/email/e5/reader-context")).json();
    expect(body.tier).toBeNull();
    expect(body.tierReason).toBeNull();
  });

  it("never puts a retired lane on the wire: AUTO reads as QUEUE, CALL as PUSH", async () => {
    attentionFindFirst.mockResolvedValue({ tier: "AUTO", tierReason: null });
    expect((await get("/api/email/e5/reader-context")).json().tier).toBe("QUEUE");
    attentionFindFirst.mockResolvedValue({ tier: "CALL", tierReason: null });
    expect((await get("/api/email/e5/reader-context")).json().tier).toBe("PUSH");
  });
});

describe("GET /api/email/:id/reader-context — sender facts", () => {
  it("a sender never written to, with no category claim, is a first contact", async () => {
    const body = (await get("/api/email/e5/reader-context")).json();
    expect(body).toMatchObject({ firstContact: true, repliedCount: 0 });
    // Engagement is stored lowercased; the lookup is scoped to the caller.
    expect(engagementFindFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { userId: "user-1", contactEmail: "ada@example.com" },
    });
  });

  it("reply history is reported, and is not a first contact", async () => {
    engagementFindFirst.mockResolvedValue({ outboundCount: 4 });
    const body = (await get("/api/email/e5/reader-context")).json();
    expect(body).toMatchObject({ firstContact: false, repliedCount: 4 });
  });

  it("bulk mail is never a first contact", async () => {
    emailFindFirst.mockResolvedValue({ ...MAIL, labels: ["INBOX", "CATEGORY_PROMOTIONS"] });
    expect((await get("/api/email/e5/reader-context")).json().firstContact).toBe(false);
    emailFindFirst.mockResolvedValue({ ...MAIL, category: "newsletter" });
    expect((await get("/api/email/e5/reader-context")).json().firstContact).toBe(false);
  });

  it("a colleague on a declared company domain is never a first contact", async () => {
    userFindUnique.mockResolvedValue({
      id: "user-1",
      plan: "FREE",
      role: "USER",
      companyDomains: ["example.com"],
    });
    expect((await get("/api/email/e5/reader-context")).json().firstContact).toBe(false);
  });

  it("fails open: a failed lookup claims nothing instead of failing the reader", async () => {
    engagementFindFirst.mockRejectedValue(new Error("db down"));
    const res = await get("/api/email/e5/reader-context");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ firstContact: false, repliedCount: null });
    expect(captureError).toHaveBeenCalled();
  });
});

describe("GET /api/email/:id/reader-context — previous / next in the list view", () => {
  it("returns the mail just above and just below, in the list's own order", async () => {
    neighbours("e4", "e6");
    const body = (await get("/api/email/e5/reader-context?tier=PUSH")).json();
    expect(body).toMatchObject({ newerId: "e6", olderId: "e4" });

    const older = olderQuery();
    expect(older.text).toContain('FROM "EmailMessage" e INNER JOIN "AttentionItem" a ON');
    expect(older.text).toContain('a."userId" = e."userId"');
    expect(older.text).toContain('WHERE e."userId" = ?');
    expect(older.text).toContain('(e."receivedAt", e."id") <');
    expect(older.text).toContain('ORDER BY e."receivedAt" DESC, e."id" DESC LIMIT 1');
    const newer = newerQuery();
    expect(newer.text).toContain('(e."receivedAt", e."id") >');
    expect(newer.text).toContain('ORDER BY e."receivedAt" ASC, e."id" ASC LIMIT 1');
    for (const call of [older, newer]) {
      expect(call.values).toEqual(expect.arrayContaining(["user-1", "PUSH", "CALL", "e5"]));
    }
  });

  it("the anchor is read by id and owner inside the query, as bound parameters", async () => {
    await get("/api/email/e5/reader-context?tier=QUEUE");
    const older = olderQuery();
    expect(older.text).toContain(
      '(SELECT c."receivedAt", c."id" FROM "EmailMessage" c WHERE c."id" = ? AND c."userId" = ?)',
    );
    expect(older.values.slice(-2)).toEqual(["e5", "user-1"]);
    // QUEUE keeps mail the judge has not reached: a LEFT JOIN, like the list.
    expect(older.text).toContain('LEFT JOIN "AttentionItem" a ON');
  });

  it("ALL (and an absent tier) walks every lane without a join", async () => {
    for (const url of ["/api/email/e5/reader-context?tier=ALL", "/api/email/e5/reader-context"]) {
      queryRaw.mockClear();
      await get(url);
      expect(olderQuery().text).not.toContain("AttentionItem");
      expect(olderQuery().values).toEqual(["user-1", "e5", "user-1"]);
    }
  });

  it("composes with the account scope, the filter and a wildcard-escaped search", async () => {
    linkedInboxFindFirst.mockResolvedValue({ id: "linked-1" });
    await get(
      `/api/email/e5/reader-context?tier=INFO&inbox=linked-1&filter=unread&search=${encodeURIComponent("50%_off")}`,
    );
    const older = olderQuery();
    expect(linkedInboxFindFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { id: "linked-1", userId: "user-1" },
    });
    expect(older.text).toContain('AND e."linkedInboxAccountId" = ?');
    expect(older.text).toContain('AND e."isRead" = false');
    expect(older.values).toContain("linked-1");
    expect(older.values).toContain("%50\\%\\_off%");
  });

  it("an account that is not the caller's has no neighbours, and no mail query runs", async () => {
    const body = (await get("/api/email/e5/reader-context?tier=PUSH&inbox=someone-elses")).json();
    expect(body).toMatchObject({ newerId: null, olderId: null });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("opens by Gmail id too, and anchors on the row's own id", async () => {
    await get("/api/email/gmail-abc/reader-context");
    expect(emailFindFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { userId: "user-1", OR: [{ id: "gmail-abc" }, { gmailId: "gmail-abc" }] },
    });
    expect(olderQuery().values).toContain("e5");
  });
});

describe("GET /api/email/:id/reader-context — refusals", () => {
  it("another user's mail is a 404, and nothing else is read", async () => {
    emailFindFirst.mockResolvedValue(null);
    const res = await get("/api/email/not-mine/reader-context?tier=PUSH");
    expect(res.statusCode).toBe(404);
    expect(emailFindFirst.mock.calls[0]?.[0]).toMatchObject({ where: { userId: "user-1" } });
    expect(attentionFindFirst).not.toHaveBeenCalled();
    expect(engagementFindFirst).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("rejects a value that is not a live lane — retired AUTO included", async () => {
    for (const tier of ["AUTO", "CALL", "push", "constructor"]) {
      const res = await get(`/api/email/e5/reader-context?tier=${tier}`);
      expect(res.statusCode).toBe(400);
    }
    expect(emailFindFirst).not.toHaveBeenCalled();
  });

  it("an unknown or inherited filter key is refused, never interpolated", async () => {
    for (const filter of ["candidates", "__proto__", "constructor"]) {
      const res = await get(`/api/email/e5/reader-context?tier=PUSH&filter=${filter}`);
      expect(res.statusCode).toBe(400);
    }
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("requires a signed-in user", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email/e5/reader-context" });
    expect(res.statusCode).toBe(401);
    expect(emailFindFirst).not.toHaveBeenCalled();
    await app.close();
  });

  it("is rate limited like its sibling route", async () => {
    const { emailRoutes } = await import("../routes/email.js");
    const app = Fastify();
    const limits: unknown[] = [];
    app.addHook("onRoute", (route) => {
      if (route.url === "/api/email/:id/reader-context" && route.method === "GET") {
        limits.push(route.config?.rateLimit);
      }
    });
    await app.register(emailRoutes, { prefix: "/api/email" });
    await app.ready();
    expect(limits).toEqual([{ max: 120, timeWindow: "1 minute" }]);
    await app.close();
  });

  it("MAIL_V2 off: the route does not exist", async () => {
    delete process.env.MAIL_V2;
    const res = await get("/api/email/e5/reader-context?tier=PUSH");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "Not Found" });
    expect(emailFindFirst).not.toHaveBeenCalled();
  });
});

describe("GET /api/email/:id/reader-context — demo mail", () => {
  it("answers from the demo rows: hand-assigned lane, neighbours within that lane", async () => {
    const all = (await get("/api/email/demo-2/reader-context")).json();
    expect(all).toMatchObject({ tier: "INFO", newerId: "demo-1", olderId: "demo-3" });
    const lane = (await get("/api/email/demo-2/reader-context?tier=INFO")).json();
    expect(lane.newerId).toBeNull();
    expect(lane.olderId).toMatch(/^demo-/);
    expect(emailFindFirst).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("an unknown demo id is a 404", async () => {
    expect((await get("/api/email/demo-nope/reader-context")).statusCode).toBe(404);
  });
});
