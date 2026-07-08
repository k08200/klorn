/**
 * judge-context — Phase 3b sender-trait injection (flag ON).
 *
 * The default-OFF path is covered by judge-context.test.ts (senderTraits: []).
 * Here SENDER_TRAITS_IN_JUDGE is forced on so we exercise:
 *   - extracted traits flowing into the context, and
 *   - a trait-fetch failure degrading to [] WITHOUT nuking the correction loop.
 * Prisma is mocked at db.js; the flag and the trait store are mocked directly.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const attentionFindMany = vi.hoisted(() => vi.fn());
const emailFindMany = vi.hoisted(() => vi.fn());
const getActiveSenderTraitsMock = vi.hoisted(() => vi.fn());

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, SENDER_TRAITS_IN_JUDGE: true };
});

vi.mock("../db.js", () => ({
  db: {
    attentionItem: { findMany: attentionFindMany },
    emailMessage: { findMany: emailFindMany },
  },
  prisma: {},
}));

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../trust-score.js", () => ({ getTrustScore: vi.fn(async () => null) }));
vi.mock("../interaction-graph.js", () => ({
  getCachedInteractionNode: vi.fn(async () => null),
}));
vi.mock("../sender-trait-store.js", () => ({
  getActiveSenderTraits: getActiveSenderTraitsMock,
}));

import { buildJudgeContext } from "../judge-context.js";

const investorTrait = {
  factKind: "relationship" as const,
  factValue: "investor",
  confidence: 0.9,
  evidenceText: "We'd like to invest in your round.",
};

beforeEach(() => {
  attentionFindMany.mockReset();
  emailFindMany.mockReset();
  attentionFindMany.mockResolvedValue([]);
  emailFindMany.mockResolvedValue([]);
  getActiveSenderTraitsMock.mockReset();
  getActiveSenderTraitsMock.mockResolvedValue([]);
});

describe("buildJudgeContext — sender traits (flag on)", () => {
  it("injects active sender traits, keyed by the parsed sender address", async () => {
    getActiveSenderTraitsMock.mockResolvedValue([investorTrait]);

    const ctx = await buildJudgeContext("u1", { from: "Alice <alice@corp.com>" });

    expect(ctx.senderTraits).toEqual([investorTrait]);
    expect(getActiveSenderTraitsMock).toHaveBeenCalledWith("u1", "alice@corp.com");
  });

  it("degrades senderTraits to [] without nuking corrections when the trait fetch fails", async () => {
    // corrections pool returns one row; sender-history query returns nothing.
    attentionFindMany.mockImplementation((args: { where: Record<string, unknown> }) =>
      "isManualOverride" in args.where
        ? Promise.resolve([{ sourceId: "e1", tier: "QUEUE" }])
        : Promise.resolve([]),
    );
    emailFindMany.mockImplementation((args: { where: Record<string, unknown> }) =>
      "from" in args.where
        ? Promise.resolve([])
        : Promise.resolve([{ id: "e1", from: "Alice <alice@corp.com>", subject: "s1" }]),
    );
    getActiveSenderTraitsMock.mockRejectedValue(new Error("traits down"));

    const ctx = await buildJudgeContext("u1", { from: "Alice <alice@corp.com>" });

    expect(ctx.senderTraits).toEqual([]);
    expect(ctx.corrections.length).toBeGreaterThan(0);
  });
});
