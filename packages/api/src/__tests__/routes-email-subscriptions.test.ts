/**
 * Subscriptions (Mail → Subscriptions): GET /api/email/subscriptions lists the
 * caller's list senders per (sender, connected account) — never merged across
 * accounts — and POST /api/email/subscriptions/unsubscribe unsubscribes through
 * that sender's newest mail IN THAT ACCOUNT, optionally archiving its recent mail
 * through the bulk-archive path. Dark (byte-identical to an unregistered route)
 * while BULK_UNSUBSCRIBE_ENABLED is off.
 *
 * The Prisma calls run against a small in-memory fake so the grouping, the
 * account scoping and the userId scoping are exercised, not just asserted on.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

interface Row {
  id: string;
  userId: string;
  gmailId: string;
  from: string;
  fromAddress: string | null;
  linkedInboxAccountId: string | null;
  isRead: boolean;
  receivedAt: Date;
  listUnsubscribeMailto: string | null;
  listUnsubscribeUrl: string | null;
  listUnsubscribeOneClick: boolean;
}

type Where = Record<string, unknown>;

const store = vi.hoisted(() => ({ rows: [] as Row[] }));
const m = vi.hoisted(() => ({
  oneClick: vi.fn(),
  sendEmail: vi.fn(),
  archive: vi.fn(),
  mailActionsFor: vi.fn(),
  attentionUpdateMany: vi.fn(async () => ({ count: 0 })),
}));

function matchValue(value: unknown, cond: unknown): boolean {
  if (cond === null || typeof cond !== "object" || cond instanceof Date) return value === cond;
  const c = cond as Record<string, unknown>;
  if ("not" in c) return value !== c.not;
  if ("in" in c) return (c.in as unknown[]).includes(value);
  if ("gte" in c) return value instanceof Date && value >= (c.gte as Date);
  throw new Error(`fake prisma: unsupported condition ${JSON.stringify(cond)}`);
}

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Where[]).some((w) => matches(row, w));
    return matchValue(row[key as keyof Row], cond);
  });
}

function newestFirst(a: Row, b: Row) {
  return b.receivedAt.getTime() - a.receivedAt.getTime();
}

function groupBy(args: {
  by: (keyof Row)[];
  where: Where;
  take?: number;
  _max?: Record<string, boolean>;
}) {
  const groups = new Map<string, Row[]>();
  for (const row of store.rows.filter((r) => matches(r, args.where))) {
    const key = JSON.stringify(args.by.map((k) => row[k]));
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const out = [...groups.values()].map((rows) => {
    const g: Record<string, unknown> = {};
    for (const k of args.by) g[k] = rows[0][k];
    g._count = { _all: rows.length };
    if (args._max) {
      const max: Record<string, unknown> = {};
      for (const field of Object.keys(args._max)) {
        const values = rows
          .map((r) => r[field as keyof Row])
          .filter((v) => v !== null && v !== undefined) as (string | Date)[];
        max[field] = values.length === 0 ? null : values.sort().at(-1);
      }
      g._max = max;
    }
    return g;
  });
  out.sort((a, b) => (b._count as { _all: number })._all - (a._count as { _all: number })._all);
  return out.slice(0, args.take ?? out.length);
}

vi.mock("../db.js", () => {
  const prisma = {
    userToken: { findFirst: vi.fn(async () => null) },
    emailMessage: {
      groupBy: vi.fn(async (args: Parameters<typeof groupBy>[0]) => groupBy(args)),
      findFirst: vi.fn(async (args: { where: Where }) => {
        return store.rows.filter((r) => matches(r, args.where)).sort(newestFirst)[0] ?? null;
      }),
      findMany: vi.fn(async (args: { where: Where; take?: number }) =>
        store.rows
          .filter((r) => matches(r, args.where))
          .sort(newestFirst)
          .slice(0, args.take),
      ),
      deleteMany: vi.fn(async (args: { where: Where }) => {
        const before = store.rows.length;
        store.rows = store.rows.filter((r) => !matches(r, args.where));
        return { count: before - store.rows.length };
      }),
    },
    attentionItem: { updateMany: m.attentionUpdateMany },
    linkedInboxAccount: {
      findMany: vi.fn(async () => [{ id: "acct-work", email: "me@work.example" }]),
    },
    user: {
      findUnique: vi.fn(async () => ({
        id: "user-1",
        plan: "FREE",
        role: "USER",
        email: "me@gmail.example",
      })),
    },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../billing/entitlement-guard.js", () => ({
  requireEntitled: vi.fn(async () => {}),
  requireAppAccess: vi.fn(async () => {}),
}));
vi.mock("../mail/list-unsubscribe.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../mail/list-unsubscribe.js")>();
  return { ...original, executeOneClickUnsubscribe: m.oneClick };
});
vi.mock("../mail/providers/dispatch.js", () => ({
  mailActionsFor: m.mailActionsFor,
  mailActionsForProvider: vi.fn(),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const PREFIX = "/api/email";
const TOKEN = signToken({ userId: "user-1", email: "t@e.com" });
const auth = () => ({ authorization: `Bearer ${TOKEN}` });
const saved = process.env.BULK_UNSUBSCRIBE_ENABLED;

let seq = 0;
function row(init: Partial<Row>): Row {
  seq += 1;
  return {
    id: `e${seq}`,
    userId: "user-1",
    gmailId: `g${seq}`,
    from: "Acme News <news@acme.example>",
    fromAddress: "news@acme.example",
    linkedInboxAccountId: null,
    isRead: true,
    receivedAt: new Date(Date.now() - seq * 60_000),
    listUnsubscribeMailto: null,
    listUnsubscribeUrl: "https://acme.example/u",
    listUnsubscribeOneClick: false,
    ...init,
  };
}

async function buildApp() {
  const { emailSubscriptionsRoutes } = await import("../routes/email-subscriptions.js");
  const { bulkUnsubscribeEnabled } = await import("../config.js");
  const app = Fastify();
  await app.register(emailSubscriptionsRoutes({ gate: bulkUnsubscribeEnabled }), {
    prefix: PREFIX,
  });
  await app.ready();
  return app;
}

beforeEach(() => {
  process.env.BULK_UNSUBSCRIBE_ENABLED = "true";
  store.rows = [];
  seq = 0;
  m.oneClick.mockReset();
  m.oneClick.mockResolvedValue({ ok: true });
  m.sendEmail.mockReset();
  m.sendEmail.mockResolvedValue({ success: true });
  m.archive.mockReset();
  m.archive.mockResolvedValue({ success: true });
  m.attentionUpdateMany.mockClear();
  m.mailActionsFor.mockReset();
  m.mailActionsFor.mockImplementation(async () => ({
    provider: "GOOGLE",
    sendEmail: m.sendEmail,
    archive: m.archive,
  }));
});

afterEach(() => {
  if (saved === undefined) delete process.env.BULK_UNSUBSCRIBE_ENABLED;
  else process.env.BULK_UNSUBSCRIBE_ENABLED = saved;
});

describe("dark while BULK_UNSUBSCRIBE_ENABLED is off", () => {
  it.each([
    ["GET", `${PREFIX}/subscriptions`],
    ["POST", `${PREFIX}/subscriptions/unsubscribe`],
  ] as const)("%s %s answers exactly what an unregistered route answers", async (method, url) => {
    process.env.BULK_UNSUBSCRIBE_ENABLED = "false";
    store.rows = [row({})];
    const app = await buildApp();
    const bare = Fastify();
    await bare.ready();
    const payload =
      method === "POST" ? { sender: "news@acme.example", linkedInboxAccountId: null } : undefined;

    const res = await app.inject({ method, url, headers: auth(), payload });
    const unregistered = await bare.inject({ method, url, payload });

    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(unregistered.body);
    expect(m.oneClick).not.toHaveBeenCalled();
    expect(m.mailActionsFor).not.toHaveBeenCalled();
    // An unauthenticated probe gets the same 404, not a 401.
    const anon = await app.inject({ method, url, payload });
    expect(anon.body).toBe(unregistered.body);
    await app.close();
    await bare.close();
  });

  it("is dark inside the real /api/email plugin too, without falling through to /:id", async () => {
    process.env.BULK_UNSUBSCRIBE_ENABLED = "false";
    const { emailRoutes } = await import("../routes/email.js");
    const app = Fastify();
    await app.register(emailRoutes, { prefix: PREFIX });
    const bare = Fastify();
    const url = `${PREFIX}/subscriptions`;
    const res = await app.inject({ method: "GET", url, headers: auth() });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe((await bare.inject({ method: "GET", url })).body);
    await app.close();
    await bare.close();
  });

  it("is read per request: turning it on needs no restart", async () => {
    process.env.BULK_UNSUBSCRIBE_ENABLED = "false";
    const app = await buildApp();
    const url = `${PREFIX}/subscriptions`;
    expect((await app.inject({ method: "GET", url, headers: auth() })).statusCode).toBe(404);
    process.env.BULK_UNSUBSCRIBE_ENABLED = "true";
    expect((await app.inject({ method: "GET", url, headers: auth() })).statusCode).toBe(200);
    await app.close();
  });
});

describe("GET /api/email/subscriptions", () => {
  it("requires auth", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `${PREFIX}/subscriptions` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("groups by sender AND account, never merging two accounts", async () => {
    store.rows = [
      row({ isRead: false, listUnsubscribeOneClick: true }),
      row({}),
      row({}),
      row({
        linkedInboxAccountId: "acct-work",
        isRead: false,
        listUnsubscribeUrl: null,
        listUnsubscribeMailto: "mailto:u@acme.example",
      }),
      row({
        from: "promo@shop.example",
        fromAddress: "promo@shop.example",
        listUnsubscribeUrl: "http://shop.example/u",
      }),
      // No unsubscribe info: not a subscription.
      row({
        from: "friend@pal.example",
        fromAddress: "friend@pal.example",
        listUnsubscribeUrl: null,
      }),
      // Older than the 90-day window.
      row({
        from: "old@list.example",
        fromAddress: "old@list.example",
        receivedAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000),
      }),
      // Another user's mail never shows up.
      row({ userId: "user-2", from: "x@other.example", fromAddress: "x@other.example" }),
    ];
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `${PREFIX}/subscriptions`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.windowDays).toBe(90);
    expect(body.subscriptions).toEqual([
      {
        sender: "news@acme.example",
        displayName: "Acme News",
        linkedInboxAccountId: null,
        accountLabel: "me@gmail.example",
        count: 3,
        unreadCount: 1,
        lastReceivedAt: store.rows[0].receivedAt.toISOString(),
        method: "one-click",
      },
      expect.objectContaining({
        sender: "news@acme.example",
        linkedInboxAccountId: "acct-work",
        accountLabel: "me@work.example",
        count: 1,
        unreadCount: 1,
        method: "mailto",
      }),
      expect.objectContaining({
        sender: "promo@shop.example",
        displayName: null,
        linkedInboxAccountId: null,
        count: 1,
        unreadCount: 0,
        method: "link",
      }),
    ]);
    await app.close();
  });
});

describe("POST /api/email/subscriptions/unsubscribe", () => {
  const post = async (payload: unknown) => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `${PREFIX}/subscriptions/unsubscribe`,
      headers: auth(),
      payload: payload as Record<string, unknown>,
    });
    await app.close();
    return res;
  };

  it.each([
    [{}],
    [{ sender: "news@acme.example" }],
    [{ sender: 42, linkedInboxAccountId: null }],
    [{ sender: "not an address", linkedInboxAccountId: null }],
    [{ sender: "news@acme.example", linkedInboxAccountId: "" }],
    [{ sender: "news@acme.example", linkedInboxAccountId: 7 }],
    [{ sender: "news@acme.example", linkedInboxAccountId: "a".repeat(129) }],
    [{ sender: `${"a".repeat(320)}@x.example`, linkedInboxAccountId: null }],
    [{ sender: "news@acme.example", linkedInboxAccountId: null, archive: "yes" }],
  ])("400s an invalid body %j", async (payload) => {
    store.rows = [row({})];
    const res = await post(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error");
    expect(m.oneClick).not.toHaveBeenCalled();
    expect(m.mailActionsFor).not.toHaveBeenCalled();
  });

  it("400s a non-object body", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `${PREFIX}/subscriptions/unsubscribe`,
      headers: { ...auth(), "content-type": "application/json" },
      payload: JSON.stringify(["news@acme.example"]),
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("uses the newest mail in the requested account and threads that account into the send", async () => {
    store.rows = [
      // Newest overall, but in the primary account.
      row({ listUnsubscribeMailto: "mailto:primary@acme.example", listUnsubscribeUrl: null }),
      // Newest in the work account.
      row({
        linkedInboxAccountId: "acct-work",
        listUnsubscribeUrl: null,
        listUnsubscribeMailto: "mailto:work-new@acme.example?subject=stop",
      }),
      row({
        linkedInboxAccountId: "acct-work",
        listUnsubscribeUrl: null,
        listUnsubscribeMailto: "mailto:work-old@acme.example",
      }),
    ];
    const res = await post({ sender: " News@Acme.example ", linkedInboxAccountId: "acct-work" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ method: "mailto", done: true, archived: 0, archiveFailed: 0 });
    expect(m.mailActionsFor).toHaveBeenCalledWith("user-1", "acct-work");
    expect(m.sendEmail).toHaveBeenCalledTimes(1);
    expect(m.sendEmail).toHaveBeenCalledWith(
      "user-1",
      "work-new@acme.example",
      "stop",
      "unsubscribe",
      [],
      { linkedInboxAccountId: "acct-work" },
    );
    expect(m.archive).not.toHaveBeenCalled();
  });

  it("scopes null to the primary account", async () => {
    store.rows = [
      row({ linkedInboxAccountId: "acct-work", listUnsubscribeUrl: "https://acme.example/work" }),
      row({ listUnsubscribeUrl: "https://acme.example/primary", listUnsubscribeOneClick: true }),
    ];
    const res = await post({ sender: "news@acme.example", linkedInboxAccountId: null });
    expect(res.json()).toEqual({ method: "one-click", done: true, archived: 0, archiveFailed: 0 });
    expect(m.oneClick).toHaveBeenCalledWith("https://acme.example/primary");
  });

  it("hands back the link when nothing automatic works", async () => {
    store.rows = [row({ listUnsubscribeUrl: "http://acme.example/u" })];
    const res = await post({ sender: "news@acme.example", linkedInboxAccountId: null });
    expect(res.json()).toEqual({
      method: "link",
      done: false,
      url: "http://acme.example/u",
      archived: 0,
      archiveFailed: 0,
    });
  });

  it("404s another user's sender, and a sender in an account it never mailed", async () => {
    store.rows = [
      row({ userId: "user-2", from: "x@other.example", fromAddress: "x@other.example" }),
      row({}),
    ];
    expect((await post({ sender: "x@other.example", linkedInboxAccountId: null })).statusCode).toBe(
      404,
    );
    expect(
      (await post({ sender: "news@acme.example", linkedInboxAccountId: "acct-work" })).statusCode,
    ).toBe(404);
    expect(m.oneClick).not.toHaveBeenCalled();
    expect(m.mailActionsFor).not.toHaveBeenCalled();
  });

  it("with archive, archives that sender's mail in that account and closes their attention items", async () => {
    store.rows = [
      row({ listUnsubscribeOneClick: true }),
      row({ listUnsubscribeUrl: null }),
      row({ linkedInboxAccountId: "acct-work" }),
      row({ from: "other@else.example", fromAddress: "other@else.example" }),
      row({ userId: "user-2" }),
    ];
    const [a, b] = store.rows;
    const res = await post({
      sender: "news@acme.example",
      linkedInboxAccountId: null,
      archive: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ method: "one-click", done: true, archived: 2, archiveFailed: 0 });
    expect(m.archive).toHaveBeenCalledTimes(2);
    for (const call of m.archive.mock.calls) {
      expect(call[0]).toBe("user-1");
      expect(call[2]).toBeNull();
    }
    expect(m.attentionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          source: "EMAIL",
          sourceId: { in: [a.id, b.id] },
        }),
        data: expect.objectContaining({ status: "RESOLVED" }),
      }),
    );
    // The other account, the other sender and the other user are untouched.
    expect(store.rows.map((r) => r.id).sort()).toEqual(["e3", "e4", "e5"]);
  });

  it("caps the archive at the 100 most recent and reports per-item failures", async () => {
    store.rows = Array.from({ length: 105 }, () => row({}));
    m.archive.mockImplementation(async (_uid: string, gmailId: string) =>
      gmailId === "g2" ? { error: "Gmail archive failed" } : { success: true },
    );
    const res = await post({
      sender: "news@acme.example",
      linkedInboxAccountId: null,
      archive: true,
    });
    expect(res.json()).toMatchObject({ archived: 99, archiveFailed: 1 });
    expect(m.archive).toHaveBeenCalledTimes(100);
    expect(store.rows).toHaveLength(6);
  });

  it("archives nothing when the unsubscribe itself fails", async () => {
    store.rows = [
      row({ listUnsubscribeUrl: null, listUnsubscribeMailto: "mailto:u@acme.example" }),
    ];
    m.sendEmail.mockResolvedValue({ error: "Gmail not connected." });
    const res = await post({
      sender: "news@acme.example",
      linkedInboxAccountId: null,
      archive: true,
    });
    expect(res.statusCode).toBe(502);
    expect(m.archive).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(1);
  });
});
