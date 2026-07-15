/**
 * Fixture → JudgeContext conversion for the offline eval (#650).
 *
 * The eval instrument must never fake a context: a typo'd fixture that
 * silently degrades to EMPTY would report "context made no difference"
 * when the context was never fed. So conversion is strict — unknown keys
 * and malformed values throw (with the item id), they never coerce.
 */

import { describe, expect, it } from "vitest";
import { fixtureToJudgeContext, judgeContextToFixture } from "../eval-context.js";
import { EMPTY_JUDGE_CONTEXT } from "../judge/poc-judge.js";

describe("fixtureToJudgeContext", () => {
  it("returns the empty context for an absent fixture", () => {
    expect(fixtureToJudgeContext(undefined, "item-1")).toEqual(EMPTY_JUDGE_CONTEXT);
    expect(fixtureToJudgeContext(null, "item-1")).toEqual(EMPTY_JUDGE_CONTEXT);
  });

  it("passes a full fixture through", () => {
    const context = fixtureToJudgeContext(
      {
        corrections: [{ from: "a@x.com", subject: "Invoice", tier: "QUEUE" }],
        senderPrior: { tier: "QUEUE", count: 3, kind: "history" },
        senderFacts: {
          tierHistory: { QUEUE: 6, SILENT: 3 },
          manualOverrides: 2,
          interaction: { emailCount: 12, lastEmailDaysAgo: 3, upcomingMeetings: 1 },
          commitments: { onTime: 4, total: 5 },
          engagement: { importance: 0.8, outboundCount: 7 },
        },
        senderTraits: [
          { factKind: "role", factValue: "recruiter", confidence: 0.9, evidenceText: "sig" },
        ],
        learnedRules: [{ pattern: "sender-domain", value: "ci.example.com", tier: "SILENT" }],
      },
      "item-1",
    );

    expect(context.senderPrior).toEqual({ tier: "QUEUE", count: 3, kind: "history" });
    expect(context.corrections).toHaveLength(1);
    expect(context.senderFacts?.tierHistory).toEqual({ QUEUE: 6, SILENT: 3 });
    expect(context.senderFacts?.engagement).toEqual({ importance: 0.8, outboundCount: 7 });
    expect(context.senderTraits).toHaveLength(1);
    expect(context.learnedRules).toEqual([
      { pattern: "sender-domain", value: "ci.example.com", tier: "SILENT" },
    ]);
  });

  it("fills omitted keys with empty values", () => {
    const context = fixtureToJudgeContext(
      { senderPrior: { tier: "PUSH", count: 2, kind: "override" } },
      "item-2",
    );
    expect(context.senderPrior?.tier).toBe("PUSH");
    expect(context.corrections).toEqual([]);
    expect(context.senderFacts).toBeNull();
    expect(context.senderTraits).toEqual([]);
    expect(context.learnedRules).toEqual([]);
  });

  it("defaults optional senderFacts sub-fields", () => {
    const context = fixtureToJudgeContext({ senderFacts: { tierHistory: { QUEUE: 4 } } }, "item-3");
    expect(context.senderFacts).toEqual({
      tierHistory: { QUEUE: 4 },
      manualOverrides: 0,
      interaction: null,
      commitments: null,
      engagement: null,
    });
  });

  it("rejects unknown keys (typo protection)", () => {
    expect(() => fixtureToJudgeContext({ senderPrio: { tier: "QUEUE" } }, "item-4")).toThrow(
      /item-4.*senderPrio/,
    );
  });

  it("rejects a non-object fixture", () => {
    expect(() => fixtureToJudgeContext("QUEUE", "item-5")).toThrow(/item-5/);
    expect(() => fixtureToJudgeContext([1], "item-5")).toThrow(/item-5/);
  });

  it("rejects an invalid senderPrior", () => {
    expect(() =>
      fixtureToJudgeContext({ senderPrior: { tier: "URGENT", count: 3, kind: "history" } }, "i"),
    ).toThrow(/tier/);
    expect(() =>
      fixtureToJudgeContext({ senderPrior: { tier: "QUEUE", count: 0, kind: "history" } }, "i"),
    ).toThrow(/count/);
    expect(() =>
      fixtureToJudgeContext({ senderPrior: { tier: "QUEUE", count: 3, kind: "vibes" } }, "i"),
    ).toThrow(/kind/);
  });

  it("rejects malformed corrections", () => {
    expect(() => fixtureToJudgeContext({ corrections: "none" }, "i")).toThrow(/corrections/);
    expect(() =>
      fixtureToJudgeContext({ corrections: [{ from: "a@x.com", tier: "QUEUE" }] }, "i"),
    ).toThrow(/subject/);
    expect(() =>
      fixtureToJudgeContext(
        { corrections: [{ from: "a@x.com", subject: "s", tier: "LOUD" }] },
        "i",
      ),
    ).toThrow(/tier/);
  });

  it("rejects malformed tierHistory", () => {
    expect(() =>
      fixtureToJudgeContext({ senderFacts: { tierHistory: { URGENT: 3 } } }, "i"),
    ).toThrow(/tierHistory/);
    expect(() =>
      fixtureToJudgeContext({ senderFacts: { tierHistory: { QUEUE: -1 } } }, "i"),
    ).toThrow(/tierHistory/);
  });

  it("rejects malformed senderTraits and learnedRules", () => {
    expect(() =>
      fixtureToJudgeContext(
        {
          senderTraits: [{ factKind: "role", factValue: "r", confidence: 1.5, evidenceText: "e" }],
        },
        "i",
      ),
    ).toThrow(/confidence/);
    expect(() =>
      fixtureToJudgeContext(
        { learnedRules: [{ pattern: "sender-regex", value: "x", tier: "SILENT" }] },
        "i",
      ),
    ).toThrow(/pattern/);
  });
});

describe("judgeContextToFixture (ledger snapshot for the committed eval set)", () => {
  it("keeps only the numeric knowledge (prior + facts) and strips text carriers", () => {
    const fixture = judgeContextToFixture({
      corrections: [{ from: "real@leak.com", subject: "REAL SUBJECT", tier: "QUEUE" }],
      senderPrior: { tier: "PUSH", count: 3, kind: "override" },
      senderFacts: {
        tierHistory: { QUEUE: 5 },
        manualOverrides: 3,
        interaction: null,
        commitments: null,
        engagement: null,
      },
      senderTraits: [{ factKind: "role", factValue: "x", confidence: 1, evidenceText: "raw text" }],
      learnedRules: [{ pattern: "sender-domain", value: "leak.com", tier: "SILENT" }],
    });
    expect(fixture).toEqual({
      senderPrior: { tier: "PUSH", count: 3, kind: "override" },
      senderFacts: {
        tierHistory: { QUEUE: 5 },
        manualOverrides: 3,
        interaction: null,
        commitments: null,
        engagement: null,
      },
    });
    expect(JSON.stringify(fixture)).not.toMatch(/leak|REAL|raw text/);
  });

  it("returns null when there is no prior and no facts (no fixture to commit)", () => {
    expect(
      judgeContextToFixture({
        corrections: [],
        senderPrior: null,
        senderFacts: null,
        senderTraits: [],
        learnedRules: [],
      }),
    ).toBeNull();
  });

  it("round-trips through the strict fixture parser", () => {
    const fixture = judgeContextToFixture({
      corrections: [],
      senderPrior: { tier: "PUSH", count: 2, kind: "override" },
      senderFacts: null,
      senderTraits: [],
      learnedRules: [],
    });
    const context = fixtureToJudgeContext(fixture, "row-x");
    expect(context.senderPrior).toEqual({ tier: "PUSH", count: 2, kind: "override" });
  });
});
