/**
 * The reader routes render template text in the client's UI language:
 *   - GET /api/email/:id/reader-context → deterministic tierReason
 *   - GET /api/email/:id                → needsReplyReasonText
 * Precedence: lang → Accept-Language → stored notificationLanguage → en.
 * LLM-written fields (summary, keyPoints, actionItems, judge prose reasons)
 * are returned exactly as stored.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";
import { STATIC_TIER_REASONS } from "../judge/tier-reason-strings.js";
import { NEEDS_REPLY_REASON_COPY } from "../mail/needs-reply-reason-strings.js";

const emailFindFirst = vi.hoisted(() => vi.fn(async (_args: unknown) => null as unknown));
const attentionFindFirst = vi.hoisted(() => vi.fn(async (_args: unknown) => null as unknown));
const configFindUnique = vi.hoisted(() => vi.fn(async (_args: unknown) => null as unknown));

vi.mock("../db.js", () => {
  const prisma = {
    userToken: { findFirst: vi.fn(async () => null) },
    emailMessage: { findFirst: emailFindFirst, findMany: vi.fn(async () => []) },
    attentionItem: { findFirst: attentionFindFirst, findMany: vi.fn(async () => []) },
    contactEngagementScore: { findFirst: vi.fn(async () => null) },
    senderLabel: { findMany: vi.fn(async () => []) },
    linkedInboxAccount: { findFirst: vi.fn(async () => null) },
    automationConfig: { findUnique: configFindUnique },
    $queryRaw: vi.fn(async () => []),
    user: {
      findUnique: vi.fn(async () => ({
        id: "user-1",
        plan: "FREE",
        role: "USER",
        companyDomains: [],
      })),
    },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", async (original) => ({
  ...(await original<typeof import("../sentry.js")>()),
  captureError: vi.fn(),
}));
vi.mock("../learning/trust-score.js", async (original) => ({
  ...(await original<typeof import("../learning/trust-score.js")>()),
  getTrustScore: vi.fn(async () => null),
}));
vi.mock("../learning/interaction-graph.js", async (original) => ({
  ...(await original<typeof import("../learning/interaction-graph.js")>()),
  getCachedInteractionNode: vi.fn(async () => null),
}));
vi.mock("../mail/email-attachments.js", async (original) => ({
  ...(await original<typeof import("../mail/email-attachments.js")>()),
  listEmailAttachments: vi.fn(async () => []),
  buildAttachmentCandidateProfile: vi.fn(() => null),
}));

const TOKEN = signToken({ userId: "user-1", email: "t@e.com" });

async function get(url: string, headers: Record<string, string> = {}) {
  const { emailRoutes } = await import("../routes/email.js");
  const app = Fastify();
  await app.register(emailRoutes, { prefix: "/api/email" });
  const res = await app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${TOKEN}`, ...headers },
  });
  await app.close();
  return res;
}

const MAIL = {
  id: "e5",
  gmailId: "g5",
  threadId: "t5",
  userId: "user-1",
  from: "Ada Lovelace <ada@example.com>",
  to: "me@example.com",
  cc: null,
  subject: "Sign-off on the Q4 plan",
  snippet: "Could you sign off by Friday?",
  body: "Could you sign off by Friday?",
  htmlBody: null,
  receivedAt: new Date("2026-10-16T00:00:00Z"),
  labels: ["INBOX"],
  isRead: false,
  isStarred: false,
  category: "work",
  priority: "HIGH",
  summary: "Ada needs sign-off on the Q4 plan by Friday",
  keyPoints: ["Sign-off by Friday"],
  actionItems: ["Sign off on the Q4 plan by Friday"],
  sentiment: "neutral",
  needsReply: true,
  needsReplyReason: "action_items_present",
  needsReplyConfidence: 0.85,
  linkedInboxAccountId: null,
};

const TIER_COPY = STATIC_TIER_REASONS["action.awaitingApproval"];
const REPLY_COPY = NEEDS_REPLY_REASON_COPY.action_items_present;

beforeEach(() => {
  emailFindFirst.mockReset();
  emailFindFirst.mockResolvedValue(MAIL);
  attentionFindFirst.mockReset();
  attentionFindFirst.mockResolvedValue({ tier: "QUEUE", tierReason: "action.awaitingApproval" });
  configFindUnique.mockReset();
  configFindUnique.mockResolvedValue({ notificationLanguage: "en" });
  process.env.MAIL_V2 = "true";
});

afterEach(() => {
  delete process.env.MAIL_V2;
});

describe("GET /api/email/:id/reader-context — reader language", () => {
  it.each(["en", "ko", "ja", "zh", "es", "fr", "de"] as const)("lang=%s", async (lang) => {
    const res = await get(`/api/email/e5/reader-context?lang=${lang}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().tierReason).toBe(TIER_COPY[lang]);
  });

  it("an unknown lang is ignored; Accept-Language then decides", async () => {
    const res = await get("/api/email/e5/reader-context?lang=xx", { "accept-language": "ko-KR" });
    expect(res.statusCode).toBe(200);
    expect(res.json().tierReason).toBe(TIER_COPY.ko);
    expect(String(res.headers.vary)).toContain("Accept-Language");
  });

  it("falls back to the stored notification language", async () => {
    configFindUnique.mockResolvedValue({ notificationLanguage: "ja" });
    const res = await get("/api/email/e5/reader-context");
    expect(res.json().tierReason).toBe(TIER_COPY.ja);
  });

  it("composes with the list-view params", async () => {
    const res = await get("/api/email/e5/reader-context?tier=QUEUE&lang=de");
    expect(res.statusCode).toBe(200);
    expect(res.json().tierReason).toBe(TIER_COPY.de);
  });
});

describe("GET /api/email/:id — reader language", () => {
  it.each(["en", "ko", "ja", "zh", "es", "fr", "de"] as const)("lang=%s", async (lang) => {
    const res = await get(`/api/email/e5?lang=${lang}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.needsReplyReasonText).toBe(REPLY_COPY[lang]);
    // The code stays on the wire for clients that map it themselves.
    expect(body.needsReplyReason).toBe("action_items_present");
  });

  it("LLM-written fields are returned as stored, whatever the language", async () => {
    const body = (await get("/api/email/e5?lang=ko")).json();
    expect(body.summary).toBe(MAIL.summary);
    expect(body.keyPoints).toEqual(MAIL.keyPoints);
    expect(body.actionItems).toEqual(MAIL.actionItems);
  });

  it("precedence: lang beats Accept-Language beats the stored setting", async () => {
    configFindUnique.mockResolvedValue({ notificationLanguage: "es" });
    expect(
      (await get("/api/email/e5?lang=fr", { "accept-language": "ko" })).json().needsReplyReasonText,
    ).toBe(REPLY_COPY.fr);
    expect(
      (await get("/api/email/e5", { "accept-language": "ko" })).json().needsReplyReasonText,
    ).toBe(REPLY_COPY.ko);
    expect((await get("/api/email/e5?lang=xx")).json().needsReplyReasonText).toBe(REPLY_COPY.es);
  });

  it("a code without reader copy sends no line", async () => {
    emailFindFirst.mockResolvedValue({ ...MAIL, needsReplyReason: "no_reply_signal" });
    expect((await get("/api/email/e5?lang=ko")).json().needsReplyReasonText).toBeNull();
  });
});
