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
  unarchiveEmail: vi.fn(async () => ({ success: true })),
  untrashEmail: vi.fn(async () => ({ success: true })),
}));
vi.mock("../email-sync.js", () => ({
  syncEmails: vi.fn(async () => ({ synced: 0, newCount: 0, source: "gmail" })),
  syncEmailByGmailId: vi.fn(async () => ({
    synced: 1,
    newCount: 1,
    emailId: "email-1",
    source: "gmail",
  })),
  reconcileEmails: vi.fn(async () => ({ removed: 0, updated: 0 })),
  syncLinkedInboxesForUser: vi.fn(async () => ({ newCount: 0 })),
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
    task: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "task-new",
        status: "TODO",
        ...data,
      })),
    },
    attentionItem: { upsert: vi.fn(async () => ({})) },
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

  it("force-sync returns immediately and runs reconcile in the background", async () => {
    const emailSync = await import("../email-sync.js");
    const app = await buildApp();
    vi.mocked(emailSync.reconcileEmails).mockClear();
    // A reconcile that never resolves. The route attaches its .catch
    // synchronously, so this produces no unhandled rejection; and if /sync still
    // awaited reconcile, this request would hang until the 60s test timeout.
    // It must not — the response depends only on syncEmails.
    vi.mocked(emailSync.reconcileEmails).mockReturnValueOnce(new Promise<never>(() => {}));

    const res = await app.inject({
      method: "POST",
      url: "/api/email/sync",
      headers: auth(),
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ synced: 0, newCount: 0, source: "gmail" });
    // Reconcile output is no longer part of the sync response contract.
    expect(body).not.toHaveProperty("removed");
    expect(body).not.toHaveProperty("updated");
    // ...but reconcile is still kicked off (fire-and-forget cleanup).
    expect(emailSync.reconcileEmails).toHaveBeenCalledWith("user-1");
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

  it("returns the next demo email in the same queue", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email/demo-1/next?queue=unread",
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      queue: "unread",
      next: { id: "demo-3", isRead: false },
    });
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

  it("returns the next synced email in the same triage queue", async () => {
    const { prisma } = await import("../db.js");
    const current = {
      id: "email-1",
      gmailId: "gmail-1",
      userId: "user-1",
      receivedAt: new Date("2026-05-03T12:00:00.000Z"),
    };
    const next = {
      id: "email-2",
      gmailId: "gmail-2",
      userId: "user-1",
      from: "ops@example.com",
      subject: "Next unread",
      receivedAt: new Date("2026-05-03T11:00:00.000Z"),
      isRead: false,
      priority: "NORMAL",
      category: "business",
      actionItems: JSON.stringify(["follow up"]),
      needsReply: true,
    };
    vi.mocked(prisma.emailMessage.findFirst)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(next);

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email/email-1/next?queue=unread",
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      queue: "unread",
      next: { id: "email-2", subject: "Next unread", needsReply: true },
    });
    expect(prisma.emailMessage.findFirst).toHaveBeenLastCalledWith({
      where: {
        AND: [
          { userId: "user-1", isRead: false },
          {
            OR: [
              { receivedAt: { lt: current.receivedAt } },
              { receivedAt: current.receivedAt, id: { lt: "email-1" } },
            ],
          },
        ],
      },
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
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

  it("restores an archived Gmail email and resyncs it locally", async () => {
    const gmail = await import("../gmail.js");
    const emailSync = await import("../email-sync.js");
    vi.mocked(gmail.unarchiveEmail).mockClear();
    vi.mocked(emailSync.syncEmailByGmailId).mockClear();

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/email-1/archive/undo",
      headers: auth(),
      payload: { gmailId: "gmail-1" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, gmailId: "gmail-1", emailId: "email-1" });
    expect(gmail.unarchiveEmail).toHaveBeenCalledWith("user-1", "gmail-1", null);
    // Resync must carry the linked-account id (null here = primary) so an undo on
    // a linked inbox re-fetches from that account, not the primary.
    expect(emailSync.syncEmailByGmailId).toHaveBeenCalledWith("user-1", "gmail-1", null);
    await app.close();
  });

  it("restores a trashed Gmail email and resyncs it locally", async () => {
    const gmail = await import("../gmail.js");
    const emailSync = await import("../email-sync.js");
    vi.mocked(gmail.untrashEmail).mockClear();
    vi.mocked(emailSync.syncEmailByGmailId).mockClear();

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/gmail-2/delete/undo",
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, gmailId: "gmail-2", emailId: "email-1" });
    expect(gmail.untrashEmail).toHaveBeenCalledWith("user-1", "gmail-2", null);
    expect(emailSync.syncEmailByGmailId).toHaveBeenCalledWith("user-1", "gmail-2", null);
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

describe("emailSearchOr — search query builder", () => {
  function collectKeys(node: unknown, keys: Set<string>) {
    if (Array.isArray(node)) {
      for (const item of node) collectKeys(item, keys);
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        keys.add(k);
        collectKeys(v, keys);
      }
    }
  }

  it("searches the scalar text columns and attachment text columns", async () => {
    const { emailSearchOr } = await import("../routes/email.js");
    const keys = new Set<string>();
    collectKeys(emailSearchOr("invoice"), keys);
    for (const col of ["subject", "from", "snippet", "body", "summary", "attachments"]) {
      expect(keys.has(col)).toBe(true);
    }
    for (const col of ["filename", "contentText"]) {
      expect(keys.has(col)).toBe(true);
    }
  });

  it("never filters the JSONB extractedFields column (a String filter there 500s the query)", async () => {
    const { emailSearchOr } = await import("../routes/email.js");
    const keys = new Set<string>();
    collectKeys(emailSearchOr("anything"), keys);
    expect(keys.has("extractedFields")).toBe(false);
  });

  it("threads the search term into a case-insensitive contains filter", async () => {
    const { emailSearchOr } = await import("../routes/email.js");
    const [subjectCond] = emailSearchOr("Q3 report");
    expect(subjectCond).toEqual({ subject: { contains: "Q3 report", mode: "insensitive" } });
  });
});

describe("POST /api/email/:id/create-tasks — dedup via createTask", () => {
  it("skips an action item that duplicates an existing open task (no raw create)", async () => {
    const { prisma } = await import("../db.js");
    vi.mocked(prisma.emailMessage.findFirst).mockResolvedValueOnce({
      id: "email-1",
      subject: "Re: Sarah",
      actionItems: JSON.stringify(["Reply to Sarah about the deck"]),
      receivedAt: new Date(),
    } as never);
    // An existing open task with a near-identical title → createTask must dedup.
    vi.mocked(prisma.task.findMany).mockResolvedValueOnce([
      {
        id: "task-existing",
        title: "Reply to Sarah about the deck",
        status: "TODO",
        createdAt: new Date(),
      },
    ] as never);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/email-1/create-tasks",
      headers: auth(),
      payload: { indices: [0] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tasks).toEqual([]);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0].reason).toBe("duplicate");
    expect(body.skipped[0].existingTaskId).toBe("task-existing");
    // The dedup short-circuits before any insert — the bug this guards against
    // is the old path calling prisma.task.create directly and flooding dupes.
    expect(prisma.task.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("creates a task for a novel action item", async () => {
    const { prisma } = await import("../db.js");
    vi.mocked(prisma.emailMessage.findFirst).mockResolvedValueOnce({
      id: "email-2",
      subject: "New ask",
      actionItems: JSON.stringify(["Book the venue for the offsite"]),
      receivedAt: new Date(),
    } as never);
    vi.mocked(prisma.task.findMany).mockResolvedValueOnce([] as never);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/email-2/create-tasks",
      headers: auth(),
      payload: { indices: [0] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tasks).toHaveLength(1);
    expect(body.skipped).toEqual([]);
    expect(prisma.task.create).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
