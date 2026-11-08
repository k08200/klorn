/**
 * Decision-ledger outcome stamps on the email plugin's own routes:
 * GET /api/email/:id (a reader open) → OPENED, unless the caller says it is
 * fetching for another reason (?purpose=…, e.g. mobile Files reading
 * attachments); POST /:id/unsubscribe → UNSUBSCRIBED. Exactly once per
 * successful action, nothing on a miss, and the response is unchanged when
 * the ledger write fails.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const emailFindFirst = vi.hoisted(() => vi.fn());
const labelUpdateMany = vi.hoisted(() => vi.fn());
const unsubscribeFromEmail = vi.hoisted(() => vi.fn());

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
}));
vi.mock("../mail/email-sync.js", () => ({
  syncEmails: vi.fn(),
  syncEmailByGmailId: vi.fn(),
  reconcileEmails: vi.fn(),
  syncLinkedInboxesForUser: vi.fn(),
  summarizeUnsummarizedEmails: vi.fn(),
  generateSmartReply: vi.fn(),
  classifyPriorityDetailed: vi.fn(() => ({ priority: "NORMAL", reason: "t", signals: [] })),
  checkAutoReplyRules: vi.fn(),
  getEmailThreads: vi.fn(),
}));
vi.mock("../mail/email-attachments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mail/email-attachments.js")>()),
  listEmailAttachments: vi.fn(async () => []),
  buildAttachmentCandidateProfile: vi.fn(() => null),
}));
vi.mock("../learning/trust-score.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../learning/trust-score.js")>()),
  getTrustScore: vi.fn(async () => null),
}));
vi.mock("../learning/interaction-graph.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../learning/interaction-graph.js")>()),
  getCachedInteractionNode: vi.fn(async () => null),
}));
vi.mock("../mail/unsubscribe-action.js", () => ({ unsubscribeFromEmail }));
vi.mock("../notify/push.js", () => ({ sendPushNotification: vi.fn() }));
vi.mock("../mail/meeting-context.js", () => ({ getMeetingContext: vi.fn(async () => null) }));
vi.mock("../user-timezone.js", () => ({ getUserTimeZone: vi.fn(async () => "Asia/Seoul") }));
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../billing/entitlement-guard.js", () => ({
  requireEntitled: vi.fn(async () => {}),
  requireAppAccess: vi.fn(async () => {}),
}));

vi.mock("../db.js", () => {
  const prisma = {
    userToken: { findFirst: vi.fn(async () => null) },
    emailMessage: {
      findMany: vi.fn(async () => []),
      findFirst: emailFindFirst,
      count: vi.fn(async () => 0),
    },
    decisionLabel: { updateMany: labelUpdateMany },
    linkedInboxAccount: { findMany: vi.fn(async () => []) },
    user: { findUnique: vi.fn(async () => ({ id: "user-1", plan: "FREE", role: "USER" })) },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});

import { captureError } from "../sentry.js";

const TOKEN = signToken({ userId: "user-1", email: "t@e.com" });
const headers = { authorization: `Bearer ${TOKEN}` };

const EMAIL = {
  id: "e1",
  gmailId: "g1",
  userId: "user-1",
  threadId: "t1",
  from: "Ana <ana@acme.example>",
  to: "me@example.com",
  cc: null,
  subject: "Contract",
  snippet: "Please sign",
  body: "Please sign the contract.",
  htmlBody: null,
  receivedAt: new Date("2026-10-25T01:00:00Z"),
  labels: [],
  isRead: false,
  isStarred: false,
  actionItems: null,
  keyPoints: null,
  linkedInboxAccountId: null,
  listUnsubscribeMailto: null,
  listUnsubscribeUrl: "https://acme.example/u",
  listUnsubscribeOneClick: true,
};

async function buildApp() {
  const { emailRoutes } = await import("../routes/email.js");
  const app = Fastify();
  await app.register(emailRoutes, { prefix: "/api/email" });
  return app;
}

async function stamps() {
  await new Promise((r) => setTimeout(r, 0));
  return labelUpdateMany.mock.calls.map((c) => c[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  emailFindFirst.mockResolvedValue(EMAIL);
  labelUpdateMany.mockResolvedValue({ count: 1 });
  unsubscribeFromEmail.mockResolvedValue({ ok: true, body: { method: "one-click", done: true } });
});

describe("GET /api/email/:id", () => {
  it("stamps OPENED on the user's row exactly once", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email/g1", headers });

    expect(res.statusCode).toBe(200);
    expect(await stamps()).toEqual([
      {
        where: { userId: "user-1", source: "EMAIL", sourceId: "e1", openedAt: null },
        data: { openedAt: expect.any(Date) },
      },
    ]);
  });

  it("answers while the ledger write is still hanging", async () => {
    labelUpdateMany.mockReturnValue(new Promise(() => {}));
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email/e1", headers });
    expect(res.statusCode).toBe(200);
  });

  it("does not stamp a fetch that names another purpose (mobile Files reading attachments)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email/e1?purpose=attachments",
      headers,
    });

    expect(res.statusCode).toBe(200);
    expect(await stamps()).toEqual([]);
  });

  it("answers exactly the same when the ledger write fails", async () => {
    const app = await buildApp();
    const ok = await app.inject({ method: "GET", url: "/api/email/e1", headers });
    labelUpdateMany.mockRejectedValue(new Error("ledger down"));
    const failed = await app.inject({ method: "GET", url: "/api/email/e1", headers });

    expect(failed.statusCode).toBe(200);
    expect(failed.body).toBe(ok.body);
    await vi.waitFor(() => expect(captureError).toHaveBeenCalled());
  });
});

describe("POST /api/email/:id/unsubscribe", () => {
  it("stamps UNSUBSCRIBED exactly once on success", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/email/e1/unsubscribe", headers });

    expect(res.statusCode).toBe(200);
    const calls = await stamps();
    expect(calls).toHaveLength(1);
    expect(calls[0].where).toEqual({
      userId: "user-1",
      source: "EMAIL",
      sourceId: "e1",
      unsubscribedAt: null,
    });
  });

  it("stamps nothing when only a browser link was handed back (not unsubscribed yet)", async () => {
    unsubscribeFromEmail.mockResolvedValue({
      ok: true,
      body: { method: "link", done: false, url: "https://acme.example/u" },
    });
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/email/e1/unsubscribe", headers });

    expect(res.statusCode).toBe(200);
    expect(await stamps()).toEqual([]);
  });

  it("stamps nothing when the unsubscribe fails", async () => {
    unsubscribeFromEmail.mockResolvedValue({ ok: false, statusCode: 400, error: "No targets" });
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/email/e1/unsubscribe", headers });

    expect(res.statusCode).toBe(400);
    expect(await stamps()).toEqual([]);
  });

  it("answers exactly the same when the ledger write fails", async () => {
    const app = await buildApp();
    const ok = await app.inject({ method: "POST", url: "/api/email/e1/unsubscribe", headers });
    labelUpdateMany.mockRejectedValue(new Error("ledger down"));
    const failed = await app.inject({ method: "POST", url: "/api/email/e1/unsubscribe", headers });

    expect(failed.statusCode).toBe(ok.statusCode);
    expect(failed.body).toBe(ok.body);
  });
});
