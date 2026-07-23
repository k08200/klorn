/**
 * Per-inbox scoping of GET /api/inbox/firewall (`?inbox=` query param).
 *
 * The desktop's tier list/counts come from this route; after multi-inbox
 * landed, the inbox selector changed the mail list but never the firewall
 * queue because the route had no account dimension. Scope semantics mirror
 * routes/email.ts:
 *   - absent / "all"  → every inbox (100% backward compatible)
 *   - "primary"       → items whose email lives on the primary account
 *                       (linkedInboxAccountId null) PLUS items with no email
 *                       at all (GitHub etc. — primary is the home workspace)
 *   - a linked id     → only items whose email lives on that linked inbox
 *
 * The userId scope on every query is the IDOR guard — a foreign or malformed
 * id can only ever match the caller's own rows (zero).
 */

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

const attentionRows = [
  {
    id: "att-primary",
    source: "EMAIL",
    sourceId: "em-primary",
    type: "REPLY_NEEDED",
    title: "Primary-inbox mail",
    tier: "PUSH",
    tierReason: "fixture",
    priority: 90,
    surfacedAt: new Date("2026-07-20T00:00:00Z"),
    inputHash: null,
  },
  {
    id: "att-linked",
    source: "EMAIL",
    sourceId: "em-linked",
    type: "REPLY_NEEDED",
    title: "Linked-inbox mail",
    tier: "QUEUE",
    tierReason: "fixture",
    priority: 60,
    surfacedAt: new Date("2026-07-20T00:00:00Z"),
    inputHash: null,
  },
  {
    id: "att-github",
    source: "GITHUB",
    sourceId: "gh-1",
    type: "FYI",
    title: "CI failed on main",
    tier: "QUEUE",
    tierReason: "fixture",
    priority: 50,
    surfacedAt: new Date("2026-07-20T00:00:00Z"),
    inputHash: null,
  },
];

const emailRows = [
  {
    id: "em-primary",
    gmailId: "g-primary",
    subject: "Primary-inbox mail",
    from: "alice@example.com",
    snippet: "hi",
    labels: ["INBOX"],
    threadId: "t-primary",
    linkedInboxAccountId: null,
  },
  {
    id: "em-linked",
    gmailId: "g-linked",
    subject: "Linked-inbox mail",
    from: "bob@example.com",
    snippet: "yo",
    labels: ["INBOX"],
    threadId: "t-linked",
    linkedInboxAccountId: "li-1",
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
  tiers: Record<string, Array<{ id: string }>>;
  summary: { total: number };
}

function itemIds(body: FirewallResponseWire): string[] {
  return Object.values(body.tiers)
    .flat()
    .map((row) => row.id)
    .sort();
}

describe("GET /api/inbox/firewall — per-inbox scoping", () => {
  it("returns every item when the inbox param is absent (backward compatible)", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/inbox/firewall/" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as FirewallResponseWire;
    expect(itemIds(body)).toEqual(["att-github", "att-linked", "att-primary"]);
    expect(body.summary.total).toBe(3);
    await app.close();
  });

  it("returns every item for inbox=all", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/inbox/firewall/?inbox=all" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as FirewallResponseWire;
    expect(itemIds(body)).toEqual(["att-github", "att-linked", "att-primary"]);
    expect(body.summary.total).toBe(3);
    await app.close();
  });

  it("inbox=primary keeps primary-account mail AND non-email items, drops linked mail", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/inbox/firewall/?inbox=primary" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as FirewallResponseWire;
    expect(itemIds(body)).toEqual(["att-github", "att-primary"]);
    expect(body.summary.total).toBe(2);
    await app.close();
  });

  it("inbox=<linked id> keeps only that inbox's mail (non-email items excluded)", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/inbox/firewall/?inbox=li-1" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as FirewallResponseWire;
    expect(itemIds(body)).toEqual(["att-linked"]);
    expect(body.summary.total).toBe(1);
    await app.close();
  });

  it("an unknown/foreign linked id matches zero rows (userId scope is the IDOR guard)", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/inbox/firewall/?inbox=nope" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as FirewallResponseWire;
    expect(itemIds(body)).toEqual([]);
    expect(body.summary.total).toBe(0);
    await app.close();
  });
});
