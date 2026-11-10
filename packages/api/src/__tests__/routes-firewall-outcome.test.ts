/**
 * Decision-ledger stamps on the firewall's Done / Later routes:
 *   POST /:id/dismiss, /email/:emailId/dismiss → DISMISSED
 *   POST /:id/snooze,  /email/:emailId/snooze  → SNOOZED
 * Item-id routes resolve the item's (source, sourceId) inside the caller's own
 * items; email-id routes stamp the caller's EMAIL row directly. Exactly once
 * per success, nothing on a 404 or a bad snooze time, and the response is the
 * same when the ledger write fails.
 */
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const byEmail = vi.hoisted(() => ({
  dismissEmailAttention: vi.fn(),
  snoozeEmailAttention: vi.fn(),
}));
const dismissAttentionItem = vi.hoisted(() => vi.fn());
const snoozeAttentionItem = vi.hoisted(() => vi.fn());
const db = vi.hoisted(() => ({
  labelUpdateMany: vi.fn(),
  itemFindFirst: vi.fn(),
}));

vi.mock("../judge/attention-by-email.js", () => byEmail);
vi.mock("../judge/attention-dismiss.js", () => ({ dismissAttentionItem }));
vi.mock("../judge/attention-snooze.js", () => ({ snoozeAttentionItem }));
vi.mock("../db.js", () => {
  const prisma = {
    decisionLabel: { updateMany: db.labelUpdateMany },
    attentionItem: { findFirst: db.itemFindFirst },
  };
  return { prisma, db: prisma };
});
vi.mock("../auth.js", () => ({
  resolveEffectiveJwtSecret: () => "test-secret",
  requireAuth: vi.fn(async () => {}),
  getUserId: vi.fn(() => "user-1"),
}));
vi.mock("../billing/entitlement-guard.js", () => ({ requireAppAccess: vi.fn(async () => {}) }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../mail/activity-sync.js", () => ({ ensureRecentMailSync: vi.fn(async () => {}) }));
vi.mock("../mail/gmail.js", () => ({ ensureFreshGmailWatch: vi.fn(async () => {}) }));
vi.mock("../learning/trust-score.js", () => ({ getTrustScoresBulk: vi.fn(async () => new Map()) }));

const { firewallRoutes } = await import("../routes/firewall.js");

const FUTURE = "2030-01-01T09:00:00.000Z";

const post = async (url: string, payload?: unknown) => {
  const app = Fastify();
  await app.register(firewallRoutes, { prefix: "/api/inbox/firewall" });
  const res = await app.inject({ method: "POST", url, payload: payload as object });
  await app.close();
  return res;
};

/** Every stamp the request produced, once the fire-and-forget work settles. */
async function stamps() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return db.labelUpdateMany.mock.calls.map((c) => c[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  byEmail.dismissEmailAttention.mockResolvedValue({
    ok: true,
    itemId: "item-1",
    alreadyClear: false,
  });
  byEmail.snoozeEmailAttention.mockResolvedValue({
    ok: true,
    itemId: "item-1",
    alreadyClear: false,
  });
  dismissAttentionItem.mockResolvedValue({ ok: true });
  snoozeAttentionItem.mockResolvedValue({ ok: true });
  db.itemFindFirst.mockResolvedValue({ source: "EMAIL", sourceId: "email-9" });
  db.labelUpdateMany.mockResolvedValue({ count: 1 });
});

const CASES = [
  {
    name: "dismiss by item",
    url: "/api/inbox/firewall/item-1/dismiss",
    body: undefined,
    column: "dismissedAt",
    sourceId: "email-9",
  },
  {
    name: "snooze by item",
    url: "/api/inbox/firewall/item-1/snooze",
    body: { snoozeUntil: FUTURE },
    column: "snoozedAt",
    sourceId: "email-9",
  },
  {
    name: "Done by email",
    url: "/api/inbox/firewall/email/email-1/dismiss",
    body: undefined,
    column: "dismissedAt",
    sourceId: "email-1",
  },
  {
    name: "Later by email",
    url: "/api/inbox/firewall/email/email-1/snooze",
    body: { snoozeUntil: FUTURE },
    column: "snoozedAt",
    sourceId: "email-1",
  },
];

describe("firewall Done / Later stamp the decision ledger", () => {
  it.each(CASES)("$name stamps $column exactly once", async ({ url, body, column, sourceId }) => {
    const res = await post(url, body);

    expect(res.statusCode).toBe(200);
    expect(await stamps()).toEqual([
      {
        where: { userId: "user-1", source: "EMAIL", sourceId, [column]: null },
        data: { [column]: expect.any(Date) },
      },
    ]);
  });

  it.each(CASES)("$name answers exactly the same when the ledger write fails", async ({
    url,
    body,
  }) => {
    const ok = await post(url, body);
    db.labelUpdateMany.mockRejectedValue(new Error("ledger down"));
    const failed = await post(url, body);

    expect(failed.statusCode).toBe(ok.statusCode);
    expect(failed.body).toBe(ok.body);
  });

  it("looks the item up within the caller's own items", async () => {
    await post("/api/inbox/firewall/item-1/dismiss");
    await stamps();
    expect(db.itemFindFirst.mock.calls[0][0].where).toEqual({ id: "item-1", userId: "user-1" });
  });

  it("stamps the item's own source when it isn't mail", async () => {
    db.itemFindFirst.mockResolvedValue({ source: "GITHUB", sourceId: "gh-1" });
    await post("/api/inbox/firewall/item-1/dismiss");
    expect((await stamps())[0].where).toMatchObject({ source: "GITHUB", sourceId: "gh-1" });
  });

  it("stamps nothing for a Done or Later that changed nothing (already clear)", async () => {
    byEmail.dismissEmailAttention.mockResolvedValue({ ok: true, itemId: null, alreadyClear: true });
    byEmail.snoozeEmailAttention.mockResolvedValue({ ok: true, itemId: "i", alreadyClear: true });
    const done = await post("/api/inbox/firewall/email/email-1/dismiss");
    const later = await post("/api/inbox/firewall/email/email-1/snooze", { snoozeUntil: FUTURE });

    expect([done.statusCode, later.statusCode]).toEqual([200, 200]);
    expect(await stamps()).toEqual([]);
  });

  it.each(CASES)("$name answers while the ledger write is still hanging", async ({ url, body }) => {
    db.labelUpdateMany.mockReturnValue(new Promise(() => {}));
    db.itemFindFirst.mockReturnValue(new Promise(() => {}));
    const res = await post(url, body);
    expect(res.statusCode).toBe(200);
  });

  it("stamps nothing on a 404", async () => {
    dismissAttentionItem.mockResolvedValue({ ok: false });
    byEmail.snoozeEmailAttention.mockResolvedValue({ ok: false, reason: "not_found" });
    const a = await post("/api/inbox/firewall/theirs/dismiss");
    const b = await post("/api/inbox/firewall/email/theirs/snooze", { snoozeUntil: FUTURE });

    expect([a.statusCode, b.statusCode]).toEqual([404, 404]);
    expect(await stamps()).toEqual([]);
    expect(db.itemFindFirst).not.toHaveBeenCalled();
  });

  it("stamps nothing for a snooze time in the past", async () => {
    const res = await post("/api/inbox/firewall/item-1/snooze", {
      snoozeUntil: "2001-01-01T00:00:00.000Z",
    });
    expect(res.statusCode).toBe(400);
    expect(await stamps()).toEqual([]);
  });
});
