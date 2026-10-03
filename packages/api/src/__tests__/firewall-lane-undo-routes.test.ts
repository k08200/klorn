/**
 * HTTP surface of the reversible lane override (productization plan P4):
 *   POST /api/inbox/firewall/:id            — gains undoToken while the flag is on
 *   POST /api/inbox/firewall/:id/undo       — reverse it
 *   POST /api/inbox/firewall/email/:emailId — the same override, keyed by email
 * With KEYBOARD_TRIAGE off the first answers exactly as before and the other
 * two are indistinguishable from an unknown route.
 */
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const override = vi.hoisted(() => ({
  overrideAttentionTier: vi.fn(),
  undoAttentionOverride: vi.fn(),
  findEmailAttentionItemId: vi.fn(),
  confirmAttentionTier: vi.fn(),
}));

vi.mock("../judge/attention-override.js", () => override);
vi.mock("../db.js", () => ({ prisma: {}, db: {} }));
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

async function buildApp() {
  const app = Fastify();
  await app.register(firewallRoutes, { prefix: "/api/inbox/firewall" });
  return app;
}

const post = async (url: string, payload?: unknown) => {
  const app = await buildApp();
  const res = await app.inject({ method: "POST", url, payload: payload as object });
  await app.close();
  return res;
};

const UNDO = { token: "tok-1", expiresAt: "2026-10-03T09:00:30.000Z" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("KEYBOARD_TRIAGE", "true");
  override.overrideAttentionTier.mockResolvedValue({ ok: true, tier: "QUEUE", undo: UNDO });
  override.undoAttentionOverride.mockResolvedValue({
    ok: true,
    tier: "PUSH",
    alreadyUndone: false,
  });
  override.findEmailAttentionItemId.mockResolvedValue("item-1");
});

afterEach(() => vi.unstubAllEnvs());

describe("flag off", () => {
  beforeEach(() => {
    vi.stubEnv("KEYBOARD_TRIAGE", "");
    override.overrideAttentionTier.mockResolvedValue({ ok: true, tier: "QUEUE" });
  });

  it("POST /:id answers exactly as before", async () => {
    const res = await post("/api/inbox/firewall/item-1", { tier: "QUEUE" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, tier: "QUEUE" });
  });

  it("the undo and by-email routes look like unknown routes and run nothing", async () => {
    const unknown = await post("/api/inbox/firewall/item-1/no-such-route", {});
    for (const [url, body] of [
      ["/api/inbox/firewall/item-1/undo", { undoToken: "tok-1" }],
      ["/api/inbox/firewall/email/email-1", { tier: "QUEUE" }],
    ] as const) {
      const res = await post(url, body);
      expect(res.statusCode).toBe(404);
      expect(Object.keys(res.json()).sort()).toEqual(Object.keys(unknown.json()).sort());
    }
    expect(override.undoAttentionOverride).not.toHaveBeenCalled();
    expect(override.overrideAttentionTier).not.toHaveBeenCalled();
  });
});

describe("flag on", () => {
  it("POST /:id returns the undo handle", async () => {
    const res = await post("/api/inbox/firewall/item-1", { tier: "QUEUE" });
    expect(res.json()).toEqual({
      ok: true,
      tier: "QUEUE",
      undoToken: "tok-1",
      undoExpiresAt: UNDO.expiresAt,
    });
  });

  it("POST /:id/undo reverses for the calling user only", async () => {
    const res = await post("/api/inbox/firewall/item-1/undo", { undoToken: "tok-1" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, tier: "PUSH", alreadyUndone: false });
    expect(override.undoAttentionOverride).toHaveBeenCalledWith("user-1", "item-1", "tok-1");
  });

  it.each([
    ["not_found", 404, "not_found"],
    ["expired", 409, "undo_expired"],
    ["conflict", 409, "undo_conflict"],
  ] as const)("maps %s to %i %s", async (reason, status, code) => {
    override.undoAttentionOverride.mockResolvedValue({ ok: false, reason });
    const res = await post("/api/inbox/firewall/item-1/undo", { undoToken: "tok-1" });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ ok: false, code });
  });

  it("rejects a missing or oversized token before touching anything", async () => {
    expect((await post("/api/inbox/firewall/item-1/undo", {})).statusCode).toBe(400);
    const long = await post("/api/inbox/firewall/item-1/undo", { undoToken: "x".repeat(200) });
    expect(long.statusCode).toBe(400);
    expect(override.undoAttentionOverride).not.toHaveBeenCalled();
  });

  it("POST /email/:emailId resolves the user's own item and overrides it", async () => {
    const res = await post("/api/inbox/firewall/email/email-1", { tier: "INFO" });
    expect(override.findEmailAttentionItemId).toHaveBeenCalledWith("user-1", "email-1");
    expect(override.overrideAttentionTier).toHaveBeenCalledWith("user-1", "item-1", "INFO");
    expect(res.json()).toEqual({
      ok: true,
      tier: "QUEUE",
      itemId: "item-1",
      undoToken: "tok-1",
      undoExpiresAt: UNDO.expiresAt,
    });
  });

  it("POST /email/:emailId is 404 for mail that is not judged or not the user's", async () => {
    override.findEmailAttentionItemId.mockResolvedValue(null);
    const res = await post("/api/inbox/firewall/email/someone-elses", { tier: "INFO" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ ok: false, code: "not_found" });
    expect(override.overrideAttentionTier).not.toHaveBeenCalled();
  });

  it("POST /email/:emailId refuses the retired AUTO lane", async () => {
    const res = await post("/api/inbox/firewall/email/email-1", { tier: "AUTO" });
    expect(res.statusCode).toBe(400);
    expect(override.overrideAttentionTier).not.toHaveBeenCalled();
  });
});
