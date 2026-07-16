/**
 * Fetch path for the read-behavior fact: buildJudgeContext counts the
 * sender's recent mail (windowed) and how much of it the user actually read.
 *
 * Contract under test:
 *  - flag ON + enough sample → senderFacts.readBehavior = { read, total }
 *  - flag OFF → no readBehavior (and no count queries fired)
 *  - sample below READ_BEHAVIOR.minSample → null (one read tells nothing)
 *  - count query throws → fail-soft to null, other channels intact
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const countMock = vi.hoisted(() => vi.fn());
const flagState = vi.hoisted(() => ({ on: true }));

vi.mock("../db.js", () => ({
  db: {
    attentionItem: { findMany: vi.fn(async () => []) },
    emailMessage: { findMany: vi.fn(async () => []), count: countMock },
  },
  prisma: {},
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../learning/trust-score.js", () => ({ getTrustScore: vi.fn(async () => null) }));
vi.mock("../learning/sender-trait-store.js", () => ({
  getActiveSenderTraits: vi.fn(async () => []),
}));
vi.mock("../learning/learned-rule-store.js", () => ({
  getAppliedRulesForMatch: vi.fn(async () => []),
}));
vi.mock("../learning/interaction-graph.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../learning/interaction-graph.js")>();
  return {
    ...actual,
    getCachedInteractionGraph: vi.fn(async () => null),
    getCachedInteractionNode: vi.fn(async () => null),
  };
});
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    ...actual,
    get CONTACT_ENGAGEMENT_IN_JUDGE() {
      return flagState.on;
    },
  };
});

import { buildJudgeContext } from "../judge/judge-context.js";

beforeEach(() => {
  countMock.mockReset();
  flagState.on = true;
});

describe("buildJudgeContext — read-behavior fact", () => {
  it("returns {read, total} when the flag is on and the sample is big enough", async () => {
    // First count = total in window, second = read in window.
    countMock.mockResolvedValueOnce(25).mockResolvedValueOnce(1);
    const ctx = await buildJudgeContext("user-1", {
      from: "Indie Hackers <channing@indiehackers.com>",
    });
    expect(ctx.senderFacts?.readBehavior).toEqual({ read: 1, total: 25 });
  });

  it("returns no readBehavior when the flag is off", async () => {
    flagState.on = false;
    const ctx = await buildJudgeContext("user-1", {
      from: "Indie Hackers <channing@indiehackers.com>",
    });
    expect(ctx.senderFacts?.readBehavior ?? null).toBeNull();
    expect(countMock).not.toHaveBeenCalled();
  });

  it("suppresses the fact below the minimum sample", async () => {
    countMock.mockResolvedValueOnce(2).mockResolvedValueOnce(2);
    const ctx = await buildJudgeContext("user-1", {
      from: "Zeno from Resend <zeno@updates.resend.com>",
    });
    expect(ctx.senderFacts?.readBehavior ?? null).toBeNull();
  });

  it("fails soft to null when the count query throws", async () => {
    countMock.mockRejectedValue(new Error("db down"));
    const ctx = await buildJudgeContext("user-1", {
      from: "Zeno from Resend <zeno@updates.resend.com>",
    });
    expect(ctx.senderFacts?.readBehavior ?? null).toBeNull();
  });
});
