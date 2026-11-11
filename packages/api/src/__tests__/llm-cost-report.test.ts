/**
 * buildLlmCostReport turns database aggregates of LlmUsageLog into the
 * founder's cost report: Klorn's spend per feature and per user-day by plan,
 * with BYOK spend, unattributed calls and usage-less calls kept apart.
 * Aggregates only — no user ids in the output.
 */

import { describe, expect, it } from "vitest";
import {
  buildLlmCostReport,
  type CostReportInput,
  type FeatureGroup,
} from "../billing/llm-cost-report.js";

function group(overrides: Partial<FeatureGroup>): FeatureGroup {
  return {
    feature: "judge/poc-judge",
    source: "background",
    ownedByUser: false,
    usageMissing: false,
    calls: 1,
    costMicroCents: 300,
    ...overrides,
  };
}

function input(overrides: Partial<CostReportInput>): CostReportInput {
  return { features: [], userDays: [], planOf: new Map(), ...overrides };
}

describe("buildLlmCostReport", () => {
  it("counts Klorn's spend apart from spend on users' own keys", () => {
    const report = buildLlmCostReport(
      input({
        features: [
          group({ costMicroCents: 300 }),
          group({ ownedByUser: true, costMicroCents: 900 }),
        ],
      }),
    );
    expect(report.totals).toMatchObject({ calls: 2, klornUsd: 0.0003, byokUsd: 0.0009 });
  });

  it("ranks features by Klorn spend and labels calls with no feature", () => {
    const report = buildLlmCostReport(
      input({
        features: [
          group({ feature: "judge/poc-judge", costMicroCents: 300 }),
          group({ feature: "pim/briefing", costMicroCents: 4000 }),
          group({ feature: null, calls: 3, costMicroCents: 0 }),
          group({ feature: "agentcore/chat-engine", source: "foreground", costMicroCents: 900 }),
        ],
      }),
    );
    expect(report.byFeature.map((f) => f.feature)).toEqual([
      "pim/briefing",
      "agentcore/chat-engine",
      "judge/poc-judge",
      "(unattributed)",
    ]);
    expect(report.byFeature[1]).toMatchObject({
      calls: 1,
      foregroundCalls: 1,
      klornUsd: 0.0009,
      usdPerCall: 0.0009,
    });
    expect(report.totals.unattributedCalls).toBe(3);
  });

  it("merges a feature's foreground, background and BYOK groups into one row", () => {
    const report = buildLlmCostReport(
      input({
        features: [
          group({
            feature: "agentcore/chat-engine",
            source: "foreground",
            calls: 2,
            costMicroCents: 1000,
          }),
          group({
            feature: "agentcore/chat-engine",
            source: "background",
            calls: 1,
            costMicroCents: 500,
          }),
          group({
            feature: "agentcore/chat-engine",
            source: "foreground",
            ownedByUser: true,
            calls: 1,
            costMicroCents: 500,
          }),
        ],
      }),
    );
    expect(report.byFeature).toEqual([
      {
        feature: "agentcore/chat-engine",
        calls: 4,
        klornCalls: 3,
        unpricedCalls: 0,
        foregroundCalls: 3,
        backgroundCalls: 1,
        klornUsd: 0.0015,
        usdPerCall: 0.0005,
      },
    ]);
  });

  it("reports per-user-day spend by plan as p50, p90 and max", () => {
    const report = buildLlmCostReport(
      input({
        userDays: [
          { userId: "a", costMicroCents: 2000 },
          { userId: "a", costMicroCents: 500 },
          { userId: "b", costMicroCents: 9000 },
          { userId: "c", costMicroCents: 50 },
        ],
        planOf: new Map([
          ["a", "PRO"],
          ["b", "PRO"],
          ["c", "FREE"],
        ]),
      }),
    );
    expect(report.perUserDay.PRO).toEqual({
      userDays: 3,
      p50Usd: 0.002,
      p90Usd: 0.009,
      maxUsd: 0.009,
    });
    expect(report.perUserDay.FREE).toEqual({
      userDays: 1,
      p50Usd: 0.00005,
      p90Usd: 0.00005,
      maxUsd: 0.00005,
    });
  });

  it("keeps system calls out of the per-user figures and reports them on their own", () => {
    const report = buildLlmCostReport(
      input({
        userDays: [
          { userId: null, costMicroCents: 700 },
          { userId: "u1", costMicroCents: 300 },
        ],
        planOf: new Map([["u1", "FREE"]]),
      }),
    );
    expect(report.totals.systemUsd).toBe(0.0007);
    expect(report.perUserDay.FREE).toMatchObject({ userDays: 1, maxUsd: 0.0003 });
  });

  it("counts calls with no usage as unpriced instead of letting them read as free", () => {
    const report = buildLlmCostReport(
      input({
        features: [
          group({ feature: "mail/email-reply", calls: 2, costMicroCents: 1000 }),
          group({ feature: "mail/email-reply", usageMissing: true, calls: 8, costMicroCents: 0 }),
        ],
      }),
    );
    expect(report.byFeature[0]).toMatchObject({ calls: 10, unpricedCalls: 8, usdPerCall: 0.0005 });
    expect(report.totals.usageMissingCalls).toBe(8);
  });

  it("never puts user ids in the report", () => {
    const report = buildLlmCostReport(
      input({ userDays: [{ userId: "secret-user-id", costMicroCents: 10 }] }),
    );
    expect(JSON.stringify(report)).not.toContain("secret-user-id");
  });
});
