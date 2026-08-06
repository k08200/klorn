/**
 * The firewall board must WINDOW by recency and RANK by priority — not window
 * by priority. Email AttentionItems are never auto-resolved, so a mailbox
 * that accumulates >200 OPEN items saturates the take-window; ordered by
 * priority, the query then returns the same high-priority set forever and
 * every newer (lower-priority) mail is invisible in all four lanes — the
 * board freezes at the saturation date while ingestion keeps working
 * (observed live 2026-08-07: board pinned to 07-21 with counts summing ~200).
 *
 * Contract pinned here: the DB window is surfacedAt DESC (newest 200 OPEN),
 * and the RESPONSE is still priority-ranked within that window.
 */

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

const findManyArgs = vi.hoisted(() => ({ current: null as unknown }));

// Returned in surfacedAt-DESC order (what the fixed query asks for): the
// NEWEST row has the LOWEST priority — the exact row the old priority-ordered
// window would have evicted.
const attentionRows = [
  {
    id: "att-new-low",
    source: "EMAIL",
    sourceId: "em-new",
    type: "FYI",
    title: "Newest mail, low priority",
    tier: "SILENT",
    tierReason: "fixture",
    priority: 10,
    surfacedAt: new Date("2026-08-07T09:00:00Z"),
    inputHash: null,
  },
  {
    id: "att-old-high",
    source: "EMAIL",
    sourceId: "em-old",
    type: "REPLY_NEEDED",
    title: "Older mail, high priority",
    tier: "PUSH",
    tierReason: "fixture",
    priority: 90,
    surfacedAt: new Date("2026-07-21T09:00:00Z"),
    inputHash: null,
  },
  {
    id: "att-queue-newer-low",
    source: "EMAIL",
    sourceId: "em-mid",
    type: "REPLY_NEEDED",
    title: "Queue mail, newer, lower priority",
    tier: "QUEUE",
    tierReason: "fixture",
    priority: 50,
    surfacedAt: new Date("2026-08-06T09:00:00Z"),
    inputHash: null,
  },
  {
    id: "att-queue-older-high",
    source: "EMAIL",
    sourceId: "em-q2",
    type: "REPLY_NEEDED",
    title: "Queue mail, older, higher priority",
    tier: "QUEUE",
    tierReason: "fixture",
    priority: 80,
    surfacedAt: new Date("2026-08-01T09:00:00Z"),
    inputHash: null,
  },
];

const emailRows = [
  {
    id: "em-new",
    gmailId: "g-new",
    subject: "Newest mail, low priority",
    from: "a@example.com",
    snippet: "hi",
    labels: ["INBOX"],
    threadId: "t-new",
    linkedInboxAccountId: null,
  },
  {
    id: "em-old",
    gmailId: "g-old",
    subject: "Older mail, high priority",
    from: "b@example.com",
    snippet: "yo",
    labels: ["INBOX"],
    threadId: "t-old",
    linkedInboxAccountId: null,
  },
  {
    id: "em-mid",
    gmailId: "g-mid",
    subject: "Queue mail, newer, lower priority",
    from: "c@example.com",
    snippet: "hey",
    labels: ["INBOX"],
    threadId: "t-mid",
    linkedInboxAccountId: null,
  },
  {
    id: "em-q2",
    gmailId: "g-q2",
    subject: "Queue mail, older, higher priority",
    from: "d@example.com",
    snippet: "sup",
    labels: ["INBOX"],
    threadId: "t-q2",
    linkedInboxAccountId: null,
  },
];

vi.mock("../db.js", () => ({
  prisma: {
    attentionItem: {
      findMany: vi.fn(async (args: unknown) => {
        findManyArgs.current = args;
        return attentionRows;
      }),
    },
    pendingAction: { findMany: vi.fn(async () => []) },
    emailMessage: {
      findMany: vi.fn(
        async ({ where }: { where: { id?: { in: string[] }; gmailId?: { in: string[] } } }) =>
          emailRows.filter(
            (e) =>
              (where.id?.in?.includes(e.id) ?? false) ||
              (where.gmailId?.in?.includes(e.gmailId) ?? false),
          ),
      ),
    },
  },
}));

vi.mock("../auth.js", () => ({
  resolveEffectiveJwtSecret: () => "test-secret",
  requireAuth: vi.fn(async () => {}),
  getUserId: vi.fn(() => "user-1"),
}));

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

vi.mock("../mail/gmail.js", () => ({
  ensureFreshGmailWatch: vi.fn(async () => {}),
}));

vi.mock("../learning/trust-score.js", () => ({
  getTrustScoresBulk: vi.fn(async () => new Map()),
}));

vi.mock("../judge/poc-judge.js", () => ({
  judgeEmail: vi.fn(() => {
    throw new Error("invariant violated: read path invoked poc-judge");
  }),
  judgeEmails: vi.fn(() => {
    throw new Error("invariant violated: read path invoked poc-judge (bulk)");
  }),
  POC_TIERS: ["SILENT", "QUEUE", "PUSH", "AUTO"],
  tierFromFeatures: vi.fn(() => ({ tier: "QUEUE", reason: "stub" })),
}));

const { firewallRoutes } = await import("../routes/firewall.js");

async function buildApp() {
  const app = Fastify();
  await app.register(firewallRoutes, { prefix: "/api/inbox/firewall" });
  return app;
}

describe("firewall board — recency window, priority presentation", () => {
  it("windows the DB query by surfacedAt DESC, not by priority", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/inbox/firewall/" });
    expect(res.statusCode).toBe(200);
    const args = findManyArgs.current as { orderBy: unknown; take: number };
    // Priority-first ordering here is the freeze bug: once >take items are
    // OPEN, the window pins to the same high-priority set forever.
    expect(args.orderBy).toEqual([{ surfacedAt: "desc" }]);
    expect(args.take).toBe(200);
    await app.close();
  });

  it("still ranks each tier lane by priority within the fetched window", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/inbox/firewall/" });
    const body = res.json() as {
      tiers: Record<string, Array<{ id: string }>>;
      summary: { total: number };
    };
    // The newest-but-lowest-priority item is PRESENT (the freeze bug evicted
    // exactly this class of row), and within a lane priority still ranks.
    expect(body.tiers.SILENT.map((i) => i.id)).toEqual(["att-new-low"]);
    expect(body.tiers.PUSH.map((i) => i.id)).toEqual(["att-old-high"]);
    expect(body.tiers.QUEUE.map((i) => i.id)).toEqual([
      "att-queue-older-high",
      "att-queue-newer-low",
    ]);
    expect(body.summary.total).toBe(4);
    await app.close();
  });
});
