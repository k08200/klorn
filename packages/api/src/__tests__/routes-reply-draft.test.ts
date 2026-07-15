/**
 * POST /api/email/:id/reply-draft — Klorn drafts an approval-ready reply.
 * Focus: an LLM failure must surface as a captured 503 (not a silent 500 with
 * a blank "Could not draft a reply" and nothing in the logs).
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createCompletion = vi.hoisted(() => vi.fn());
const captureError = vi.hoisted(() => vi.fn());
const emailFindFirst = vi.hoisted(() => vi.fn());

vi.mock("../auth.js", () => ({
  requireAuth: async () => {},
  getUserId: () => "user-1",
}));
vi.mock("../db.js", () => {
  const prisma = { emailMessage: { findFirst: emailFindFirst } };
  return { prisma, db: prisma };
});
vi.mock("../llm/openai.js", () => ({ createCompletion, DRAFT_MODEL: "test-draft-model" }));
vi.mock("../sentry.js", () => ({ captureError }));
vi.mock("../llm/llm-credentials.js", () => ({ getUserLlmCredentials: vi.fn(async () => ({})) }));
vi.mock("../learning/voice-profile-extractor.js", () => ({
  buildVoicePromptHint: vi.fn(async () => ""),
}));
vi.mock("../mail/email-attachments.js", () => ({
  listEmailAttachments: vi.fn(async () => []),
  buildAttachmentCandidateProfile: vi.fn(() => null),
}));
vi.mock("../mail/email-candidate-intake.js", () => ({ updateCandidateIntake: vi.fn() }));
vi.mock("../mail/gmail.js", () => ({
  createEmailDraft: vi.fn(),
  getAuthedClient: vi.fn(),
  // Transitively imported by autonomous-agent (via the route's import graph);
  // keep the array shape so its `[...GMAIL_TOOLS]` spread doesn't blow up.
  GMAIL_TOOLS: [],
}));

import { registerEmailRepliesRoutes } from "../routes/email-replies.js";

const EMAIL = {
  id: "e1",
  gmailId: "g1",
  userId: "user-1",
  from: "Boss <boss@corp.com>",
  subject: "Need your reply today",
  body: "Can we move our call to 3pm?",
  summary: null,
  actionItems: null,
};

async function buildApp() {
  const app = Fastify();
  await app.register(registerEmailRepliesRoutes, { prefix: "/api/email" });
  return app;
}

beforeEach(() => {
  createCompletion.mockReset();
  captureError.mockReset();
  emailFindFirst.mockReset();
  emailFindFirst.mockResolvedValue(EMAIL);
});

describe("POST /api/email/:id/reply-draft", () => {
  it("returns a drafted reply on the happy path", async () => {
    createCompletion.mockResolvedValue({
      choices: [{ message: { content: "Hi, 3pm works for me. — Yongrean" } }],
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e1/reply-draft",
      payload: { intent: "say yes to 3pm" },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.body).toContain("3pm works");
    expect(json.subject).toBe("Re: Need your reply today");
    expect(createCompletion.mock.calls[0][0].model).toBe("test-draft-model");
    await app.close();
  });

  it("returns 503 and captures the error when the LLM fails (not a silent 500)", async () => {
    createCompletion.mockRejectedValue(
      Object.assign(new Error("All AI providers are unavailable"), {
        name: "AllProvidersExhaustedError",
      }),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e1/reply-draft",
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/temporarily unavailable/i);
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError.mock.calls[0][1].tags.scope).toBe("reply-draft");
    await app.close();
  });

  it("404s when the email is not found", async () => {
    emailFindFirst.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/nope/reply-draft",
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(createCompletion).not.toHaveBeenCalled();
    await app.close();
  });
});
