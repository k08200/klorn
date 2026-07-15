/**
 * POST /api/email/:id/reply — one-call threaded reply.
 * Focus: it sends (not drafts) to the original sender in the same thread, with
 * In-Reply-To/References derived from the original's live headers.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendEmail = vi.hoisted(() => vi.fn());
const getReplyHeaders = vi.hoisted(() => vi.fn());
const emailFindFirst = vi.hoisted(() => vi.fn());

vi.mock("../auth.js", () => ({
  requireAuth: async () => {},
  getUserId: () => "user-1",
}));
vi.mock("../db.js", () => {
  const prisma = { emailMessage: { findFirst: emailFindFirst } };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../llm/llm-credentials.js", () => ({ getUserLlmCredentials: vi.fn(async () => ({})) }));
vi.mock("../voice-profile-extractor.js", () => ({ buildVoicePromptHint: vi.fn(async () => "") }));
vi.mock("../llm/openai.js", () => ({ createCompletion: vi.fn(), DRAFT_MODEL: "test-draft-model" }));
vi.mock("../email-attachments.js", () => ({
  listEmailAttachments: vi.fn(async () => []),
  buildAttachmentCandidateProfile: vi.fn(() => null),
}));
vi.mock("../email-candidate-intake.js", () => ({ updateCandidateIntake: vi.fn() }));
vi.mock("../gmail.js", () => ({
  createEmailDraft: vi.fn(),
  getAuthedClient: vi.fn(),
  sendEmail,
  getReplyHeaders,
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
};

async function buildApp() {
  const app = Fastify();
  await app.register(registerEmailRepliesRoutes, { prefix: "/api/email" });
  return app;
}

beforeEach(() => {
  sendEmail.mockReset();
  getReplyHeaders.mockReset();
  emailFindFirst.mockReset();
  emailFindFirst.mockResolvedValue(EMAIL);
  sendEmail.mockResolvedValue({ success: true, messageId: "sent-1" });
  getReplyHeaders.mockResolvedValue({ messageId: "<orig@corp.com>", references: "<a@corp.com>" });
});

describe("POST /api/email/:id/reply", () => {
  it("sends a threaded reply to the sender with correct headers", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e1/reply",
      payload: { body: "3pm works for me." },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, to: "boss@corp.com", threaded: true });

    const [uid, to, subject, body, attachments, options] = sendEmail.mock.calls[0];
    expect(uid).toBe("user-1");
    expect(to).toBe("boss@corp.com");
    expect(subject).toBe("Re: Need your reply today");
    expect(body).toBe("3pm works for me.");
    expect(attachments).toEqual([]);
    expect(options).toEqual({
      threadId: "t1",
      inReplyTo: "<orig@corp.com>",
      references: "<a@corp.com> <orig@corp.com>", // original chain + original Message-ID
    });
    await app.close();
  });

  it("400s when the body is missing or blank", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e1/reply",
      payload: { body: "  " },
    });
    expect(res.statusCode).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
    await app.close();
  });

  it("404s when the email is not found", async () => {
    emailFindFirst.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/nope/reply",
      payload: { body: "hi" },
    });
    expect(res.statusCode).toBe(404);
    expect(sendEmail).not.toHaveBeenCalled();
    await app.close();
  });

  it("threads linkedInboxAccountId through to getReplyHeaders and sendEmail for a message from a linked secondary inbox (#757)", async () => {
    emailFindFirst.mockResolvedValue({ ...EMAIL, linkedInboxAccountId: "linked-acct-1" });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e1/reply",
      payload: { body: "3pm works for me." },
    });
    expect(res.statusCode).toBe(200);

    expect(getReplyHeaders.mock.calls[0]).toEqual(["user-1", "g1", "linked-acct-1"]);
    const options = sendEmail.mock.calls[0][5];
    expect(options.linkedInboxAccountId).toBe("linked-acct-1");
    await app.close();
  });

  it("reports threaded=false when no RFC Message-ID is found (threadId-only)", async () => {
    getReplyHeaders.mockResolvedValue({});
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e1/reply",
      payload: { body: "hi" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().threaded).toBe(false);
    const options = sendEmail.mock.calls[0][5];
    expect(options).toEqual({ threadId: "t1", inReplyTo: undefined, references: undefined });
    await app.close();
  });
});
