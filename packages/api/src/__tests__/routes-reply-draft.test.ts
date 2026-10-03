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
const buildVoicePromptHint = vi.hoisted(() => vi.fn(async () => ""));
const buildReplyToneHint = vi.hoisted(() => vi.fn(async () => ""));

vi.mock("../auth.js", () => ({
  requireAuth: async () => {},
  getUserId: () => "user-1",
  resolveEffectiveJwtSecret: () => "test-secret",
}));
vi.mock("../db.js", () => {
  const prisma = { emailMessage: { findFirst: emailFindFirst } };
  return { prisma, db: prisma };
});
vi.mock("../llm/openai.js", () => ({ createCompletion, DRAFT_MODEL: "test-draft-model" }));
vi.mock("../sentry.js", () => ({ captureError }));
vi.mock("../llm/llm-credentials.js", () => ({ getUserLlmCredentials: vi.fn(async () => ({})) }));
vi.mock("../learning/voice-profile-extractor.js", () => ({
  buildVoicePromptHint: buildVoicePromptHint,
}));
vi.mock("../learning/reply-tone.js", () => ({ buildReplyToneHint: buildReplyToneHint }));
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

import { draftReplyForEmailId, registerEmailRepliesRoutes } from "../routes/email-replies.js";

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
  buildVoicePromptHint.mockReset();
  buildVoicePromptHint.mockResolvedValue("");
  buildReplyToneHint.mockReset();
  buildReplyToneHint.mockResolvedValue("");
});

/** The system prompt the route handed the LLM on its last call. */
function systemPrompt(): string {
  const [request] = createCompletion.mock.calls.at(-1) ?? [];
  return request?.messages?.find((m: { role: string }) => m.role === "system")?.content ?? "";
}

describe("draftReplyForEmailId — the proactive sweep's builder", () => {
  it("drafts the user's own row at background priority with the route's prompt", async () => {
    createCompletion.mockResolvedValue({ choices: [{ message: { content: " 3pm works. " } }] });
    expect(await draftReplyForEmailId("user-1", "e1")).toBe("3pm works.");
    expect(emailFindFirst).toHaveBeenCalledWith({ where: { id: "e1", userId: "user-1" } });
    const [request, options] = createCompletion.mock.calls[0];
    expect(request.model).toBe("test-draft-model");
    expect(options).toMatchObject({ userId: "user-1", priority: "background" });
  });

  it("returns null without an LLM call when the row is gone or foreign", async () => {
    emailFindFirst.mockResolvedValue(null);
    expect(await draftReplyForEmailId("user-1", "nope")).toBeNull();
    expect(createCompletion).not.toHaveBeenCalled();
  });
});

describe("POST /api/email/:id/reply-draft", () => {
  it("an on-demand draft stays foreground — no priority is passed", async () => {
    createCompletion.mockResolvedValue({ choices: [{ message: { content: "ok" } }] });
    const app = await buildApp();
    await app.inject({ method: "POST", url: "/api/email/e1/reply-draft", payload: {} });
    expect(createCompletion.mock.calls[0][1]).not.toHaveProperty("priority");
    await app.close();
  });

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

  it("names the model provider when the whole fallback chain refused (503)", async () => {
    // The generic "temporarily unavailable" sent the founder in circles
    // retrying a key/quota problem as if it were a Klorn bug (2026-08-10).
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
    expect(res.json().error).toMatch(/model provider is unavailable/i);
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError.mock.calls[0][1].tags.scope).toBe("reply-draft.providers-exhausted");
    await app.close();
  });

  it("returns 503 and captures unknown LLM failures (not a silent 500)", async () => {
    createCompletion.mockRejectedValue(new Error("socket hang up"));
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e1/reply-draft",
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/temporarily unavailable/i);
    // The failure CLASS is surfaced: "temporarily unavailable" alone gave the
    // founder nothing to act on for a day (2026-08-10).
    expect(res.json().error).toMatch(/\(Error\)/);
    expect(captureError.mock.calls[0][1].tags.scope).toBe("reply-draft");
    await app.close();
  });

  it("maps a daily-budget trip to 429 with its own message, not an outage 503", async () => {
    // Retrying cannot succeed until the cap resets — saying "temporarily
    // unavailable" invites exactly the wrong action.
    createCompletion.mockRejectedValue(
      Object.assign(new Error("Daily AI budget reached."), {
        name: "DailyCostCapExceededError",
      }),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e1/reply-draft",
      payload: {},
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toMatch(/budget/i);
    expect(captureError).not.toHaveBeenCalled();
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
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e1/reply-draft",
      payload: {},
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("12");
    expect(res.json().error).toMatch(/too fast/i);
    expect(captureError).not.toHaveBeenCalled();
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

// Founder decision (2026-07-28): the accept/decline/info keys are unchanged and
// the register the user picked applies to all three drafts. /reply-draft is the
// shared generator behind those keys, so this is where that has to hold.
describe("POST /api/email/:id/reply-draft reply tone", () => {
  it("carries the chosen register into the prompt", async () => {
    buildReplyToneHint.mockResolvedValue("[Reply tone] Write formally.");
    createCompletion.mockResolvedValue({ choices: [{ message: { content: "ok" } }] });

    const app = await buildApp();
    await app.inject({ method: "POST", url: "/api/email/e1/reply-draft", payload: {} });

    expect(buildReplyToneHint).toHaveBeenCalledWith("user-1");
    expect(systemPrompt()).toContain("Write formally.");
    await app.close();
  });

  it("adds nothing when the user has not chosen a register", async () => {
    createCompletion.mockResolvedValue({ choices: [{ message: { content: "ok" } }] });

    const app = await buildApp();
    await app.inject({ method: "POST", url: "/api/email/e1/reply-draft", payload: {} });

    expect(systemPrompt()).not.toMatch(/\[Reply tone/i);
    await app.close();
  });

  // An explicit choice must outrank an inferred one, and prompt order is how
  // that is expressed — the tone has to come after the learned voice profile.
  it("places the explicit register after the inferred writing style", async () => {
    buildVoicePromptHint.mockResolvedValue("[User's writing style] Tone: casual");
    buildReplyToneHint.mockResolvedValue("[Reply tone] Write formally.");
    createCompletion.mockResolvedValue({ choices: [{ message: { content: "ok" } }] });

    const app = await buildApp();
    await app.inject({ method: "POST", url: "/api/email/e1/reply-draft", payload: {} });

    const prompt = systemPrompt();
    expect(prompt).toContain("Tone: casual");
    expect(prompt.indexOf("[Reply tone]")).toBeGreaterThan(
      prompt.indexOf("[User's writing style]"),
    );
    await app.close();
  });

  // The reply must follow the sender, never the app's UI language.
  it("still tells the model to answer in the incoming email's language", async () => {
    createCompletion.mockResolvedValue({ choices: [{ message: { content: "ok" } }] });

    const app = await buildApp();
    await app.inject({ method: "POST", url: "/api/email/e1/reply-draft", payload: {} });

    expect(systemPrompt()).toMatch(/same language as the incoming email/i);
    await app.close();
  });
});
