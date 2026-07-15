/**
 * POST /api/email/:id/reply-options — three tone-differentiated reply drafts
 * (accept / decline / info) the user picks from with one keystroke. Built for
 * the desktop PushCard: no free typing, so the never-steal-focus panel can
 * finally reply.
 * Focus: exactly 3 options with stable tone order, all-or-nothing on LLM
 * failure (a partial card would break the 1/2/3 key mapping), captured 503.
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

describe("POST /api/email/:id/reply-options", () => {
  it("returns exactly 3 drafts in stable tone order (accept, decline, info)", async () => {
    createCompletion.mockImplementation(async (req: { messages: { content: string }[] }) => {
      const user = req.messages[1].content;
      const body = user.includes("Accept")
        ? "Yes, 3pm works."
        : user.includes("decline")
          ? "Sorry, I can't make 3pm."
          : "Which day did you have in mind?";
      return { choices: [{ message: { content: body } }] };
    });
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/email/e1/reply-options" });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.to).toBe("boss@corp.com");
    expect(json.subject).toBe("Re: Need your reply today");
    expect(json.options).toHaveLength(3);
    expect(json.options.map((o: { tone: string }) => o.tone)).toEqual([
      "accept",
      "decline",
      "info",
    ]);
    expect(json.options[0].body).toContain("3pm works");
    expect(json.options[1].body).toContain("can't make");
    expect(json.options[2].body).toContain("Which day");
    expect(createCompletion).toHaveBeenCalledTimes(3);
    await app.close();
  });

  it("is all-or-nothing: one failed draft means a captured 503, not a partial card", async () => {
    createCompletion
      .mockResolvedValueOnce({ choices: [{ message: { content: "Yes." } }] })
      .mockRejectedValueOnce(new Error("provider down"))
      .mockResolvedValueOnce({ choices: [{ message: { content: "What time?" } }] });
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/email/e1/reply-options" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/temporarily unavailable/i);
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError.mock.calls[0][1].tags.scope).toBe("reply-options");
    await app.close();
  });

  it("maps a user-quota trip to 429 + Retry-After, not a captured provider-outage 503", async () => {
    // Self-throttling (quota-limiter's UserRateLimitedError) is the user going
    // fast, not the provider being down: Sentry must stay quiet and the client
    // must get an actionable back-off signal instead of "temporarily unavailable".
    createCompletion.mockRejectedValue(
      Object.assign(new Error("You're sending requests too fast. Try again in 12s."), {
        name: "UserRateLimitedError",
        retryAfterMs: 12_000,
      }),
    );
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/email/e1/reply-options" });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("12");
    expect(res.json().error).toMatch(/too fast/i);
    expect(captureError).not.toHaveBeenCalled();
    await app.close();
  });

  it("404s when the email is not found without spending LLM calls", async () => {
    emailFindFirst.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/email/nope/reply-options" });
    expect(res.statusCode).toBe(404);
    expect(createCompletion).not.toHaveBeenCalled();
    await app.close();
  });
});
