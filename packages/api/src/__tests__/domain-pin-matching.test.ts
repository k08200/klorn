/**
 * Domain pins — fetchPinnedTier resolves PIN_TIER rules at two levels and no
 * more: exact address (`conditions.from`), then exact domain
 * (`conditions.fromDomain`). Address beats domain; matching is equality, not
 * substring — a rank-0 rule that could fuzzy-match would override the LLM on
 * mail it was never authored for. Prisma is mocked at the db.js boundary.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const attentionFindMany = vi.hoisted(() => vi.fn());
const emailFindMany = vi.hoisted(() => vi.fn());
const ruleFindMany = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({
  db: {
    attentionItem: { findMany: attentionFindMany },
    emailMessage: { findMany: emailFindMany },
    emailRule: { findMany: ruleFindMany },
  },
  prisma: {},
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../learning/trust-score.js", () => ({ getTrustScore: vi.fn(async () => null) }));
vi.mock("../learning/interaction-graph.js", () => ({
  getCachedInteractionNode: vi.fn(async () => null),
  getCachedInteractionGraph: vi.fn(async () => null),
  propagatedImportanceForDomain: vi.fn(() => 0),
}));

import { buildJudgeContext } from "../judge/judge-context.js";

function pinRule(conditions: Record<string, unknown>, actionValue: string) {
  return { conditions, actionValue };
}

async function pinnedTierFor(from: string) {
  const ctx = await buildJudgeContext("u1", { from });
  return ctx.pinnedTier;
}

beforeEach(() => {
  attentionFindMany.mockReset();
  attentionFindMany.mockResolvedValue([]);
  emailFindMany.mockReset();
  emailFindMany.mockResolvedValue([]);
  ruleFindMany.mockReset();
  ruleFindMany.mockResolvedValue([]);
});

describe("fetchPinnedTier — two-level pin resolution", () => {
  it("still matches an exact address pin", async () => {
    ruleFindMany.mockResolvedValue([pinRule({ from: ["boss@acme.com"] }, "PUSH")]);
    expect(await pinnedTierFor("Boss <boss@acme.com>")).toBe("PUSH");
  });

  it("matches a domain pin for any sender at that exact domain", async () => {
    ruleFindMany.mockResolvedValue([pinRule({ fromDomain: ["acme.com"] }, "SILENT")]);
    expect(await pinnedTierFor("Anyone <someone@acme.com>")).toBe("SILENT");
  });

  it("tolerates a leading @ in the stored domain", async () => {
    ruleFindMany.mockResolvedValue([pinRule({ fromDomain: ["@acme.com"] }, "INFO")]);
    expect(await pinnedTierFor("a@acme.com")).toBe("INFO");
  });

  it("address pin beats domain pin regardless of rule order", async () => {
    ruleFindMany.mockResolvedValue([
      pinRule({ fromDomain: ["acme.com"] }, "SILENT"),
      pinRule({ from: ["boss@acme.com"] }, "PUSH"),
    ]);
    expect(await pinnedTierFor("boss@acme.com")).toBe("PUSH");
  });

  it("does NOT match a subdomain against a parent-domain pin", async () => {
    ruleFindMany.mockResolvedValue([pinRule({ fromDomain: ["acme.com"] }, "SILENT")]);
    expect(await pinnedTierFor("bot@mail.acme.com")).toBeNull();
  });

  it("does NOT let a bare domain in `from` match anything (equality, not substring)", async () => {
    ruleFindMany.mockResolvedValue([pinRule({ from: ["acme.com"] }, "SILENT")]);
    expect(await pinnedTierFor("someone@acme.com")).toBeNull();
  });

  it("skips a domain rule with a junk actionValue instead of pinning the fallback", async () => {
    ruleFindMany.mockResolvedValue([pinRule({ fromDomain: ["acme.com"] }, "NOT_A_TIER")]);
    expect(await pinnedTierFor("someone@acme.com")).toBeNull();
  });

  it("returns null when no rule matches", async () => {
    ruleFindMany.mockResolvedValue([pinRule({ fromDomain: ["other.com"] }, "SILENT")]);
    expect(await pinnedTierFor("someone@acme.com")).toBeNull();
  });
});

describe("public mailbox domains — read-path enforcement", () => {
  it("ignores a public-mailbox domain pin even when a rule row exists", async () => {
    // The /pin-tier route refuses to create this, but the generic
    // /api/email/rules endpoint can author arbitrary PIN_TIER rows — the
    // invariant must hold where it matters: at cascade rank 0.
    ruleFindMany.mockResolvedValue([pinRule({ fromDomain: ["gmail.com"] }, "PUSH")]);
    expect(await pinnedTierFor("stranger@gmail.com")).toBeNull();
  });

  it("still honors an exact-address pin on a public mailbox sender", async () => {
    ruleFindMany.mockResolvedValue([pinRule({ from: ["friend@gmail.com"] }, "PUSH")]);
    expect(await pinnedTierFor("friend@gmail.com")).toBe("PUSH");
  });
});

describe("duplicate domain rules", () => {
  it("the newest of two same-domain pins wins (rules arrive updatedAt-desc)", async () => {
    // fetchPinnedTier orders by updatedAt desc; the mock hands rules back in
    // that order, so the first row is the newest.
    ruleFindMany.mockResolvedValue([
      pinRule({ fromDomain: ["acme.com"] }, "PUSH"),
      pinRule({ fromDomain: ["acme.com"] }, "SILENT"),
    ]);
    expect(await pinnedTierFor("someone@acme.com")).toBe("PUSH");
  });
});
