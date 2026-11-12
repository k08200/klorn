/**
 * Decision-ledger outcome stamps on the single-item mutation routes:
 * mark-read → OPENED, star → STARRED, archive and trash → ARCHIVED. Each
 * successful action stamps the acting user's row exactly once; a refused
 * action stamps nothing; and a failing ledger write leaves the response
 * byte-for-byte unchanged.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const db = vi.hoisted(() => ({
  emailFindFirst: vi.fn(),
  emailDeleteMany: vi.fn(async () => ({ count: 1 })),
  emailUpdate: vi.fn(async () => ({})),
  linkedFindFirst: vi.fn(),
  labelUpdateMany: vi.fn(),
  noteEmailBellRowsRead: vi.fn(),
}));

const gmail = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  createEmailDraft: vi.fn(),
  getReplyHeaders: vi.fn(),
  markAsRead: vi.fn(),
  toggleReadGmail: vi.fn(async () => ({ success: true })),
  toggleStarGmail: vi.fn(async () => ({ success: true })),
  trashEmail: vi.fn(async () => ({ success: true })),
  untrashEmail: vi.fn(),
  archiveEmail: vi.fn(async () => ({ success: true })),
  unarchiveEmail: vi.fn(),
}));

vi.mock("../db.js", () => {
  const prisma = {
    emailMessage: {
      findFirst: db.emailFindFirst,
      deleteMany: db.emailDeleteMany,
      update: db.emailUpdate,
    },
    linkedInboxAccount: { findFirst: db.linkedFindFirst },
    decisionLabel: { updateMany: db.labelUpdateMany },
    user: {
      findUnique: vi.fn(async () => ({
        id: "user-1",
        email: "test@example.com",
        role: "USER",
        sessionsInvalidatedAt: null,
      })),
    },
    device: {
      findUnique: vi.fn(async () => ({
        id: "device-1",
        lastActiveAt: new Date(),
        createdAt: new Date(),
      })),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../mail/gmail.js", () => gmail);
vi.mock("../mail/email-sync.js", () => ({
  syncEmailByGmailId: vi.fn(async () => ({ synced: true, emailId: "e1" })),
}));
vi.mock("../analytics.js", () => ({ recordEvent: vi.fn() }));
vi.mock("../notify/email-bell.js", () => ({ noteEmailBellRowsRead: db.noteEmailBellRowsRead }));
vi.mock("../learning/contact-engagement.js", () => ({
  recordContactEngagement: vi.fn(async () => {}),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../billing/entitlement-guard.js", () => ({
  requireEntitled: vi.fn(async () => {}),
}));
vi.mock("../routes/email.js", () => ({
  safeAttachmentFilename: (name: string) => name,
}));

import { captureError } from "../sentry.js";

const TOKEN = signToken({ userId: "user-1", email: "test@example.com" });
const headers = { authorization: `Bearer ${TOKEN}` };

async function buildApp() {
  const { registerEmailMutationsRoutes } = await import("../routes/email-mutations.js");
  const app = Fastify();
  await app.register(registerEmailMutationsRoutes, { prefix: "/api/email" });
  return app;
}

const PRIMARY_EMAIL = { id: "e-google", gmailId: "gm-1", linkedInboxAccountId: null };
const NAVER_EMAIL = {
  id: "e-naver",
  gmailId: "naver-imap:me@naver.com:42",
  linkedInboxAccountId: "acc-naver",
};

/** Every ledger stamp the request produced, flushed past fire-and-forget. */
async function stamps() {
  await new Promise((r) => setTimeout(r, 0));
  return db.labelUpdateMany.mock.calls.map((c) => c[0]);
}

function expectOneStamp(calls: Array<{ where: object; data: object }>, column: string) {
  expect(calls).toHaveLength(1);
  expect(calls[0].where).toEqual({
    userId: "user-1",
    source: "EMAIL",
    sourceId: "e-google",
    [column]: null,
  });
  expect(Object.keys(calls[0].data)).toEqual([column]);
}

type Case = { name: string; method: "PATCH" | "POST" | "DELETE"; url: string; body?: object };

const STAMPING: Array<Case & { column: string }> = [
  {
    name: "mark read",
    method: "PATCH",
    url: "/api/email/e-google/read",
    body: { isRead: true },
    column: "openedAt",
  },
  {
    name: "star",
    method: "PATCH",
    url: "/api/email/e-google/star",
    body: { isStarred: true },
    column: "starredAt",
  },
  { name: "archive", method: "POST", url: "/api/email/e-google/archive", column: "archivedAt" },
  { name: "trash", method: "DELETE", url: "/api/email/e-google", column: "archivedAt" },
];

describe("mutation routes stamp the decision ledger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.emailFindFirst.mockResolvedValue(PRIMARY_EMAIL);
    db.labelUpdateMany.mockResolvedValue({ count: 1 });
  });

  it.each(STAMPING)("$name stamps $column exactly once", async ({ method, url, body, column }) => {
    const app = await buildApp();
    const res = await app.inject({ method, url, headers, ...(body ? { payload: body } : {}) });

    expect(res.statusCode).toBe(200);
    expectOneStamp(await stamps(), column);
  });

  it.each(STAMPING)("$name answers exactly the same when the ledger write fails", async ({
    method,
    url,
    body,
  }) => {
    const app = await buildApp();
    const ok = await app.inject({ method, url, headers, ...(body ? { payload: body } : {}) });
    db.labelUpdateMany.mockRejectedValue(new Error("ledger down"));
    const failed = await app.inject({ method, url, headers, ...(body ? { payload: body } : {}) });

    expect(failed.statusCode).toBe(ok.statusCode);
    expect(failed.body).toBe(ok.body);
    await vi.waitFor(() => expect(captureError).toHaveBeenCalled());
  });

  it.each(STAMPING)("$name answers while the ledger write is still hanging", async ({
    method,
    url,
    body,
  }) => {
    db.labelUpdateMany.mockReturnValue(new Promise(() => {}));
    const app = await buildApp();
    const res = await app.inject({ method, url, headers, ...(body ? { payload: body } : {}) });
    expect(res.statusCode).toBe(200);
  });

  it("stamps ARCHIVED on the local-only archive fallback too", async () => {
    gmail.archiveEmail.mockResolvedValueOnce({ error: "Gmail not connected." } as never);
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/email/e-google/archive", headers });

    expect(res.json()).toMatchObject({ warning: "Gmail not connected, removed locally only" });
    expectOneStamp(await stamps(), "archivedAt");
  });

  it("does not stamp mark-unread or unstar", async () => {
    const app = await buildApp();
    await app.inject({
      method: "PATCH",
      url: "/api/email/e-google/read",
      headers,
      payload: { isRead: false },
    });
    await app.inject({
      method: "PATCH",
      url: "/api/email/e-google/star",
      headers,
      payload: { isStarred: false },
    });

    expect(await stamps()).toEqual([]);
  });

  it("does not stamp a refused archive or trash", async () => {
    db.emailFindFirst.mockResolvedValue(NAVER_EMAIL);
    db.linkedFindFirst.mockResolvedValue({ provider: "NAVER" });
    const app = await buildApp();
    const archive = await app.inject({
      method: "POST",
      url: "/api/email/e-naver/archive",
      headers,
    });
    const trash = await app.inject({ method: "DELETE", url: "/api/email/e-naver", headers });

    expect([archive.statusCode, trash.statusCode]).toEqual([501, 501]);
    expect(await stamps()).toEqual([]);
  });

  it("does not stamp a mail the user doesn't own", async () => {
    db.emailFindFirst.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/email/not-mine/archive", headers });

    expect(res.statusCode).toBe(404);
    expect(await stamps()).toEqual([]);
  });
});

describe("PATCH /api/email/:id/read settles the mail's bell rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.emailFindFirst.mockResolvedValue(PRIMARY_EMAIL);
    db.labelUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("marking a mail read marks the user's bell rows about it read", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/email/e-google/read",
      headers,
      payload: { isRead: true },
    });

    expect(res.statusCode).toBe(200);
    expect(db.noteEmailBellRowsRead).toHaveBeenCalledTimes(1);
    expect(db.noteEmailBellRowsRead).toHaveBeenCalledWith("user-1", PRIMARY_EMAIL);
  });

  it("mark-unread leaves the bell alone", async () => {
    const app = await buildApp();
    await app.inject({
      method: "PATCH",
      url: "/api/email/e-google/read",
      headers,
      payload: { isRead: false },
    });
    expect(db.noteEmailBellRowsRead).not.toHaveBeenCalled();
  });

  it("a mail the user doesn't own changes nothing", async () => {
    db.emailFindFirst.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/email/not-mine/read",
      headers,
      payload: { isRead: true },
    });
    expect(res.statusCode).toBe(404);
    expect(db.noteEmailBellRowsRead).not.toHaveBeenCalled();
  });
});
