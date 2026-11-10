/**
 * GET /api/inbox/firewall renders deterministic tier reasons in the CLIENT's
 * UI language when it names one (`lang`, then Accept-Language), and only
 * falls back to the stored notification language when it does not. A user
 * whose push language is English but whose app is Korean must not read
 * English reasons on Korean screens.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STATIC_TIER_REASONS } from "../judge/tier-reason-strings.js";

const configFindUnique = vi.hoisted(() => vi.fn(async (_args: unknown) => null as unknown));

vi.mock("../mail/activity-sync.js", () => ({
  ensureRecentMailSync: vi.fn(async () => {}),
}));

vi.mock("../db.js", () => ({
  prisma: {
    attentionItem: {
      findMany: vi.fn(async () => [
        {
          id: "att-1",
          source: "COMMITMENT",
          sourceId: "cm-1",
          type: "FYI",
          title: "Promised a follow-up",
          tier: "QUEUE",
          tierReason: "action.awaitingApproval",
          priority: 50,
          surfacedAt: new Date("2026-10-16T00:00:00Z"),
          inputHash: null,
        },
        {
          id: "att-2",
          source: "COMMITMENT",
          sourceId: "cm-2",
          type: "FYI",
          title: "Judge-written",
          tier: "QUEUE",
          tierReason: "Investor asked for a call",
          priority: 40,
          surfacedAt: new Date("2026-10-16T00:00:00Z"),
          inputHash: null,
        },
      ]),
    },
    pendingAction: { findMany: vi.fn(async () => []) },
    emailMessage: { findMany: vi.fn(async () => []) },
    automationConfig: { findUnique: configFindUnique },
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

const { firewallRoutes } = await import("../routes/firewall.js");

interface Wire {
  tiers: Record<string, Array<{ id: string; tierReason: string | null }>>;
}

async function reasons(url: string, headers: Record<string, string> = {}) {
  const app = Fastify();
  await app.register(firewallRoutes, { prefix: "/api/inbox/firewall" });
  const res = await app.inject({ method: "GET", url, headers });
  await app.close();
  expect(res.statusCode).toBe(200);
  const rows = Object.values((res.json() as Wire).tiers).flat();
  return {
    res,
    keyed: rows.find((r) => r.id === "att-1")?.tierReason,
    prose: rows.find((r) => r.id === "att-2")?.tierReason,
  };
}

const COPY = STATIC_TIER_REASONS["action.awaitingApproval"];

beforeEach(() => {
  configFindUnique.mockReset();
  configFindUnique.mockResolvedValue({ notificationLanguage: "en" });
});

describe("GET /api/inbox/firewall — reader language", () => {
  it("lang=ko renders Korean even though the stored language is English", async () => {
    const { keyed, prose } = await reasons("/api/inbox/firewall/?lang=ko");
    expect(keyed).toBe(COPY.ko);
    // LLM prose is never re-rendered per request.
    expect(prose).toBe("Investor asked for a call");
  });

  it.each(["en", "ko", "ja", "zh", "es", "fr", "de"] as const)("lang=%s", async (lang) => {
    const { keyed } = await reasons(`/api/inbox/firewall/?lang=${lang}`);
    expect(keyed).toBe(COPY[lang]);
  });

  it("an unknown lang is ignored (no 400) and the stored language answers", async () => {
    configFindUnique.mockResolvedValue({ notificationLanguage: "de" });
    const { keyed } = await reasons("/api/inbox/firewall/?lang=xx");
    expect(keyed).toBe(COPY.de);
  });

  it("Accept-Language is used when lang is absent", async () => {
    const { keyed, res } = await reasons("/api/inbox/firewall/", {
      "accept-language": "ja-JP,ja;q=0.9,en;q=0.5",
    });
    expect(keyed).toBe(COPY.ja);
    expect(String(res.headers.vary)).toContain("Accept-Language");
  });

  it("lang beats Accept-Language", async () => {
    const { keyed } = await reasons("/api/inbox/firewall/?lang=fr", { "accept-language": "ko" });
    expect(keyed).toBe(COPY.fr);
  });

  it("with neither, the stored notification language is used", async () => {
    configFindUnique.mockResolvedValue({ notificationLanguage: "es" });
    const { keyed } = await reasons("/api/inbox/firewall/");
    expect(keyed).toBe(COPY.es);
  });

  it("composes with the inbox scope param", async () => {
    const { keyed } = await reasons("/api/inbox/firewall/?inbox=primary&lang=zh");
    expect(keyed).toBe(COPY.zh);
  });
});
