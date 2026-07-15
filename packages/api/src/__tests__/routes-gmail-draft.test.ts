/**
 * POST /api/email/:id/gmail-draft — write an AI/user-composed reply into
 * Gmail as a draft (optionally with the original's attachments re-attached).
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createEmailDraft = vi.hoisted(() => vi.fn());
const emailFindFirst = vi.hoisted(() => vi.fn());
const updateCandidateIntake = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../auth.js", () => ({
  requireAuth: async () => {},
  getUserId: () => "user-1",
}));
vi.mock("../db.js", () => {
  const prisma = {
    emailMessage: { findFirst: emailFindFirst },
    emailAttachment: { findMany: vi.fn(async () => []) },
  };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../llm/llm-credentials.js", () => ({ getUserLlmCredentials: vi.fn(async () => ({})) }));
vi.mock("../learning/voice-profile-extractor.js", () => ({
  buildVoicePromptHint: vi.fn(async () => ""),
}));
vi.mock("../llm/openai.js", () => ({ createCompletion: vi.fn(), DRAFT_MODEL: "test-draft-model" }));
vi.mock("../email-attachments.js", () => ({
  listEmailAttachments: vi.fn(async () => []),
  buildAttachmentCandidateProfile: vi.fn(() => null),
}));
vi.mock("../email-candidate-intake.js", () => ({ updateCandidateIntake }));
vi.mock("../gmail.js", () => ({
  createEmailDraft,
  sendEmail: vi.fn(),
  getReplyHeaders: vi.fn(),
  resolveMailClient: vi.fn(),
  GMAIL_TOOLS: [],
}));

import { registerEmailRepliesRoutes } from "../routes/email-replies.js";

const EMAIL = {
  id: "e1",
  gmailId: "g1",
  threadId: "t1",
  userId: "user-1",
  from: "Boss <boss@corp.com>",
  subject: "Need your reply today",
  summary: null,
  receivedAt: new Date("2026-07-01T00:00:00Z"),
};

async function buildApp() {
  const app = Fastify();
  await app.register(registerEmailRepliesRoutes, { prefix: "/api/email" });
  return app;
}

beforeEach(() => {
  createEmailDraft.mockReset();
  emailFindFirst.mockReset();
  updateCandidateIntake.mockClear();
  emailFindFirst.mockResolvedValue(EMAIL);
  createEmailDraft.mockResolvedValue({ success: true, draftId: "d1", messageId: "m1" });
});

describe("POST /api/email/:id/gmail-draft", () => {
  it("creates the draft with no linkedInboxAccountId for a primary-inbox message", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e1/gmail-draft",
      payload: { to: "boss@corp.com", subject: "Re: hi", body: "sounds good" },
    });
    expect(res.statusCode).toBe(200);
    const call = createEmailDraft.mock.calls[0];
    expect(call[0]).toBe("user-1");
    expect(call[4]).toBe("t1"); // threadId
    expect(call[6]).toBeUndefined(); // linkedInboxAccountId
    await app.close();
  });

  it("threads linkedInboxAccountId through to createEmailDraft for a message from a linked secondary inbox (#757)", async () => {
    emailFindFirst.mockResolvedValue({ ...EMAIL, linkedInboxAccountId: "linked-acct-1" });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e1/gmail-draft",
      payload: { to: "boss@corp.com", subject: "Re: hi", body: "sounds good" },
    });
    expect(res.statusCode).toBe(200);
    const call = createEmailDraft.mock.calls[0];
    expect(call[6]).toBe("linked-acct-1"); // linkedInboxAccountId
    await app.close();
  });

  it("400s when a required field is missing", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e1/gmail-draft",
      payload: { to: "boss@corp.com", body: "sounds good" },
    });
    expect(res.statusCode).toBe(400);
    expect(createEmailDraft).not.toHaveBeenCalled();
    await app.close();
  });

  it("404s when the email is not found", async () => {
    emailFindFirst.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/nope/gmail-draft",
      payload: { to: "boss@corp.com", subject: "Re: hi", body: "sounds good" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
