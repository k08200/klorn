/**
 * POST /api/email/:id/summarize — on-demand detailed re-summary of one email.
 * Focus: ownership scoping, LLM error mapping (cost cap / providers / user
 * rate), and the no-provider degradation — the route must never bare-500.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const summarizeEmailOnDemand = vi.hoisted(() => vi.fn());
const summarizeUnsummarizedEmails = vi.hoisted(() => vi.fn());
const emailFindFirst = vi.hoisted(() => vi.fn());

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
  summarizeUnsummarizedEmails,
  generateSmartReply: vi.fn(async () => "Reply"),
  classifyPriorityDetailed: vi.fn(() => ({ priority: "NORMAL", reason: "t", signals: [] })),
  checkAutoReplyRules: vi.fn(async () => null),
  getEmailThreads: vi.fn(async () => ({ threads: [], total: 0 })),
}));
vi.mock("../mail/email-summarize.js", () => ({
  summarizeEmailOnDemand,
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

const TOKEN = signToken({ userId: "user-1", email: "t@e.com" });
const auth = () => ({ authorization: `Bearer ${TOKEN}` });

const EMAIL = {
  id: "e1",
  gmailId: "g1",
  userId: "user-1",
  from: "Paddle <sellers@paddle.com>",
  subject: "Re: KYC blocked",
  body: "long body",
};

const RESULT = {
  summary: "Paddle: KYC manual review in progress, update pending",
  category: "business",
  keyPoints: ["Proof-of-address rejected twice", "Manual review requested"],
  actionItems: ["Wait for Paddle update"],
  sentiment: "neutral",
  priority: "NORMAL",
  needsReply: false,
  needsReplyReason: null,
};

async function buildApp() {
  const { emailRoutes } = await import("../routes/email.js");
  const app = Fastify();
  await app.register(emailRoutes, { prefix: "/api/email" });
  return app;
}

beforeEach(() => {
  summarizeUnsummarizedEmails.mockReset();
  summarizeUnsummarizedEmails.mockResolvedValue(0);
  summarizeEmailOnDemand.mockReset();
  emailFindFirst.mockReset();
  emailFindFirst.mockResolvedValue(EMAIL);
  summarizeEmailOnDemand.mockResolvedValue(RESULT);
});

describe("POST /api/email/:id/summarize", () => {
  it("returns the detailed summary fields for an owned email", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e1/summarize",
      headers: auth(),
      payload: { lang: "ko" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      summary: RESULT.summary,
      keyPoints: RESULT.keyPoints,
      actionItems: RESULT.actionItems,
    });
    // Ownership is enforced in the query, not post-hoc.
    expect(emailFindFirst.mock.calls[0][0].where.userId).toBe("user-1");
    // The requested language reaches the summarizer.
    expect(summarizeEmailOnDemand.mock.calls[0][2]).toBe("ko");
    await app.close();
  });

  it("defaults to English when lang is missing or unknown", async () => {
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/email/e1/summarize",
      headers: auth(),
      payload: { lang: "fr" },
    });
    expect(summarizeEmailOnDemand.mock.calls[0][2]).toBe("en");
    await app.close();
  });

  it("404s on an email the user does not own", async () => {
    emailFindFirst.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/other/summarize",
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("503s with a clear message when no AI provider is configured", async () => {
    summarizeEmailOnDemand.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e1/summarize",
      headers: auth(),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/provider/i);
    await app.close();
  });

  it("maps the daily cost cap to 429 with the cap message", async () => {
    const err = new Error("Daily AI budget reached — resets at midnight UTC.");
    err.name = "DailyCostCapExceededError";
    summarizeEmailOnDemand.mockRejectedValue(err);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e1/summarize",
      headers: auth(),
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toMatch(/budget/);
    expect(res.json().code).toBe("DAILY_COST_CAP");
    await app.close();
  });

  it("carries DAILY_COST_CAP_FREE when the free cap refused the call", async () => {
    const err = Object.assign(new Error("Free quota used for today."), {
      name: "DailyCostCapExceededError",
      code: "DAILY_COST_CAP_FREE",
    });
    summarizeEmailOnDemand.mockRejectedValue(err);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e1/summarize",
      headers: auth(),
    });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({
      error: "Free quota used for today.",
      code: "DAILY_COST_CAP_FREE",
    });
    await app.close();
  });

  it("bulk POST /summarize (free-tier reachable, no route catch) answers the same 429 via the global handler", async () => {
    summarizeUnsummarizedEmails.mockRejectedValue(
      Object.assign(new Error("Free quota used for today."), {
        name: "DailyCostCapExceededError",
        code: "DAILY_COST_CAP_FREE",
      }),
    );
    const { handleError } = await import("../error-handler.js");
    const { emailRoutes } = await import("../routes/email.js");
    const app = Fastify();
    app.setErrorHandler(handleError);
    await app.register(emailRoutes, { prefix: "/api/email" });
    const res = await app.inject({
      method: "POST",
      url: "/api/email/summarize",
      headers: auth(),
      payload: {},
    });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({
      error: "Free quota used for today.",
      code: "DAILY_COST_CAP_FREE",
    });
    await app.close();
  });

  it("maps a user rate-limit trip to 429 with Retry-After", async () => {
    const err = new Error("Slow down") as Error & { retryAfterMs: number };
    err.name = "UserRateLimitedError";
    err.retryAfterMs = 4000;
    summarizeEmailOnDemand.mockRejectedValue(err);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e1/summarize",
      headers: auth(),
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("4");
    await app.close();
  });

  it("maps any other LLM failure to 503, never a bare 500", async () => {
    summarizeEmailOnDemand.mockRejectedValue(new Error("socket hang up"));
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e1/summarize",
      headers: auth(),
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});
