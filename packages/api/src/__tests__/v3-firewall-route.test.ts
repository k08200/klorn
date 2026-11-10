/**
 * GET /api/inbox/firewall under attention engine v3 (docs/design/attention-
 * engine-v3.md §3(5), P3 PR2b): for a user under the policy the QUEUE lane is
 * ranked, every card carries a v3 block, and Today's fields ride the response.
 * For everyone else the response is unchanged.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../mail/activity-sync.js", () => ({ ensureRecentMailSync: vi.fn(async () => {}) }));

const NOW = new Date("2026-11-07T09:00:00.000Z");
const HOUR = 3_600_000;
const ago = (h: number) => new Date(NOW.getTime() - h * HOUR);

const row = (id: string, tier: string, over: Record<string, unknown> = {}) => ({
  id,
  source: "EMAIL",
  sourceId: `em-${id}`,
  type: "REPLY_NEEDED",
  title: id,
  tier,
  tierReason: null,
  priority: 50,
  surfacedAt: ago(1),
  createdAt: ago(1),
  inputHash: null,
  agentTierSetAt: null,
  isManualOverride: false,
  heldAt: null,
  v3PolicyVersion: "v3.0",
  v3Decision: { basis: "llm", threadTurn: "none", reasons: [] },
  v3Due: null,
  v3Importance: null,
  ...over,
});

const attentionRows = [
  // Newest first by surfacedAt: the order the lanes use without the policy.
  row("plain", "QUEUE", { surfacedAt: ago(0.5) }),
  row("vip", "QUEUE", { surfacedAt: ago(2), v3Importance: 1 }),
  row("held", "QUEUE", { surfacedAt: ago(3), v3Importance: 0.4, heldAt: ago(3) }),
  row("urgent", "PUSH", { surfacedAt: ago(0.25), v3Importance: 1 }),
];
const emailRows = attentionRows.map((r) => ({
  id: r.sourceId,
  gmailId: `g-${r.id}`,
  subject: r.id,
  from: "alice@example.com",
  snippet: "hi",
  labels: ["INBOX"],
  threadId: `t-${r.id}`,
  linkedInboxAccountId: null,
  receivedAt: r.surfacedAt,
}));

const attentionFindMany = vi.hoisted(() => vi.fn());
vi.mock("../db.js", () => ({
  prisma: {
    attentionItem: { findMany: attentionFindMany },
    pendingAction: { findMany: vi.fn(async () => []) },
    emailMessage: {
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        emailRows.filter((e) => where.id?.in?.includes(e.id) ?? false),
      ),
    },
    notification: { count: vi.fn(async () => 1) },
    automationConfig: {
      findUnique: vi.fn(async () => ({ timezone: "UTC", interruptBudget: null })),
    },
    $queryRaw: vi.fn(async (sql: { strings: string[] }) =>
      sql.strings.join("?").includes("COUNT(*)") ? [{ total: 3 }] : [],
    ),
  },
}));
vi.mock("../auth.js", () => ({
  resolveEffectiveJwtSecret: () => "test-secret",
  requireAuth: vi.fn(async () => {}),
  getUserId: vi.fn(() => "user-1"),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../mail/gmail.js", () => ({ ensureFreshGmailWatch: vi.fn(async () => {}) }));
vi.mock("../learning/trust-score.js", () => ({ getTrustScoresBulk: vi.fn(async () => new Map()) }));

const { firewallRoutes } = await import("../routes/firewall.js");

interface Card {
  id: string;
  v3?: { rank: number | null; held: boolean; policyVersion: string | null };
}
interface Wire {
  tiers: Record<string, Card[]>;
  interruptBudget?: unknown;
  queueTotal?: number;
  rankedAt?: string;
}

async function read(): Promise<Wire> {
  const app = Fastify();
  await app.register(firewallRoutes, { prefix: "/api/inbox/firewall" });
  const res = await app.inject({ method: "GET", url: "/api/inbox/firewall/" });
  expect(res.statusCode).toBe(200);
  await app.close();
  return res.json() as Wire;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  attentionFindMany.mockReset();
  attentionFindMany.mockImplementation(async () => attentionRows);
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.JUDGE_V3_POLICY;
  delete process.env.JUDGE_V3_SHADOW;
});

describe("GET /api/inbox/firewall and attention engine v3", () => {
  it("is unchanged for a user not under the policy: newest first, no v3 fields", async () => {
    process.env.JUDGE_V3_POLICY = "true";
    const body = await read();
    expect(body.tiers.QUEUE.map((c) => c.id)).toEqual(["plain", "vip", "held"]);
    expect(body.tiers.QUEUE[0]).not.toHaveProperty("v3");
    expect(body).not.toHaveProperty("interruptBudget");
    // The v3 columns are not even selected.
    const select = (attentionFindMany.mock.calls[0]?.[0] as { select: Record<string, unknown> })
      .select;
    expect(select).not.toHaveProperty("v3Decision");
  });

  it("ranks QUEUE, puts a v3 block on every card and adds Today's fields under the policy", async () => {
    process.env.JUDGE_V3_POLICY = "true";
    process.env.JUDGE_V3_SHADOW = "true";
    const body = await read();
    expect(body.tiers.QUEUE.map((c) => c.id)).toEqual(["held", "vip", "plain"]);
    expect(body.tiers.QUEUE.map((c) => c.v3?.rank)).toEqual([1, 2, 3]);
    expect(body.tiers.QUEUE[0]?.v3?.held).toBe(true);
    expect(body.tiers.PUSH[0]?.v3).toMatchObject({ rank: null, policyVersion: "v3.0" });
    expect(body.interruptBudget).toEqual({ limit: 5, used: 1, day: "2026-11-07" });
    expect(body.queueTotal).toBe(3);
    expect(body.rankedAt).toBe(NOW.toISOString());
  });
});
