/**
 * `todayPush` on GET /api/inbox/firewall — Today's "Needs you now" window
 * (founder decision, 2026-10-23). The Mac's Today composes from this one
 * response, so the server names which PUSH cards fall inside the window
 * (mail received in the last TODAY_PUSH_WINDOW_HOURS; an item with no mail
 * behind it by its createdAt). The lanes themselves are untouched: Mail's
 * PUSH view and the summary still hold every open PUSH card.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../mail/activity-sync.js", () => ({
  ensureRecentMailSync: vi.fn(async () => {}),
}));

const NOW = new Date("2026-10-23T12:00:00.000Z");
const MINUTE_MS = 60_000;
const ago = (hours: number, minutes = 0) =>
  new Date(NOW.getTime() - (hours * 60 + minutes) * MINUTE_MS);

const item = (id: string, source: string, sourceId: string, tier: string, createdAt: Date) => ({
  id,
  source,
  sourceId,
  type: "REPLY_NEEDED",
  title: id,
  tier,
  tierReason: "fixture",
  priority: 50,
  surfacedAt: ago(1),
  createdAt,
  inputHash: null,
});

const attentionRows = [
  // Received 71h59m ago: inside, even though the item itself is old.
  item("att-in", "EMAIL", "em-in", "PUSH", ago(300)),
  // Received 72h01m ago: outside, even though the item was created just now.
  item("att-out", "EMAIL", "em-out", "PUSH", ago(0, 5)),
  // No mail behind it: its createdAt decides.
  item("att-nomail-in", "GITHUB", "gh-1", "PUSH", ago(71, 59)),
  item("att-nomail-out", "GITHUB", "gh-2", "PUSH", ago(72, 1)),
  // Not PUSH: never part of the window.
  item("att-queue", "EMAIL", "em-queue", "QUEUE", ago(1)),
];

const mail = (id: string, receivedAt: Date) => ({
  id,
  gmailId: `g-${id}`,
  subject: id,
  from: "alice@example.com",
  snippet: "hi",
  labels: ["INBOX"],
  threadId: `t-${id}`,
  linkedInboxAccountId: null,
  receivedAt,
});

const emailRows = [
  mail("em-in", ago(71, 59)),
  mail("em-out", ago(72, 1)),
  mail("em-queue", ago(1)),
];

vi.mock("../db.js", () => ({
  prisma: {
    attentionItem: { findMany: vi.fn(async () => attentionRows) },
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
vi.mock("../mail/gmail.js", () => ({ ensureFreshGmailWatch: vi.fn(async () => {}) }));
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

interface Wire {
  tiers: Record<string, Array<{ id: string }>>;
  summary: Record<string, number>;
  todayPush?: { windowHours: number; since: string; ids: string[] };
}

async function read(): Promise<Wire> {
  const app = Fastify();
  await app.register(firewallRoutes, { prefix: "/api/inbox/firewall" });
  const res = await app.inject({ method: "GET", url: "/api/inbox/firewall/" });
  expect(res.statusCode).toBe(200);
  await app.close();
  return res.json() as Wire;
}

describe("GET /api/inbox/firewall — todayPush window", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names the PUSH cards received in the last 72h (createdAt when there is no mail)", async () => {
    const body = await read();
    expect(body.todayPush).toEqual({
      windowHours: 72,
      since: "2026-10-20T12:00:00.000Z",
      ids: ["att-in", "att-nomail-in"],
    });
  });

  it("leaves the lanes and the summary whole: Mail still lists every open PUSH card", async () => {
    const body = await read();
    expect(body.tiers.PUSH.map((row) => row.id).sort()).toEqual(
      ["att-in", "att-nomail-in", "att-nomail-out", "att-out"].sort(),
    );
    expect(body.summary.PUSH).toBe(4);
    expect(body.tiers.QUEUE.map((row) => row.id)).toEqual(["att-queue"]);
  });
});
