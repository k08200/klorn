import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

vi.mock("../email.js", () => ({ sendVerificationEmail: vi.fn(), sendPasswordResetEmail: vi.fn() }));
vi.mock("../gmail.js", () => ({
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
}));
vi.mock("../email-sync.js", () => ({
  syncEmails: vi.fn(async () => ({ synced: 0, newCount: 0, source: "gmail" })),
  reconcileEmails: vi.fn(async () => ({ removed: 0, updated: 0 })),
  summarizeUnsummarizedEmails: vi.fn(async () => 0),
  generateSmartReply: vi.fn(async () => "Reply"),
  classifyPriorityDetailed: vi.fn((from: string, subject: string, labels: string[] = []) => ({
    priority: from.includes("newsletter") ? "LOW" : "NORMAL",
    reason: labels.length > 0 ? "test_labels" : "test_default",
    signals: [subject],
  })),
  checkAutoReplyRules: vi.fn(async () => null),
  getEmailThreads: vi.fn(async () => ({ threads: [], total: 0 })),
}));
vi.mock("../push.js", () => ({ sendPushNotification: vi.fn() }));
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));

vi.mock("../db.js", () => {
  const prisma = {
    userToken: { findFirst: vi.fn(async () => null) },
    emailMessage: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      groupBy: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    feedbackEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "reply-fb-1",
        ...data,
        createdAt: new Date("2026-05-03T00:00:00.000Z"),
      })),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    emailRule: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: "r1", name: "Rule", conditions: "{}" })),
      findFirst: vi.fn(async () => null),
    },
    emailLabelFeedback: {
      findMany: vi.fn(async () => []),
    },
    contact: { findFirst: vi.fn(async () => null) },
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

async function buildApp() {
  const { emailRoutes } = await import("../routes/email.js");
  const app = Fastify();
  await app.register(emailRoutes, { prefix: "/api/email" });
  return app;
}

describe("email routes (demo mode)", () => {
  it("returns demo emails when Gmail not connected", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().source).toBe("demo");
    expect(res.json().emails.length).toBeGreaterThan(0);
    await app.close();
  });

  it("returns demo email by id", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email/demo-1", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe("demo-1");
    await app.close();
  });

  it("filters demo emails by unread", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email?filter=unread",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    for (const email of res.json().emails) {
      expect(email.isRead).toBe(false);
    }
    await app.close();
  });

  it("filters synced emails by canonical needsReply", async () => {
    const { prisma } = await import("../db.js");
    vi.mocked(prisma.userToken.findFirst).mockResolvedValueOnce({
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
    });

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email?filter=reply-needed",
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.emailMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user-1", needsReply: true }),
      }),
    );
    await app.close();
  });

  it("returns demo stats summary", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email/stats/summary",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().source).toBe("demo");
    expect(res.json()).toHaveProperty("total");
    expect(res.json()).toHaveProperty("unread");
    await app.close();
  });

  it("returns demo threads", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email/threads", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().source).toBe("demo");
    await app.close();
  });

  it("exports candidate intake CSV", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email/candidates/export.csv",
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.body).toContain('"status","name","role"');
    await app.close();
  });

  it("rejects invalid candidate attention filter", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email/candidates?attention=unknown",
      headers: auth(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid candidate attention filter");
    await app.close();
  });

  it("rejects invalid candidate list status", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email/candidates?status=DONEISH",
      headers: auth(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid candidate intake status");
    await app.close();
  });

  it("rejects invalid candidate CSV attention filter", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email/candidates/export.csv?attention=unknown",
      headers: auth(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid candidate attention filter");
    await app.close();
  });

  it("rejects invalid bulk candidate intake status", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/candidates/bulk-status",
      headers: auth(),
      payload: { emailIds: ["email-1"], status: "DONEISH" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid candidate intake status");
    await app.close();
  });

  it("marks selected synced emails as read in bulk", async () => {
    const { prisma } = await import("../db.js");
    const email = {
      id: "email-1",
      userId: "user-1",
      gmailId: "gmail-1",
      threadId: "thread-1",
      from: "sarah@example.com",
      to: "me@example.com",
      cc: null,
      subject: "Can you send the deck?",
      snippet: "Can you send the deck?",
      body: "Can you send the deck?",
      htmlBody: null,
      labels: ["INBOX"],
      isRead: false,
      isStarred: false,
      priority: "NORMAL",
      category: "conversation",
      summary: "Sarah: deck 요청",
      keyPoints: null,
      actionItems: JSON.stringify(["덱 보내기"]),
      needsReply: true,
      needsReplyReason: null,
      needsReplyConfidence: 0.8,
      sentiment: "neutral",
      receivedAt: new Date("2026-05-03T00:00:00.000Z"),
      syncedAt: new Date("2026-05-03T00:00:00.000Z"),
      createdAt: new Date("2026-05-03T00:00:00.000Z"),
      updatedAt: new Date("2026-05-03T00:00:00.000Z"),
    };
    vi.mocked(prisma.emailMessage.findMany).mockResolvedValueOnce([email]);
    vi.mocked(prisma.emailMessage.updateMany).mockResolvedValueOnce({ count: 1 });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/bulk",
      headers: auth(),
      payload: { ids: ["email-1"], action: "mark-read" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, updatedCount: 1 });
    expect(prisma.emailMessage.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", id: { in: ["email-1"] } },
      data: { isRead: true },
    });
    await app.close();
  });

  it("rejects invalid bulk email priority", async () => {
    const { prisma } = await import("../db.js");
    vi.mocked(prisma.emailMessage.findMany).mockResolvedValueOnce([
      { id: "email-1", gmailId: "g1" },
    ]);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/bulk",
      headers: auth(),
      payload: { ids: ["email-1"], action: "set-priority", priority: "NOW" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid email priority");
    await app.close();
  });

  it("toggles a synced email star from the detail action", async () => {
    const { prisma } = await import("../db.js");
    vi.mocked(prisma.emailMessage.findFirst).mockResolvedValueOnce({
      id: "email-1",
      gmailId: "gmail-1",
      userId: "user-1",
      isStarred: false,
    });

    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/email/email-1/star",
      headers: auth(),
      payload: { isStarred: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true });
    expect(prisma.emailMessage.update).toHaveBeenCalledWith({
      where: { id: "email-1" },
      data: { isStarred: true },
    });
    await app.close();
  });

  it("requires auth for synced email detail mutations", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/email/email-1/star",
      payload: { isStarred: true },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Authentication required");
    await app.close();
  });

  it("returns not found for missing synced email detail mutations", async () => {
    const { prisma } = await import("../db.js");
    vi.mocked(prisma.emailMessage.findFirst).mockResolvedValueOnce(null);

    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/email/missing-email/star",
      headers: auth(),
      payload: { isStarred: true },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Email not found");
    await app.close();
  });

  it("evaluates user feedback fixtures against the current heuristic", async () => {
    const { prisma } = await import("../db.js");
    vi.mocked(prisma.emailLabelFeedback.findMany).mockResolvedValueOnce([
      {
        id: "fb-1",
        originalPriority: "LOW",
        correctedPriority: "NORMAL",
        reason: "newsletter_sender",
        signals: ["newsletter@example.com"],
        fromAddress: "newsletter@example.com",
        subject: "Weekly digest",
        labels: ["INBOX"],
        note: null,
        createdAt: new Date("2026-04-28T00:00:00.000Z"),
      },
    ]);

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email/feedback/eval?limit=10",
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      total: 1,
      matched: 0,
      mismatched: 1,
      stillMatchesCapturedHeuristic: 1,
      changedButStillMismatched: 0,
      nowMatchesUser: 0,
    });
    expect(res.json().mismatches[0]).toMatchObject({
      id: "feedback-fb-1",
      expectedPriority: "NORMAL",
      actualPriority: "LOW",
      capturedPriority: "LOW",
      status: "still_matches_captured_heuristic",
    });
    await app.close();
  });

  it("captures reply-needed feedback for synced emails", async () => {
    const { prisma } = await import("../db.js");
    vi.mocked(prisma.emailMessage.findFirst).mockResolvedValueOnce({
      id: "email-1",
      userId: "user-1",
      gmailId: "gmail-1",
      threadId: "thread-1",
      from: "sarah@example.com",
      to: "me@example.com",
      cc: null,
      subject: "Can you send the deck?",
      snippet: "Can you send the deck?",
      body: "Can you send the deck?",
      htmlBody: null,
      labels: ["INBOX"],
      isRead: false,
      isStarred: false,
      priority: "NORMAL",
      category: "conversation",
      summary: "Sarah: deck 요청",
      keyPoints: null,
      actionItems: JSON.stringify(["덱 보내기"]),
      sentiment: "neutral",
      receivedAt: new Date("2026-05-03T00:00:00.000Z"),
      syncedAt: new Date("2026-05-03T00:00:00.000Z"),
      createdAt: new Date("2026-05-03T00:00:00.000Z"),
      updatedAt: new Date("2026-05-03T00:00:00.000Z"),
    });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/email-1/reply-needed/feedback",
      headers: auth(),
      payload: { choice: "not_needed" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().feedback).toMatchObject({
      emailId: "email-1",
      choice: "not_needed",
      signal: "REJECTED",
      inferredNeedsReply: true,
    });
    expect(prisma.feedbackEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: "ATTENTION_ITEM",
          sourceId: "email:email-1:reply_needed",
          signal: "REJECTED",
          toolName: "reply_needed",
        }),
      }),
    );
    await app.close();
  });

  it("returns latest reply-needed feedback", async () => {
    const { prisma } = await import("../db.js");
    vi.mocked(prisma.emailMessage.findFirst).mockResolvedValueOnce({ id: "email-1" });
    vi.mocked(prisma.feedbackEvent.findFirst).mockResolvedValueOnce({
      id: "reply-fb-1",
      signal: "APPROVED",
      evidence: null,
      createdAt: new Date("2026-05-03T00:00:00.000Z"),
    });

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email/email-1/reply-needed/feedback",
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().feedback).toMatchObject({
      id: "reply-fb-1",
      choice: "needed",
      signal: "APPROVED",
    });
    await app.close();
  });
});
