/**
 * GET /api/email under attention engine v3 (docs/design/attention-engine-v3.md
 * §3(5) "Reasons and API contract", P3 PR2b): for a user under the policy the
 * QUEUE lane is ranked in SQL and every row carries a v3 block; Today's request
 * adds the budget, the QUEUE count and the ranking time. Everyone else gets
 * today's order and shape.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const userTokenFindFirst = vi.hoisted(() => vi.fn(async () => null as unknown));
const emailFindMany = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const emailCount = vi.hoisted(() => vi.fn(async () => 0));
const attentionFindMany = vi.hoisted(() => vi.fn(async (_args: unknown) => [] as unknown[]));
const queryRaw = vi.hoisted(() => vi.fn(async (_sql: unknown) => [] as unknown[]));
const notificationCount = vi.hoisted(() => vi.fn(async () => 2));

vi.mock("../db.js", () => {
  const prisma = {
    userToken: { findFirst: userTokenFindFirst },
    emailMessage: { findMany: emailFindMany, count: emailCount },
    attentionItem: { findMany: attentionFindMany },
    linkedInboxAccount: { findFirst: vi.fn(async () => null) },
    notification: { count: notificationCount },
    automationConfig: { findUnique: vi.fn(async () => ({ timezone: "UTC", interruptBudget: 3 })) },
    $queryRaw: queryRaw,
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

async function get(url: string) {
  const { emailRoutes } = await import("../routes/email.js");
  const app = Fastify();
  await app.register(emailRoutes, { prefix: "/api/email" });
  const res = await app.inject({ method: "GET", url, headers: auth() });
  await app.close();
  return res;
}

function dbRow(id: string, subject: string) {
  return {
    id,
    gmailId: `g-${id}`,
    threadId: `t-${id}`,
    linkedInboxAccountId: null,
    from: "Sender <sender@x.com>",
    to: "me@x.com",
    subject,
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
    receivedAt: new Date("2026-11-07T00:00:00.000Z"),
  };
}

/** The page query (ids), the total, in that order of $queryRaw calls. */
function lanePage(ids: string[], total = ids.length) {
  queryRaw.mockImplementation(async (sql: unknown) => {
    const text = (sql as { strings: string[] }).strings.join("?");
    return text.includes("COUNT(*)") ? [{ total }] : ids.map((id) => ({ id }));
  });
}
const pageSql = () =>
  queryRaw.mock.calls
    .map(([sql]) => (sql as { strings: string[] }).strings.join("?").replace(/\s+/g, " "))
    .find((text) => !text.includes("COUNT(*)")) ?? "";

const V3_ROW = {
  sourceId: "e1",
  tier: "QUEUE",
  heldAt: new Date("2026-11-07T01:00:00.000Z"),
  isManualOverride: false,
  agentTierSetAt: null,
  v3PolicyVersion: "v3.0",
  v3Decision: {
    basis: "llm",
    threadTurn: "theirs",
    reasons: [{ code: "held_budget", fact: null, evidence: null, params: { budget: 3 } }],
  },
  v3Due: null,
};

beforeEach(() => {
  process.env.MAIL_V2 = "true";
  userTokenFindFirst.mockResolvedValue(GOOGLE_TOKEN);
  emailFindMany.mockReset();
  emailFindMany.mockResolvedValue([dbRow("e1", "Held one"), dbRow("e2", "Plain")]);
  attentionFindMany.mockReset();
  // The chip lookup and the v3 lookup share findMany; the v3 one selects v3Decision.
  attentionFindMany.mockImplementation(async (args: unknown) => {
    const select = (args as { select: Record<string, unknown> }).select;
    if (select.v3Decision) return [V3_ROW];
    return [{ sourceId: "e1", tier: "QUEUE", tierReason: "email.heldByInterruptBudget" }];
  });
  queryRaw.mockReset();
  lanePage(["e1", "e2"], 42);
});

afterEach(() => {
  delete process.env.MAIL_V2;
  delete process.env.JUDGE_V3_POLICY;
  delete process.env.JUDGE_V3_SHADOW;
});

const underPolicy = () => {
  process.env.JUDGE_V3_POLICY = "true";
  process.env.JUDGE_V3_SHADOW = "true";
};

describe("GET /api/email for a user not under the policy", () => {
  it("keeps the QUEUE page newest first, with no v3 fields", async () => {
    process.env.JUDGE_V3_POLICY = "true"; // the policy flag alone covers nobody
    const res = await get("/api/email?tier=QUEUE&page=1");
    expect(res.statusCode).toBe(200);
    expect(pageSql()).toContain('ORDER BY e."receivedAt" DESC, e."id" DESC');
    const body = res.json();
    expect(body.emails[0]).not.toHaveProperty("v3");
    expect(body).not.toHaveProperty("rankedAt");
    expect(body).not.toHaveProperty("interruptBudget");
  });
});

describe("GET /api/email for a user under the policy", () => {
  it("ranks the QUEUE page in SQL and numbers its rows from the page's first rank", async () => {
    underPolicy();
    const res = await get("/api/email?tier=QUEUE&page=2");
    expect(res.statusCode).toBe(200);
    expect(pageSql()).toContain('a."heldAt"');
    expect(pageSql()).toContain('a."v3Importance"');
    const body = res.json();
    expect(typeof body.rankedAt).toBe("string");
    expect(body).not.toHaveProperty("interruptBudget");
    const [first, second] = body.emails;
    expect(first.v3).toMatchObject({ rank: 51, held: true, policyVersion: "v3.0" });
    expect(first.v3.reasons[0]).toMatchObject({ code: "held_budget", params: { budget: 3 } });
    // Mail with no decision row: an undecided block, still ranked.
    expect(second.v3).toEqual({
      policyVersion: null,
      rank: 52,
      held: false,
      due: null,
      threadTurn: null,
      reasons: [],
    });
  });

  it("leaves other lanes in time order, with blocks but no ranks", async () => {
    underPolicy();
    const res = await get("/api/email?tier=PUSH");
    expect(pageSql()).toContain('ORDER BY e."receivedAt" DESC, e."id" DESC');
    const body = res.json();
    expect(body.emails[0].v3.rank).toBeNull();
    expect(body).not.toHaveProperty("rankedAt");
  });

  it("Today's request adds the day's budget, the QUEUE count and the ranking time", async () => {
    underPolicy();
    const res = await get("/api/email?tier=PUSH&window=today");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.interruptBudget).toEqual({ limit: 3, used: 2, day: expect.any(String) });
    expect(body.queueTotal).toBe(42);
    expect(typeof body.rankedAt).toBe("string");
  });
});
