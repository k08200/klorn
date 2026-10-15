/**
 * GET /api/email — every list row carries its firewall lane (`tier`) so the
 * web inbox can render a chip next to the sender. Real branch joins
 * AttentionItem via listLaneTiersByEmail (null when un-judged — the client
 * renders no chip, never a guessed lane); demo branch ships hand-assigned
 * lanes so the logged-out view matches the product story. Own harness rather
 * than routes-email.test.ts: rows here are non-empty, so the attachment /
 * candidate / trust enrichment helpers must be stubbed out.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const userTokenFindFirst = vi.hoisted(() => vi.fn(async () => null as unknown));
const emailFindMany = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const emailCount = vi.hoisted(() => vi.fn(async () => 0));
const attentionFindMany = vi.hoisted(() => vi.fn(async () => [] as unknown[]));

vi.mock("../db.js", () => {
  const prisma = {
    userToken: { findFirst: userTokenFindFirst },
    linkedInboxAccount: { findFirst: vi.fn(async () => null) },
    emailMessage: { findMany: emailFindMany, count: emailCount },
    attentionItem: { findMany: attentionFindMany },
    user: { findUnique: vi.fn(async () => ({ id: "user-1", plan: "FREE", role: "USER" })) },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../mail/email-attachments.js", () => ({
  summarizeEmailAttachmentsByEmail: vi.fn(async () => ({})),
  listCandidateProfilesByEmail: vi.fn(async () => ({})),
}));
vi.mock("../mail/email-candidate-intake.js", () => ({
  listCandidateIntakesByEmail: vi.fn(async () => ({})),
  syncCandidateIntakeForEmail: vi.fn(async () => null),
}));
vi.mock("../learning/trust-score.js", () => ({
  getTrustScoresBulk: vi.fn(async () => new Map()),
}));

const TOKEN = signToken({ userId: "user-1", email: "t@e.com" });
const auth = () => ({ authorization: `Bearer ${TOKEN}` });

async function buildApp() {
  const { emailRoutes } = await import("../routes/email.js");
  const app = Fastify();
  await app.register(emailRoutes, { prefix: "/api/email" });
  return app;
}

const GOOGLE_TOKEN = {
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
};

function dbRow(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    gmailId: `g-${id}`,
    threadId: `t-${id}`,
    linkedInboxAccountId: null,
    from: "Sender <sender@x.com>",
    to: "me@x.com",
    subject: "Subject",
    snippet: "snippet",
    labels: ["INBOX"],
    isRead: false,
    isStarred: false,
    priority: "NORMAL",
    category: null,
    summary: null,
    keyPoints: null,
    actionItems: null,
    sentiment: null,
    needsReply: false,
    needsReplyReason: null,
    needsReplyConfidence: null,
    receivedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  userTokenFindFirst.mockReset();
  userTokenFindFirst.mockResolvedValue(null);
  emailFindMany.mockReset();
  emailFindMany.mockResolvedValue([]);
  emailCount.mockReset();
  emailCount.mockResolvedValue(0);
  attentionFindMany.mockReset();
  attentionFindMany.mockResolvedValue([]);
});

describe("GET /api/email — lane on every row", () => {
  it("joins each row's AttentionItem tier; un-judged rows carry null", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    emailFindMany.mockResolvedValue([dbRow("e1"), dbRow("e2")]);
    emailCount.mockResolvedValue(2);
    attentionFindMany.mockResolvedValue([{ sourceId: "e1", tier: "PUSH" }]);

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email", headers: auth() });
    expect(res.statusCode).toBe(200);
    const { emails } = res.json();
    expect(emails).toHaveLength(2);
    expect(emails.find((e: { id: string }) => e.id === "e1").tier).toBe("PUSH");
    expect(emails.find((e: { id: string }) => e.id === "e2").tier).toBeNull();
    await app.close();
  });

  it("never emits the retired AUTO value — folds to QUEUE", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    emailFindMany.mockResolvedValue([dbRow("e1")]);
    emailCount.mockResolvedValue(1);
    attentionFindMany.mockResolvedValue([{ sourceId: "e1", tier: "AUTO" }]);

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email", headers: auth() });
    expect(res.json().emails[0].tier).toBe("QUEUE");
    await app.close();
  });

  it("fails open: a broken lane lookup still returns the list, chips absent", async () => {
    userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
    emailFindMany.mockResolvedValue([dbRow("e1")]);
    emailCount.mockResolvedValue(1);
    attentionFindMany.mockRejectedValue(new Error("db down"));

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().emails[0].tier).toBeNull();
    await app.close();
  });

  it("no mail source: no rows at all, so no demo chips pretend to be the user's mail", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().emails).toEqual([]);
    expect(res.json().needsConnection).toBe(true);
    await app.close();
  });
});
