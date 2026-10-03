/**
 * GET /api/inbox/firewall must never put a row in the retired AUTO lane.
 *
 * AUTO is v1 storage vocabulary (docs/product-vocabulary.md, "Legacy values"):
 * legacy rows still carry it, but every user-facing surface shows exactly five
 * lanes. The board used to render an "AUTO" strip whenever summary.AUTO > 0;
 * the route now folds AUTO into QUEUE (the visible default) on read. The AUTO
 * key itself stays on the wire, always empty, because the desktop decodes it
 * as a required field.
 */

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

vi.mock("../mail/activity-sync.js", () => ({
  ensureRecentMailSync: vi.fn(async () => {}),
}));

const attentionRows = [
  {
    id: "att-legacy-auto",
    source: "EMAIL",
    sourceId: "em-auto",
    type: "FYI",
    title: "Legacy v1 AUTO row",
    tier: "AUTO",
    tierReason: "fixture",
    priority: 40,
    surfacedAt: new Date("2026-07-20T00:00:00Z"),
    inputHash: null,
  },
  {
    id: "att-queue",
    source: "EMAIL",
    sourceId: "em-queue",
    type: "REPLY_NEEDED",
    title: "Ordinary QUEUE row",
    tier: "QUEUE",
    tierReason: "fixture",
    priority: 60,
    surfacedAt: new Date("2026-07-20T00:00:00Z"),
    inputHash: null,
  },
];

const emailRows = [
  {
    id: "em-auto",
    gmailId: "g-auto",
    subject: "Legacy v1 AUTO row",
    from: "receipts@example.com",
    snippet: "receipt",
    labels: ["INBOX"],
    threadId: "t-auto",
    linkedInboxAccountId: null,
  },
  {
    id: "em-queue",
    gmailId: "g-queue",
    subject: "Ordinary QUEUE row",
    from: "bob@example.com",
    snippet: "yo",
    labels: ["INBOX"],
    threadId: "t-queue",
    linkedInboxAccountId: null,
  },
];

vi.mock("../db.js", () => ({
  prisma: {
    attentionItem: {
      findMany: vi.fn(async () => attentionRows),
    },
    pendingAction: { findMany: vi.fn(async () => []) },
    emailMessage: {
      // Serves both firewall fetches: the by-gmailId call (where.gmailId.in)
      // and the by-id call (where.id.in). Anything else matches zero rows.
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

// Keep the classifier read-path invariant honest here too
// (firewall-classifier-readpath.test.ts).
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

interface FirewallResponseWire {
  tiers: Record<string, Array<{ id: string; tier: string }>>;
  summary: Record<string, number>;
}

describe("GET /api/inbox/firewall — retired AUTO lane", () => {
  it("folds a legacy AUTO row into QUEUE and keeps an empty AUTO bucket", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/inbox/firewall/" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as FirewallResponseWire;

    expect(body.tiers.AUTO).toEqual([]);
    expect(body.summary.AUTO).toBe(0);

    const queueIds = body.tiers.QUEUE.map((row) => row.id).sort();
    expect(queueIds).toEqual(["att-legacy-auto", "att-queue"]);
    expect(body.summary.QUEUE).toBe(2);
    expect(body.summary.total).toBe(2);

    const legacy = body.tiers.QUEUE.find((row) => row.id === "att-legacy-auto");
    expect(legacy?.tier).toBe("QUEUE");
    await app.close();
  });
});
