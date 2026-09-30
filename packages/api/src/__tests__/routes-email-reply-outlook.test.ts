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
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
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

const BASE = "https://graph.microsoft.com/v1.0";
const MAILBOX = "me@outlook.com";
const OUTLOOK_EMAIL = {
  id: "klorn-e1",
  gmailId: `outlook:${MAILBOX}:ORIG`,
  threadId: "conv-1",
  userId: "user-1",
  from: "Alice Kim <alice@example.com>",
  subject: "Plan",
  summary: null,
  receivedAt: new Date("2026-09-30T00:00:00Z"),
  linkedInboxAccountId: "acct-outlook",
};
const address = (value: string) => ({ emailAddress: { address: value } });

let graphCalls: Array<{ method: string; path: string; body: unknown }>;
let draftAtSend: { toRecipients: unknown } | null;
let failures: Record<string, number>;

function installGraph() {
  const draft: Record<string, unknown> = {
    id: "DRAFT",
    // createReply addresses the original's Reply-To, not its From.
    toRecipients: [address("reply-to@elsewhere.test")],
    ccRecipients: [],
    bccRecipients: [],
  };
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    const method = String(init.method);
    const path = url.replace(BASE, "");
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    graphCalls = [...graphCalls, { method, path, body }];
    const key = `${method} ${path}`;
    const status = failures[key];
    if (status) return { ok: false, status, json: async () => null };
    if (key === "POST /me/messages/ORIG/createReply") {
      return { ok: true, status: 201, json: async () => ({ ...draft, webLink: "https://w/d" }) };
    }
    if (key === "PATCH /me/messages/DRAFT") {
      Object.assign(draft, body);
      return { ok: true, status: 200, json: async () => ({ ...draft }) };
    }
    if (key === "POST /me/messages/DRAFT/send") {
      draftAtSend = structuredClone({ toRecipients: draft.toRecipients });
      return { ok: true, status: 202, json: async () => null };
    }
    if (key === "DELETE /me/messages/DRAFT") {
      return { ok: true, status: 204, json: async () => null };
    }
    throw new Error(`unscripted Graph call: ${key}`);
  });
}

async function buildApp() {
  const app = Fastify();
  await app.register(registerEmailRepliesRoutes, { prefix: "/api/email" });
  return app;
}

const callSummary = () => graphCalls.map((call) => `${call.method} ${call.path}`);

beforeEach(() => {
  vi.clearAllMocks();
  graphCalls = [];
  draftAtSend = null;
  failures = {};
  emailFindFirst.mockResolvedValue(OUTLOOK_EMAIL);
  resolveOutlookBearer.mockResolvedValue({ accessToken: "bearer-at", email: MAILBOX });
  installGraph();
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
    expect(callSummary()).toEqual([
      "POST /me/messages/ORIG/createReply",
      "PATCH /me/messages/DRAFT",
      "POST /me/messages/DRAFT/send",
    ]);
    expect(graphCalls[1]?.body).toEqual({
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
    expect(graphCalls[0]?.path).toBe("/me/messages/ORIG/createReply");
    expect(callSummary().join(" ")).not.toContain("klorn-e1");
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
    expect(draftAtSend?.toRecipients).toEqual([address("alice@example.com")]);
    await app.close();
  });

  it("does not claim a thread when the native reply failed", async () => {
    failures["POST /me/messages/ORIG/createReply"] = 404;
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/klorn-e1/reply",
      payload: { body: "Thursday works." },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).not.toHaveProperty("threaded");
    expect(callSummary()).toEqual(["POST /me/messages/ORIG/createReply"]);
    expect(emailUpdateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("answers 409 with the provider's error when the mailbox needs reconnecting", async () => {
    failures["POST /me/messages/ORIG/createReply"] = 403;
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
    expect(callSummary()).toEqual([
      "POST /me/messages/ORIG/createReply",
      "PATCH /me/messages/DRAFT",
    ]);
    expect(callSummary().join(" ")).not.toContain("klorn-e1");
    await app.close();
  });

  it("addresses the draft to the recipient the user chose, explicitly", async () => {
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/email/klorn-e1/gmail-draft",
      payload: { to: "someone-else@example.com", subject: "Re: Plan", body: "FYI" },
    });
    expect(graphCalls[1]?.body).toMatchObject({
      toRecipients: [address("someone-else@example.com")],
      ccRecipients: [],
      bccRecipients: [],
    });
    await app.close();
  });
});
