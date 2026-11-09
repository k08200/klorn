/**
 * POST /api/email/:id/later — the in-app "Later" (Mail v2 rows, the reader,
 * the legacy list, the Today cards). Session-authenticated, scoped to the
 * user's own mail, a narrow validated body, a per-user rate limit, and the
 * reminder written by the same service the web push Later uses.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const setMailReminder = vi.hoisted(() => vi.fn());
vi.mock("../pim/mail-reminder.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pim/mail-reminder.js")>()),
  setMailReminder,
}));

const emailFindFirst = vi.hoisted(() => vi.fn());
const labelUpdateMany = vi.hoisted(() => vi.fn(async (_args: unknown) => ({ count: 1 })));
const dbTransaction = vi.hoisted(() => vi.fn(async (ops: unknown[]) => Promise.all(ops)));

vi.mock("../mail/email.js", () => ({
  sendVerificationEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
}));
vi.mock("../mail/gmail.js", () => ({
  getAuthUrl: vi.fn(),
  getLoginAuthUrl: vi.fn(),
  getGoogleUserInfo: vi.fn(),
  getOAuth2Client: vi.fn(),
  getAuthedClient: vi.fn(async () => null),
  createEmailDraft: vi.fn(async () => ({ success: true, draftId: "draft-1" })),
  sendEmail: vi.fn(async () => ({ success: true })),
  toggleReadGmail: vi.fn(async () => {}),
  toggleStarGmail: vi.fn(async () => {}),
  trashEmail: vi.fn(async () => ({ success: true })),
  archiveEmail: vi.fn(async () => ({ success: true })),
  unarchiveEmail: vi.fn(async () => ({ success: true })),
  untrashEmail: vi.fn(async () => ({ success: true })),
}));
vi.mock("../mail/email-sync.js", () => ({
  syncEmails: vi.fn(async () => ({ synced: 0, newCount: 0, source: "gmail" })),
  syncEmailByGmailId: vi.fn(async () => ({ synced: 1, newCount: 1, emailId: "email-1" })),
  reconcileEmails: vi.fn(async () => ({ removed: 0, updated: 0 })),
  syncLinkedInboxesForUser: vi.fn(async () => ({ newCount: 0 })),
  summarizeUnsummarizedEmails: vi.fn(async () => 0),
  generateSmartReply: vi.fn(async () => "Reply"),
  classifyPriorityDetailed: vi.fn(() => ({ priority: "NORMAL", reason: "t", signals: [] })),
  checkAutoReplyRules: vi.fn(async () => null),
  getEmailThreads: vi.fn(async () => ({ threads: [], total: 0 })),
}));
vi.mock("../notify/push.js", () => ({ sendPushNotification: vi.fn() }));
vi.mock("../mail/meeting-context.js", () => ({ getMeetingContext: vi.fn(async () => null) }));
vi.mock("../user-timezone.js", () => ({ getUserTimeZone: vi.fn(async () => "Asia/Seoul") }));
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

vi.mock("../db.js", () => {
  const prisma = {
    userToken: { findFirst: vi.fn(async () => null) },
    emailMessage: {
      findMany: vi.fn(async () => []),
      findFirst: emailFindFirst,
      count: vi.fn(async () => 0),
      groupBy: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
    },
    $transaction: dbTransaction,
    // Later stamps SNOOZED on the decision ledger (judge/user-outcome.ts).
    decisionLabel: { updateMany: labelUpdateMany },
    linkedInboxAccount: { findMany: vi.fn(async () => []) },
    user: { findUnique: vi.fn(async () => ({ id: "user-1", plan: "FREE", role: "USER" })) },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});

const tokenFor = (userId: string) => signToken({ userId, email: `${userId}@e.com` });
const auth = (userId = "user-1") => ({ authorization: `Bearer ${tokenFor(userId)}` });

async function buildApp(withRateLimit = false) {
  const { emailRoutes } = await import("../routes/email.js");
  const app = Fastify();
  if (withRateLimit) {
    const { default: rateLimit } = await import("@fastify/rate-limit");
    // Same shape as index.ts: the app-wide limiter keys on the client address.
    await app.register(rateLimit, { max: 100_000, keyGenerator: () => "one-shared-ip" });
  }
  await app.register(emailRoutes, { prefix: "/api/email" });
  return app;
}

const NOW = new Date("2026-11-08T09:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const later = (
  app: Awaited<ReturnType<typeof buildApp>>,
  payload: unknown,
  opts: {
    id?: string;
    userId?: string | null;
  } = {},
) =>
  app.inject({
    method: "POST",
    url: `/api/email/${opts.id ?? "email-1"}/later`,
    headers: opts.userId === null ? {} : auth(opts.userId ?? "user-1"),
    payload: payload as object,
  });

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  setMailReminder.mockReset();
  setMailReminder.mockImplementation(async (_u: string, _e: string, at: Date) => ({
    ok: true,
    created: true,
    reminder: { id: "reminder-1", remindAt: at.toISOString() },
  }));
});

describe("POST /api/email/:id/later", () => {
  it("needs a session", async () => {
    const app = await buildApp();
    const res = await later(app, {}, { userId: null });
    expect(res.statusCode).toBe(401);
    expect(setMailReminder).not.toHaveBeenCalled();
    await app.close();
  });

  it("sets the reminder at the chosen time for the session user's mail", async () => {
    const app = await buildApp();
    const at = new Date(NOW.getTime() + DAY).toISOString();
    const res = await later(app, { remindAt: at });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      created: true,
      reminder: { id: "reminder-1", remindAt: at },
    });
    const [userId, emailId, remindAt, opts] = setMailReminder.mock.calls[0] ?? [];
    expect(userId).toBe("user-1");
    expect(emailId).toBe("email-1");
    expect((remindAt as Date).toISOString()).toBe(at);
    expect(opts).toEqual({ onPending: "move" });
    await app.close();
  });

  it("defaults to later today (four hours) without a time", async () => {
    const app = await buildApp();
    const res = await later(app, {});
    expect(res.statusCode).toBe(200);
    const remindAt = setMailReminder.mock.calls[0]?.[2] as Date;
    expect(remindAt.getTime()).toBe(NOW.getTime() + 4 * HOUR);
    await app.close();
  });

  it("answers 404 for a mail that is not the user's own", async () => {
    setMailReminder.mockResolvedValue({ ok: false });
    const app = await buildApp();
    const res = await later(app, {}, { id: "someone-elses" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Email not found" });
    await app.close();
  });

  it("refuses a time in the past, now, or more than 30 days out", async () => {
    const app = await buildApp();
    for (const remindAt of [
      new Date(NOW.getTime() - HOUR).toISOString(),
      NOW.toISOString(),
      new Date(NOW.getTime() + 30 * DAY + 60_000).toISOString(),
    ]) {
      const res = await later(app, { remindAt });
      expect(res.statusCode).toBe(400);
    }
    expect(setMailReminder).not.toHaveBeenCalled();
    await app.close();
  });

  it("accepts exactly 30 days out", async () => {
    const app = await buildApp();
    const res = await later(app, { remindAt: new Date(NOW.getTime() + 30 * DAY).toISOString() });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("refuses a malformed time", async () => {
    const app = await buildApp();
    for (const payload of [
      { remindAt: "tomorrow" },
      { remindAt: 12345 },
      { remindAt: "2026-11-09" },
      { remindAt: "2026-11-09T09:00:00" },
      { remindAt: "2026-11-09T09:00:00.000Z".repeat(3) },
    ]) {
      const res = await later(app, payload);
      expect(res.statusCode).toBe(400);
    }
    expect(setMailReminder).not.toHaveBeenCalled();
    await app.close();
  });

  it("takes no title or link from the client: extra fields never reach the reminder", async () => {
    const app = await buildApp();
    const at = new Date(NOW.getTime() + DAY).toISOString();
    const res = await later(app, {
      remindAt: at,
      title: "Pay now",
      description: "Open: https://evil.example",
    });
    expect(res.statusCode).toBe(200);
    const call = setMailReminder.mock.calls[0] ?? [];
    expect(call).toHaveLength(4);
    expect(JSON.stringify(call)).not.toContain("evil.example");
    expect(JSON.stringify(call)).not.toContain("Pay now");
    await app.close();
  });

  it("does not leak an internal error", async () => {
    setMailReminder.mockRejectedValue(new Error("connection to db.internal:5432 refused"));
    const app = await buildApp();
    const res = await later(app, {});
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("db.internal");
    expect(res.json()).toEqual({ error: "Could not set the reminder" });
    await app.close();
  });

  it("is rate limited per user, not per address", async () => {
    vi.useRealTimers();
    const app = await buildApp(true);
    const results = [];
    for (let i = 0; i < 31; i += 1) results.push(await later(app, {}));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(30);
    const limited = results.filter((r) => r.statusCode === 429);
    expect(limited).toHaveLength(1);
    expect(limited[0]?.json()).toMatchObject({ code: "rate-limited" });
    // Another user behind the same address still has a budget.
    expect((await later(app, {}, { userId: "user-2" })).statusCode).toBe(200);
    await app.close();
  });
});

describe("POST /api/email/:id/later — decision ledger", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    labelUpdateMany.mockReset();
    labelUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("stamps SNOOZED once on the user's mail when the reminder is set", async () => {
    const app = await buildApp();
    const res = await later(app, {});
    await flush();

    expect(res.statusCode).toBe(200);
    expect(labelUpdateMany.mock.calls.map((c) => c[0])).toEqual([
      {
        where: { userId: "user-1", source: "EMAIL", sourceId: "email-1", snoozedAt: null },
        data: { snoozedAt: expect.any(Date) },
      },
    ]);
    await app.close();
  });

  it("stamps nothing for a refused time or a mail that isn't the user's", async () => {
    const app = await buildApp();
    const past = await later(app, { remindAt: new Date(NOW.getTime() - HOUR).toISOString() });
    setMailReminder.mockResolvedValueOnce({ ok: false });
    const missing = await later(app, {}, { id: "not-mine" });
    await flush();

    expect([past.statusCode, missing.statusCode]).toEqual([400, 404]);
    expect(labelUpdateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("answers exactly the same when the ledger write fails, and while it hangs", async () => {
    const app = await buildApp();
    const ok = await later(app, {});
    labelUpdateMany.mockRejectedValueOnce(new Error("ledger down"));
    const failed = await later(app, {});
    labelUpdateMany.mockReturnValueOnce(new Promise(() => {}) as never);
    const hanging = await later(app, {});

    expect(failed.statusCode).toBe(ok.statusCode);
    expect(failed.body).toBe(ok.body);
    expect(hanging.body).toBe(ok.body);
    await app.close();
  });
});
