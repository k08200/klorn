/**
 * The shadow's own DB reads, through the real Prisma-facing code with a mocked
 * client: the #1591 origin rule on "did the user reply", the judged mail kept
 * out of its sender's history, and a budget query failure as a quiet skip.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const sentFindFirst = vi.hoisted(() => vi.fn(async () => null));
const emailFindMany = vi.hoisted(() => vi.fn(async () => []));
const aggregate = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({
  db: {
    sentMessage: { findFirst: sentFindFirst, findMany: vi.fn(async () => []) },
    emailMessage: { findMany: emailFindMany },
    contactEngagementScore: { findUnique: vi.fn(async () => null) },
    attentionFacts: { aggregate },
    user: { findUnique: vi.fn(async () => ({ email: "me@acme.com" })) },
    linkedInboxAccount: { findMany: vi.fn(async () => []) },
    automationConfig: { findUnique: vi.fn(async () => null) },
  },
  prisma: {},
}));
vi.mock("../billing/cost-guard.js", () => ({
  checkCostGate: vi.fn(async () => ({ allowed: true, remainingCents: 80, capCents: 75 })),
  checkGlobalCostGate: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("../billing/quota-limiter.js", () => ({
  getUserUsage: () => ({ rpmUsed: 0, rpmCap: 10, backgroundDailyUsed: 0, backgroundDailyCap: 200 }),
}));
vi.mock("../judge/judge-context.js", () => ({
  lookupPinnedTier: vi.fn(async () => null),
  isSenderAddressIndexEnabled: () => false,
}));
vi.mock("../mail/sender-labels.js", () => ({ senderLabelsFor: vi.fn(async () => new Map()) }));

import { loadRelationshipSnapshot, SENT_EVIDENCE_WHERE } from "../judge/v3/relationship-loader.js";
import { prismaShadowDeps } from "../judge/v3/shadow.js";
import { shadowBudgetVerdict, withShadowSlot } from "../judge/v3/shadow-budget.js";

beforeEach(() => {
  vi.clearAllMocks();
  aggregate.mockResolvedValue({ _sum: { costUsd: 0.01 } });
});

describe("shadow DB reads", () => {
  it("'did the user reply after this mail' ignores Klorn's own sends (#1591)", async () => {
    await prismaShadowDeps.repliedAfter("u1", "t1", new Date("2026-10-30T00:00:00Z"));
    const [arg] = sentFindFirst.mock.calls[0] as unknown as [{ where: Record<string, unknown> }];
    expect(arg.where).toMatchObject({ userId: "u1", threadId: "t1", ...SENT_EVIDENCE_WHERE });
  });

  it("keeps the judged mail out of its sender's inbound history", async () => {
    await loadRelationshipSnapshot({
      userId: "u1",
      senderAddress: "kim@partner.io",
      userAddresses: [],
      excludeEmailId: "e-new",
    });
    const [arg] = emailFindMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }];
    expect(arg.where).toMatchObject({ userId: "u1", id: { not: "e-new" } });
  });
});

describe("shadowBudgetVerdict", () => {
  it("is ok with room everywhere, and stops at the shadow's own daily spend", async () => {
    expect(await shadowBudgetVerdict("u1")).toBe("ok");
    aggregate.mockResolvedValue({ _sum: { costUsd: 0.2 } });
    expect(await shadowBudgetVerdict("u1")).toBe("shadow_budget");
  });

  it("a failed budget read is a quiet skip, never a crash", async () => {
    aggregate.mockRejectedValue(new Error("db down"));
    expect(await shadowBudgetVerdict("u1")).toBe("budget_unknown");
  });
});

describe("withShadowSlot", () => {
  it("releases the slot when the work throws", async () => {
    await expect(withShadowSlot(async () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    expect(await withShadowSlot(async () => "next")).toBe("next");
  });
});
