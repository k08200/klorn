/**
 * judge-context unit tests — correction mining + sender-prior construction.
 * Prisma is mocked at the db.js boundary (repo convention); no real DB.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const attentionFindMany = vi.hoisted(() => vi.fn());
const emailFindMany = vi.hoisted(() => vi.fn());
const getTrustScoreMock = vi.hoisted(() => vi.fn());
const getCachedNodeMock = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({
  db: {
    attentionItem: { findMany: attentionFindMany },
    emailMessage: { findMany: emailFindMany },
  },
  prisma: {},
}));

vi.mock("../sentry.js", () => ({
  captureError: vi.fn(),
}));

vi.mock("../trust-score.js", () => ({
  getTrustScore: getTrustScoreMock,
}));

vi.mock("../interaction-graph.js", () => ({
  getCachedInteractionNode: getCachedNodeMock,
}));

import { buildJudgeContext } from "../judge-context.js";

const NOW = new Date("2026-06-12T00:00:00Z");
const DAYS = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  attentionFindMany.mockReset();
  emailFindMany.mockReset();
  getTrustScoreMock.mockReset();
  getTrustScoreMock.mockResolvedValue(null);
  getCachedNodeMock.mockReset();
  getCachedNodeMock.mockResolvedValue(null);
});

/**
 * The module issues, in order:
 *   1. attentionItem.findMany   (corrections pool)
 *   2. emailMessage.findMany    (corrections → email content)  [skipped if 1 empty]
 *   3. emailMessage.findMany    (sender history ids)
 *   4. attentionItem.findMany   (sender history items)         [skipped if 3 empty]
 * Helpers below wire the mocks by call-site filter shape instead of order,
 * so Promise.all interleaving can't break the test.
 */
function wireMocks(opts: {
  corrections?: Array<{ sourceId: string; tier: string }>;
  correctionEmails?: Array<{ id: string; from: string; subject: string }>;
  senderEmailIds?: string[];
  senderItems?: Array<{
    sourceId: string;
    tier: string | null;
    tierReason: string | null;
    updatedAt: Date;
  }>;
}) {
  attentionFindMany.mockImplementation((args: { where: Record<string, unknown> }) => {
    if ("tierReason" in args.where) return Promise.resolve(opts.corrections ?? []);
    return Promise.resolve(opts.senderItems ?? []);
  });
  emailFindMany.mockImplementation((args: { where: Record<string, unknown> }) => {
    if ("from" in args.where) {
      return Promise.resolve((opts.senderEmailIds ?? []).map((id) => ({ id })));
    }
    return Promise.resolve(opts.correctionEmails ?? []);
  });
}

describe("buildJudgeContext", () => {
  it("returns empty context when there is no history at all", async () => {
    wireMocks({});
    const ctx = await buildJudgeContext("u1", { from: "Alice <alice@corp.com>" });
    expect(ctx).toEqual({
      corrections: [],
      senderPrior: null,
      senderFacts: null,
      senderTraits: [],
    });
  });

  it("returns empty context (and does not throw) when the DB fails", async () => {
    attentionFindMany.mockRejectedValue(new Error("db down"));
    emailFindMany.mockRejectedValue(new Error("db down"));
    const ctx = await buildJudgeContext("u1", { from: "Alice <alice@corp.com>" });
    expect(ctx).toEqual({
      corrections: [],
      senderPrior: null,
      senderFacts: null,
      senderTraits: [],
    });
  });

  it("ranks correction examples: same sender, then same domain, then recency — capped at 5", async () => {
    wireMocks({
      corrections: [
        { sourceId: "e1", tier: "QUEUE" },
        { sourceId: "e2", tier: "SILENT" },
        { sourceId: "e3", tier: "PUSH" },
        { sourceId: "e4", tier: "QUEUE" },
        { sourceId: "e5", tier: "SILENT" },
        { sourceId: "e6", tier: "QUEUE" },
        { sourceId: "e7", tier: "QUEUE" },
      ],
      correctionEmails: [
        { id: "e1", from: "Other <other@elsewhere.com>", subject: "s1" },
        { id: "e2", from: "Colleague <bob@corp.com>", subject: "s2" },
        { id: "e3", from: "Alice <alice@corp.com>", subject: "s3" },
        { id: "e4", from: "Rand <r@xyz.io>", subject: "s4" },
        { id: "e5", from: "Alice <alice@corp.com>", subject: "s5" },
        { id: "e6", from: "Misc <m@misc.net>", subject: "s6" },
        { id: "e7", from: "Misc2 <m2@misc.net>", subject: "s7" },
      ],
    });

    const ctx = await buildJudgeContext("u1", { from: "Alice <alice@corp.com>" });
    expect(ctx.corrections).toHaveLength(5);
    // Same-sender examples (e3, e5) first, then same-domain (e2), then the rest.
    expect(ctx.corrections[0]).toEqual({
      from: "Alice <alice@corp.com>",
      subject: "s3",
      tier: "PUSH",
    });
    expect(ctx.corrections[1]).toEqual({
      from: "Alice <alice@corp.com>",
      subject: "s5",
      tier: "SILENT",
    });
    expect(ctx.corrections[2]).toEqual({
      from: "Colleague <bob@corp.com>",
      subject: "s2",
      tier: "SILENT",
    });
  });

  it("drops corrections whose email row is missing or tier is invalid", async () => {
    wireMocks({
      corrections: [
        { sourceId: "gone", tier: "QUEUE" },
        { sourceId: "bad", tier: "CALL" },
        { sourceId: "ok", tier: "SILENT" },
      ],
      correctionEmails: [
        { id: "bad", from: "X <x@x.com>", subject: "legacy tier" },
        { id: "ok", from: "Y <y@y.com>", subject: "fine" },
      ],
    });
    const ctx = await buildJudgeContext("u1", { from: "Alice <alice@corp.com>" });
    expect(ctx.corrections).toEqual([{ from: "Y <y@y.com>", subject: "fine", tier: "SILENT" }]);
  });

  it("builds an override prior from ≥2 identical recent manual overrides", async () => {
    wireMocks({
      senderEmailIds: ["m1", "m2"],
      senderItems: [
        {
          sourceId: "m1",
          tier: "PUSH",
          tierReason: "Manual override — user moved to PUSH",
          updatedAt: DAYS(5),
        },
        {
          sourceId: "m2",
          tier: "PUSH",
          tierReason: "Manual override — user moved to PUSH",
          updatedAt: DAYS(20),
        },
      ],
    });
    const ctx = await buildJudgeContext("u1", { from: "Boss <boss@corp.com>" });
    expect(ctx.senderPrior).toEqual({ tier: "PUSH", count: 2, kind: "override" });
  });

  it("does not build an override prior when overrides disagree", async () => {
    wireMocks({
      senderEmailIds: ["m1", "m2"],
      senderItems: [
        {
          sourceId: "m1",
          tier: "PUSH",
          tierReason: "Manual override — user moved to PUSH",
          updatedAt: DAYS(5),
        },
        {
          sourceId: "m2",
          tier: "QUEUE",
          tierReason: "Manual override — user moved to QUEUE",
          updatedAt: DAYS(6),
        },
      ],
    });
    const ctx = await buildJudgeContext("u1", { from: "Boss <boss@corp.com>" });
    expect(ctx.senderPrior).toBeNull();
  });

  it("ignores overrides older than 60 days for the prior", async () => {
    wireMocks({
      senderEmailIds: ["m1", "m2"],
      senderItems: [
        {
          sourceId: "m1",
          tier: "PUSH",
          tierReason: "Manual override — user moved to PUSH",
          updatedAt: DAYS(70),
        },
        {
          sourceId: "m2",
          tier: "PUSH",
          tierReason: "Manual override — user moved to PUSH",
          updatedAt: DAYS(80),
        },
      ],
    });
    const ctx = await buildJudgeContext("u1", { from: "Boss <boss@corp.com>" });
    expect(ctx.senderPrior).toBeNull();
  });

  it("builds a history prior from ≥3 unanimous recent classifications", async () => {
    wireMocks({
      senderEmailIds: ["m1", "m2", "m3"],
      senderItems: [
        { sourceId: "m1", tier: "SILENT", tierReason: "Promotional", updatedAt: DAYS(2) },
        { sourceId: "m2", tier: "SILENT", tierReason: "Promotional", updatedAt: DAYS(9) },
        { sourceId: "m3", tier: "SILENT", tierReason: "Promotional", updatedAt: DAYS(16) },
      ],
    });
    const ctx = await buildJudgeContext("u1", { from: "News <news@letter.com>" });
    expect(ctx.senderPrior).toEqual({ tier: "SILENT", count: 3, kind: "history" });
  });

  it("does not build a history prior from only 2 classifications", async () => {
    wireMocks({
      senderEmailIds: ["m1", "m2"],
      senderItems: [
        { sourceId: "m1", tier: "SILENT", tierReason: "Promotional", updatedAt: DAYS(2) },
        { sourceId: "m2", tier: "SILENT", tierReason: "Promotional", updatedAt: DAYS(9) },
      ],
    });
    const ctx = await buildJudgeContext("u1", { from: "News <news@letter.com>" });
    expect(ctx.senderPrior).toBeNull();
  });

  it("does not build a history prior when one classification disagrees", async () => {
    wireMocks({
      senderEmailIds: ["m1", "m2", "m3"],
      senderItems: [
        { sourceId: "m1", tier: "SILENT", tierReason: "Promotional", updatedAt: DAYS(2) },
        { sourceId: "m2", tier: "QUEUE", tierReason: "Visible in queue", updatedAt: DAYS(3) },
        { sourceId: "m3", tier: "SILENT", tierReason: "Promotional", updatedAt: DAYS(4) },
      ],
    });
    const ctx = await buildJudgeContext("u1", { from: "News <news@letter.com>" });
    expect(ctx.senderPrior).toBeNull();
  });

  it("does not build a history prior when the newest item is stale (>30 days)", async () => {
    wireMocks({
      senderEmailIds: ["m1", "m2", "m3"],
      senderItems: [
        { sourceId: "m1", tier: "SILENT", tierReason: "Promotional", updatedAt: DAYS(35) },
        { sourceId: "m2", tier: "SILENT", tierReason: "Promotional", updatedAt: DAYS(40) },
        { sourceId: "m3", tier: "SILENT", tierReason: "Promotional", updatedAt: DAYS(50) },
      ],
    });
    const ctx = await buildJudgeContext("u1", { from: "News <news@letter.com>" });
    expect(ctx.senderPrior).toBeNull();
  });

  it("excludes the email being judged from its own sender history", async () => {
    wireMocks({ senderEmailIds: [] });
    await buildJudgeContext("u1", { from: "A <a@b.com>", excludeEmailId: "self-id" });
    const historyCall = emailFindMany.mock.calls.find((c) => "from" in c[0].where);
    expect(historyCall?.[0].where.id).toEqual({ not: "self-id" });
  });

  it("keeps the email's own correction in the few-shot pool by default (runtime path)", async () => {
    wireMocks({});
    await buildJudgeContext("u1", { from: "A <a@b.com>", excludeEmailId: "self-id" });
    const correctionsCall = attentionFindMany.mock.calls.find((c) => "tierReason" in c[0].where);
    expect(correctionsCall?.[0].where.sourceId).toBeUndefined();
  });

  it("hides the email's own correction when excludeOwnCorrection is set (counterfactual eval)", async () => {
    wireMocks({});
    await buildJudgeContext("u1", {
      from: "A <a@b.com>",
      excludeEmailId: "self-id",
      excludeOwnCorrection: true,
    });
    const correctionsCall = attentionFindMany.mock.calls.find((c) => "tierReason" in c[0].where);
    expect(correctionsCall?.[0].where.sourceId).toEqual({ not: "self-id" });
  });
});

describe("buildJudgeContext — sender facts", () => {
  it("assembles tier history + manual override count from sender items", async () => {
    wireMocks({
      senderEmailIds: ["m1", "m2", "m3", "m4"],
      senderItems: [
        {
          sourceId: "m1",
          tier: "QUEUE",
          tierReason: "Manual override — user moved to QUEUE",
          updatedAt: DAYS(2),
        },
        { sourceId: "m2", tier: "QUEUE", tierReason: "Visible in queue", updatedAt: DAYS(5) },
        { sourceId: "m3", tier: "SILENT", tierReason: "Promotional", updatedAt: DAYS(9) },
        { sourceId: "m4", tier: "CALL", tierReason: "legacy tier — ignored", updatedAt: DAYS(3) },
      ],
    });
    const ctx = await buildJudgeContext("u1", { from: "Mixed <mixed@corp.com>" });
    // Mixed tiers → no prior, but the distribution itself is a fact.
    expect(ctx.senderPrior).toBeNull();
    expect(ctx.senderFacts).toEqual({
      tierHistory: { QUEUE: 2, SILENT: 1 },
      manualOverrides: 1,
      interaction: null,
      commitments: null,
    });
  });

  it("returns senderFacts null when there is no signal at all", async () => {
    wireMocks({});
    const ctx = await buildJudgeContext("u1", { from: "New <new@nowhere.com>" });
    expect(ctx.senderFacts).toBeNull();
  });

  it("includes the interaction fact from the cached graph node", async () => {
    wireMocks({});
    getCachedNodeMock.mockResolvedValue({
      email: "alice@corp.com",
      name: "Alice",
      score: 80,
      emailCount: 14,
      lastEmailDaysAgo: 2,
      upcomingMeetings: 1,
      tags: ["frequent"],
    });
    const ctx = await buildJudgeContext("u1", { from: "Alice <alice@corp.com>" });
    expect(ctx.senderFacts).toEqual({
      tierHistory: {},
      manualOverrides: 0,
      interaction: { emailCount: 14, lastEmailDaysAgo: 2, upcomingMeetings: 1 },
      commitments: null,
    });
  });

  it("includes the commitment fact when the trust badge is load-bearing", async () => {
    wireMocks({});
    getTrustScoreMock.mockResolvedValue({
      contactEmail: "alice@corp.com",
      displayName: "Alice",
      totalCount: 5,
      onTimeCount: 4,
      lateCount: 1,
      onTimeRate: 0.8,
      avgDelayDays: 1,
      badge: "reliable",
      label: "Reliable",
    });
    const ctx = await buildJudgeContext("u1", { from: "Alice <alice@corp.com>" });
    expect(ctx.senderFacts?.commitments).toEqual({ onTime: 4, total: 5 });
  });

  it("excludes the commitment fact when the badge is unknown (too few / stale data)", async () => {
    wireMocks({});
    getTrustScoreMock.mockResolvedValue({
      contactEmail: "alice@corp.com",
      displayName: "Alice",
      totalCount: 2,
      onTimeCount: 2,
      lateCount: 0,
      onTimeRate: 1,
      avgDelayDays: 0,
      badge: "unknown",
      label: "Not enough data",
    });
    const ctx = await buildJudgeContext("u1", { from: "Alice <alice@corp.com>" });
    expect(ctx.senderFacts).toBeNull();
  });
});
