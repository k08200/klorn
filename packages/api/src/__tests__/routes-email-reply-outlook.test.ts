/**
 * The reply and draft routes on an OUTLOOK message (step B0b). The real dispatch
 * and the real Outlook provider run; only Graph's HTTP is faked. What is pinned:
 *  - the route hands the provider the ROW's provider message id, never the id in
 *    the URL, so a caller cannot aim a reply at another message;
 *  - `threaded` is true for Outlook only because the native reply path ran;
 *  - the recipient is exactly the one the route named, whatever the original's
 *    Reply-To says.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const emailFindFirst = vi.hoisted(() => vi.fn());
const emailUpdateMany = vi.hoisted(() => vi.fn(async () => ({ count: 1 })));
const sentUpsert = vi.hoisted(() => vi.fn(async () => ({})));
const resolveOutlookBearer = vi.hoisted(() => vi.fn());
const updateCandidateIntake = vi.hoisted(() => vi.fn(async () => {}));
const captureError = vi.hoisted(() => vi.fn());

vi.mock("../auth.js", () => ({
  requireAuth: async () => {},
  getUserId: () => "user-1",
  resolveEffectiveJwtSecret: () => "test-secret",
}));
vi.mock("../db.js", () => {
  const prisma = {
    emailMessage: { findFirst: emailFindFirst, updateMany: emailUpdateMany },
    sentMessage: { upsert: sentUpsert },
    emailAttachment: { findMany: vi.fn(async () => []) },
    linkedInboxAccount: { findFirst: vi.fn(async () => ({ provider: "OUTLOOK" })) },
  };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError }));
vi.mock("../llm/llm-credentials.js", () => ({ getUserLlmCredentials: vi.fn(async () => ({})) }));
vi.mock("../learning/voice-profile-extractor.js", () => ({
  buildVoicePromptHint: vi.fn(async () => ""),
}));
vi.mock("../llm/openai.js", () => ({ createCompletion: vi.fn(), DRAFT_MODEL: "test-draft-model" }));
vi.mock("../mail/email-attachments.js", () => ({
  listEmailAttachments: vi.fn(async () => []),
  buildAttachmentCandidateProfile: vi.fn(() => null),
}));
vi.mock("../mail/email-candidate-intake.js", () => ({ updateCandidateIntake }));
vi.mock("../mail/outlook-token.js", () => ({ resolveOutlookBearer }));
vi.mock("../mail/gmail.js", () => ({
  markLinkedInboxForReconnect: vi.fn(async () => undefined),
  resolveMailClient: vi.fn(),
  GMAIL_TOOLS: [],
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { registerEmailRepliesRoutes } from "../routes/email-replies.js";
import {
  address,
  createGraphFake,
  type Handler,
  LIST_ATTACHMENTS,
  MAILBOX,
  ORIGINAL_ID,
} from "./helpers/graph-reply-fake.js";

const OUTLOOK_EMAIL = {
  id: "klorn-e1",
  gmailId: ORIGINAL_ID,
  threadId: "conv-1",
  userId: "user-1",
  from: "Alice Kim <alice@example.com>",
  subject: "Plan",
  summary: null,
  receivedAt: new Date("2026-09-30T00:00:00Z"),
  linkedInboxAccountId: "acct-outlook",
};
const graph = createGraphFake(fetchMock);
const CREATE = "POST /me/messages/ORIG/createReply";
const SEND = "POST /me/messages/DRAFT/send";

async function buildApp() {
  const app = Fastify();
  await app.register(registerEmailRepliesRoutes, { prefix: "/api/email" });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  emailFindFirst.mockResolvedValue(OUTLOOK_EMAIL);
  resolveOutlookBearer.mockResolvedValue({ accessToken: "bearer-at", email: MAILBOX });
  graph.reset();
});

describe("POST /api/email/:id/reply on an Outlook message", () => {
  it("replies natively, to the original sender, and reports threaded: true", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/klorn-e1/reply",
      payload: { body: "Thursday works." },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      messageId: null,
      threaded: true,
      to: "alice@example.com",
    });
    expect(graph.summary()).toEqual([CREATE, "PATCH /me/messages/DRAFT", LIST_ATTACHMENTS, SEND]);
    expect(graph.calls[1]?.body).toEqual({
      subject: "Re: Plan",
      body: { contentType: "Text", content: "Thursday works." },
      toRecipients: [address("alice@example.com")],
      ccRecipients: [],
      bccRecipients: [],
    });
    expect(emailUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { repliedAt: expect.any(Date) } }),
    );
    await app.close();
  });

  it("takes the original's id from the stored row, never from the URL", async () => {
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/email/klorn-e1/reply",
      payload: { body: "Thursday works." },
    });
    expect(graph.calls[0]?.path).toBe("/me/messages/ORIG/createReply");
    expect(graph.summary().join(" ")).not.toContain("klorn-e1");
    // The row was looked up by the URL id and scoped to the caller.
    expect(emailFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", OR: [{ id: "klorn-e1" }, { gmailId: "klorn-e1" }] },
      }),
    );
    await app.close();
  });

  it("goes to the original's From even when the original names a Reply-To", async () => {
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/email/klorn-e1/reply",
      payload: { body: "Thursday works." },
    });
    expect(graph.sentSnapshot?.toRecipients).toEqual([address("alice@example.com")]);
    await app.close();
  });

  it("does not claim a thread when the native reply failed", async () => {
    graph.install({ [CREATE]: () => ({ status: 404 }) });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/klorn-e1/reply",
      payload: { body: "Thursday works." },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).not.toHaveProperty("threaded");
    expect(graph.summary()).toEqual([CREATE]);
    expect(emailUpdateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ["an http 502", () => ({ status: 502 })],
    [
      "a timeout",
      () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    ],
    [
      "a network error",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ] as Array<
    [string, Handler]
  >)("answers 502 and tells the user to check Sent Items when /send ends with %s", async (_name, handler) => {
    graph.install({ [SEND]: handler });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/klorn-e1/reply",
      payload: { body: "Thursday works." },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: "The reply may already have been sent. Check Sent Items before retrying.",
    });
    // Nothing is recorded as answered, and the draft is left for the user to find.
    expect(emailUpdateMany).not.toHaveBeenCalled();
    expect(sentUpsert).not.toHaveBeenCalled();
    expect(graph.summary()).not.toContain("DELETE /me/messages/DRAFT");
    expect(captureError).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("does not use that answer for a send Graph rejected (429): that one was not sent", async () => {
    graph.install({ [SEND]: () => ({ status: 429 }) });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/klorn-e1/reply",
      payload: { body: "Thursday works." },
    });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("Sent Items");
    await app.close();
  });

  it("answers 409 with the provider's error when the mailbox needs reconnecting", async () => {
    graph.install({ [CREATE]: () => ({ status: 403 }) });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/klorn-e1/reply",
      payload: { body: "Thursday works." },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).not.toHaveProperty("threaded");
    await app.close();
  });
});

describe("POST /api/email/:id/gmail-draft on an Outlook message", () => {
  it("writes a native reply draft from the row's original and never sends it", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/klorn-e1/gmail-draft",
      payload: { to: "alice@example.com", subject: "Re: Plan", body: "Thursday works." },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, draftId: "DRAFT", attachedCount: 0 });
    expect(graph.summary()).toEqual([CREATE, "PATCH /me/messages/DRAFT", LIST_ATTACHMENTS]);
    expect(graph.summary().join(" ")).not.toContain("klorn-e1");
    await app.close();
  });

  it("addresses the draft to the recipient the user chose, explicitly", async () => {
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/email/klorn-e1/gmail-draft",
      payload: { to: "someone-else@example.com", subject: "Re: Plan", body: "FYI" },
    });
    expect(graph.calls[1]?.body).toMatchObject({
      toRecipients: [address("someone-else@example.com")],
      ccRecipients: [],
      bccRecipients: [],
    });
    await app.close();
  });
});
