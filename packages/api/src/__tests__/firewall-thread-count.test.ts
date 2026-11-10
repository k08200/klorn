/**
 * `threadCount` on GET /api/inbox/firewall EMAIL items.
 *
 * The route collapses a multi-message conversation to one card; the card now
 * carries how many of the list's EMAIL items that thread holds, so the Mac's
 * row chip (shows from 2) agrees with the web's `GET /api/email?threads=1`.
 * Same thread definition as the web (email-lanes.ts THREAD_KEY): the thread id
 * is scoped by account, and a mail without a thread id is its own thread.
 */

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

vi.mock("../mail/activity-sync.js", () => ({
  ensureRecentMailSync: vi.fn(async () => {}),
}));

const at = (id: string, sourceId: string, priority: number) => ({
  id,
  source: "EMAIL",
  sourceId,
  type: "REPLY_NEEDED",
  title: id,
  tier: "QUEUE",
  tierReason: "fixture",
  priority,
  surfacedAt: new Date("2026-10-20T00:00:00Z"),
  inputHash: null,
});

// Pre-ordered [priority desc] like the real query: a1 is t1's kept card.
const attentionRows = [
  at("att-a1", "em-a1", 90),
  at("att-a2", "em-a2", 80),
  at("att-a3", "em-a3", 70),
  at("att-other-account", "em-other-account", 60),
  at("att-solo", "em-solo", 50),
  at("att-nothread-1", "em-nothread-1", 40),
  at("att-nothread-2", "em-nothread-2", 30),
];

const mail = (id: string, threadId: string | null, linkedInboxAccountId: string | null) => ({
  id,
  gmailId: `g-${id}`,
  subject: id,
  from: "alice@example.com",
  snippet: "hi",
  labels: ["INBOX"],
  threadId,
  linkedInboxAccountId,
});

const emailRows = [
  mail("em-a1", "t1", null),
  mail("em-a2", "t1", null),
  mail("em-a3", "t1", null),
  // Same provider thread id on another account: a different thread.
  mail("em-other-account", "t1", "li-1"),
  mail("em-solo", "t2", null),
  mail("em-nothread-1", null, null),
  mail("em-nothread-2", null, null),
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
  tiers: Record<string, Array<{ id: string; email?: { threadCount?: number } }>>;
}

async function countsFor(url: string): Promise<Record<string, number | undefined>> {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url });
  expect(res.statusCode).toBe(200);
  const body = res.json() as FirewallResponseWire;
  await app.close();
  return Object.fromEntries(
    Object.values(body.tiers)
      .flat()
      .map((row) => [row.id, row.email?.threadCount]),
  );
}

describe("GET /api/inbox/firewall — threadCount on collapsed EMAIL cards", () => {
  it("carries the thread's message count on the kept card, 1 on singletons", async () => {
    expect(await countsFor("/api/inbox/firewall/")).toEqual({
      "att-a1": 3,
      "att-other-account": 1,
      "att-solo": 1,
      "att-nothread-1": 1,
      "att-nothread-2": 1,
    });
  });

  it("counts inside the scoped view (inbox=li-1 sees only its own message)", async () => {
    expect(await countsFor("/api/inbox/firewall/?inbox=li-1")).toEqual({
      "att-other-account": 1,
    });
  });
});
