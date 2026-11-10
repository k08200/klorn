/**
 * HTTP surface of Done / Later keyed by email id (the bundled mobile app's
 * Mail list holds EmailMessage ids, not attention ids):
 *   POST /api/inbox/firewall/email/:emailId/dismiss
 *   POST /api/inbox/firewall/email/:emailId/snooze   { snoozeUntil }
 * Auth is the plugin's requireAuth hook; ownership is attention-by-email.ts
 * (pinned in attention-by-email.test.ts). The id-keyed /:id/dismiss and
 * /:id/snooze the web and Mac clients call answer exactly as before.
 */
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const byEmail = vi.hoisted(() => ({
  dismissEmailAttention: vi.fn(),
  snoozeEmailAttention: vi.fn(),
}));
const dismissAttentionItem = vi.hoisted(() => vi.fn());
const snoozeAttentionItem = vi.hoisted(() => vi.fn());
const requireAuth = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../judge/attention-by-email.js", () => byEmail);
vi.mock("../judge/attention-dismiss.js", () => ({ dismissAttentionItem }));
vi.mock("../judge/attention-snooze.js", () => ({ snoozeAttentionItem }));
// Done / Later stamp the decision ledger (judge/user-outcome.ts); pinned in
// routes-firewall-outcome.test.ts.
vi.mock("../db.js", () => {
  const prisma = {
    decisionLabel: { updateMany: vi.fn(async () => ({ count: 1 })) },
    attentionItem: { findFirst: vi.fn(async () => null) },
  };
  return { prisma, db: prisma };
});
vi.mock("../auth.js", () => ({
  resolveEffectiveJwtSecret: () => "test-secret",
  requireAuth,
  getUserId: vi.fn(() => "user-1"),
}));
vi.mock("../billing/entitlement-guard.js", () => ({ requireAppAccess: vi.fn(async () => {}) }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../mail/activity-sync.js", () => ({ ensureRecentMailSync: vi.fn(async () => {}) }));
vi.mock("../mail/gmail.js", () => ({ ensureFreshGmailWatch: vi.fn(async () => {}) }));
vi.mock("../learning/trust-score.js", () => ({ getTrustScoresBulk: vi.fn(async () => new Map()) }));

const { firewallRoutes } = await import("../routes/firewall.js");

const post = async (url: string, payload?: unknown) => {
  const app = Fastify();
  await app.register(firewallRoutes, { prefix: "/api/inbox/firewall" });
  const res = await app.inject({ method: "POST", url, payload: payload as object });
  await app.close();
  return res;
};

const FUTURE = "2030-01-01T09:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
  requireAuth.mockImplementation(async () => {});
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
});

describe("auth", () => {
  it("both routes sit behind requireAuth: a refused token reaches nothing", async () => {
    requireAuth.mockImplementation((async (
      _req: unknown,
      reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    ) => reply.code(401).send({ error: "Unauthorized" })) as never);
    const dismiss = await post("/api/inbox/firewall/email/email-1/dismiss");
    const snooze = await post("/api/inbox/firewall/email/email-1/snooze", { snoozeUntil: FUTURE });
    expect(dismiss.statusCode).toBe(401);
    expect(snooze.statusCode).toBe(401);
    expect(byEmail.dismissEmailAttention).not.toHaveBeenCalled();
    expect(byEmail.snoozeEmailAttention).not.toHaveBeenCalled();
  });
});

describe("POST /email/:emailId/dismiss", () => {
  it("dismisses the calling user's item for that email and returns its id", async () => {
    const res = await post("/api/inbox/firewall/email/email-1/dismiss");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, itemId: "item-1", alreadyClear: false });
    expect(byEmail.dismissEmailAttention).toHaveBeenCalledWith("user-1", "email-1");
  });

  it("answers alreadyClear (200) when there is nothing open to clear", async () => {
    byEmail.dismissEmailAttention.mockResolvedValue({ ok: true, itemId: null, alreadyClear: true });
    const res = await post("/api/inbox/firewall/email/email-1/dismiss");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, itemId: null, alreadyClear: true });
  });

  it("is 404 for mail that is not the caller's", async () => {
    byEmail.dismissEmailAttention.mockResolvedValue({ ok: false, reason: "not_found" });
    const res = await post("/api/inbox/firewall/email/theirs/dismiss");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ ok: false, code: "not_found" });
  });

  it("refuses an oversized id before touching anything", async () => {
    // The router's own param cap (414) answers before the schema's (400) would.
    const res = await post(`/api/inbox/firewall/email/${"x".repeat(200)}/dismiss`);
    expect([400, 414]).toContain(res.statusCode);
    expect(byEmail.dismissEmailAttention).not.toHaveBeenCalled();
  });
});

describe("POST /email/:emailId/snooze", () => {
  it("snoozes until the given time and echoes it", async () => {
    const res = await post("/api/inbox/firewall/email/email-1/snooze", { snoozeUntil: FUTURE });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      itemId: "item-1",
      alreadyClear: false,
      snoozedUntil: FUTURE,
    });
    expect(byEmail.snoozeEmailAttention).toHaveBeenCalledWith(
      "user-1",
      "email-1",
      new Date(FUTURE),
    );
  });

  it("an already-clear item carries no snoozedUntil (nothing was snoozed)", async () => {
    byEmail.snoozeEmailAttention.mockResolvedValue({
      ok: true,
      itemId: "item-1",
      alreadyClear: true,
    });
    const res = await post("/api/inbox/firewall/email/email-1/snooze", { snoozeUntil: FUTURE });
    expect(res.json()).toEqual({ ok: true, itemId: "item-1", alreadyClear: true });
  });

  it.each([
    ["not a date"],
    ["2001-01-01T00:00:00.000Z"],
  ])("400s for a snoozeUntil that is not a future time (%s)", async (snoozeUntil) => {
    const res = await post("/api/inbox/firewall/email/email-1/snooze", { snoozeUntil });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ ok: false, code: "invalid_snooze_until" });
    expect(byEmail.snoozeEmailAttention).not.toHaveBeenCalled();
  });

  it("400s for a missing body field", async () => {
    const res = await post("/api/inbox/firewall/email/email-1/snooze", {});
    expect(res.statusCode).toBe(400);
    expect(byEmail.snoozeEmailAttention).not.toHaveBeenCalled();
  });

  it("is 404 for mail that is not the caller's", async () => {
    byEmail.snoozeEmailAttention.mockResolvedValue({ ok: false, reason: "not_found" });
    const res = await post("/api/inbox/firewall/email/theirs/snooze", { snoozeUntil: FUTURE });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("id-keyed routes (web, Mac) are unchanged", () => {
  it("POST /:id/dismiss still dismisses by attention id", async () => {
    const res = await post("/api/inbox/firewall/item-9/dismiss");
    expect(res.json()).toEqual({ ok: true });
    expect(dismissAttentionItem).toHaveBeenCalledWith("user-1", "item-9");
    expect(byEmail.dismissEmailAttention).not.toHaveBeenCalled();
  });

  it("POST /:id/snooze still snoozes by attention id", async () => {
    const res = await post("/api/inbox/firewall/item-9/snooze", { snoozeUntil: FUTURE });
    expect(res.json()).toEqual({ ok: true, snoozedUntil: FUTURE });
    expect(snoozeAttentionItem).toHaveBeenCalledWith("user-1", "item-9", new Date(FUTURE));
    expect(byEmail.snoozeEmailAttention).not.toHaveBeenCalled();
  });
});
