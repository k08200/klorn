/**
 * The founder's LLM cost report: Klorn's spend per feature and per user-day by
 * plan, with spend on users' own keys (BYOK), calls with no feature and calls
 * with no usage kept apart. Pure — the script (scripts/llm-cost-report.ts)
 * aggregates in the database and hands the groups here, so the report never
 * holds raw rows. User ids are only used to look up plans and never appear in
 * the result.
 */

/** LlmUsageLog grouped by (feature, source, ownedByUser) over the window. */
export interface FeatureGroup {
  feature: string | null;
  source: string;
  ownedByUser: boolean;
  /** The provider returned no usage block: the cost is unknown, not zero. */
  usageMissing: boolean;
  calls: number;
  costMicroCents: number;
}

/**
 * One row per user per UTC day: Klorn-paid spend on attributed, priced calls
 * (ownedByUser = false, feature set, usage present). userId null = system
 * calls that day.
 */
export interface UserDaySpend {
  userId: string | null;
  costMicroCents: number;
}

export interface FeatureCost {
  feature: string;
  calls: number;
  /** Calls Klorn paid for (not served on users' own keys). */
  klornCalls: number;
  /** Calls with no usage block: their cost is unknown and left out of usdPerCall. */
  unpricedCalls: number;
  foregroundCalls: number;
  backgroundCalls: number;
  /** Spend Klorn paid (excludes calls served on users' own keys). */
  klornUsd: number;
  /** What one priced call costs on average, whoever paid. */
  usdPerCall: number;
}

export interface UserDayCost {
  userDays: number;
  p50Usd: number;
  p90Usd: number;
  maxUsd: number;
}

export interface LlmCostReport {
  totals: {
    calls: number;
    klornUsd: number;
    byokUsd: number;
    /** Klorn spend on attributed calls made without a user (schedulers, sweeps). */
    systemUsd: number;
    /** Calls with no feature: written before attribution shipped, or by an old pod. */
    unattributedCalls: number;
    /** Calls whose provider returned no usage block (cost unknown, counted as 0). */
    usageMissingCalls: number;
  };
  byFeature: FeatureCost[];
  /** Klorn spend per user per UTC day on attributed calls, keyed by plan. */
  perUserDay: Record<string, UserDayCost>;
}

export interface CostReportInput {
  features: FeatureGroup[];
  userDays: UserDaySpend[];
  planOf: ReadonlyMap<string, string>;
}

const MICRO_PER_USD = 1_000_000;
const UNATTRIBUTED = "(unattributed)";
const UNKNOWN_PLAN = "UNKNOWN";

const toUsd = (micro: number): number => micro / MICRO_PER_USD;

/** Nearest-rank percentile of an ascending list (q in 0..1). */
function percentile(sortedAsc: number[], q: number): number {
  const rank = Math.max(1, Math.ceil(q * sortedAsc.length));
  return sortedAsc[rank - 1];
}

interface FeatureAcc {
  calls: number;
  klornCalls: number;
  unpriced: number;
  fg: number;
  bg: number;
  klorn: number;
  priced: number;
}

const EMPTY_ACC: FeatureAcc = {
  calls: 0,
  klornCalls: 0,
  unpriced: 0,
  fg: 0,
  bg: 0,
  klorn: 0,
  priced: 0,
};

function summarizeFeatures(groups: FeatureGroup[]): FeatureCost[] {
  const byFeature = new Map<string, FeatureAcc>();
  for (const g of groups) {
    const key = g.feature ?? UNATTRIBUTED;
    const acc = byFeature.get(key) ?? EMPTY_ACC;
    const foreground = g.source === "foreground";
    byFeature.set(key, {
      calls: acc.calls + g.calls,
      klornCalls: acc.klornCalls + (g.ownedByUser ? 0 : g.calls),
      unpriced: acc.unpriced + (g.usageMissing ? g.calls : 0),
      fg: acc.fg + (foreground ? g.calls : 0),
      bg: acc.bg + (foreground ? 0 : g.calls),
      klorn: acc.klorn + (g.ownedByUser ? 0 : g.costMicroCents),
      priced: acc.priced + (g.usageMissing ? 0 : g.costMicroCents),
    });
  }
  return [...byFeature.entries()]
    .map(([feature, acc]) => {
      const pricedCalls = acc.calls - acc.unpriced;
      return {
        feature,
        calls: acc.calls,
        klornCalls: acc.klornCalls,
        unpricedCalls: acc.unpriced,
        foregroundCalls: acc.fg,
        backgroundCalls: acc.bg,
        klornUsd: toUsd(acc.klorn),
        usdPerCall: pricedCalls > 0 ? toUsd(acc.priced / pricedCalls) : 0,
      };
    })
    .sort((a, b) => b.klornUsd - a.klornUsd || a.feature.localeCompare(b.feature));
}

function summarizeUserDays(
  userDays: UserDaySpend[],
  planOf: ReadonlyMap<string, string>,
): Record<string, UserDayCost> {
  // One list per plan, built here and only read after; appending keeps it
  // linear in the number of user-days.
  const byPlan = new Map<string, number[]>();
  for (const d of userDays) {
    if (d.userId === null) continue;
    const plan = planOf.get(d.userId) ?? UNKNOWN_PLAN;
    const values = byPlan.get(plan) ?? [];
    values.push(d.costMicroCents);
    byPlan.set(plan, values);
  }
  const result: Record<string, UserDayCost> = {};
  for (const [plan, values] of byPlan) {
    const sorted = [...values].sort((a, b) => a - b);
    result[plan] = {
      userDays: sorted.length,
      p50Usd: toUsd(percentile(sorted, 0.5)),
      p90Usd: toUsd(percentile(sorted, 0.9)),
      maxUsd: toUsd(sorted[sorted.length - 1]),
    };
  }
  return result;
}

export function buildLlmCostReport(input: CostReportInput): LlmCostReport {
  const sum = (pick: (g: FeatureGroup) => number) =>
    input.features.reduce((total, g) => total + pick(g), 0);
  const systemMicro = input.userDays
    .filter((d) => d.userId === null)
    .reduce((total, d) => total + d.costMicroCents, 0);
  return {
    totals: {
      calls: sum((g) => g.calls),
      klornUsd: toUsd(sum((g) => (g.ownedByUser ? 0 : g.costMicroCents))),
      byokUsd: toUsd(sum((g) => (g.ownedByUser ? g.costMicroCents : 0))),
      systemUsd: toUsd(systemMicro),
      unattributedCalls: sum((g) => (g.feature === null ? g.calls : 0)),
      usageMissingCalls: sum((g) => (g.usageMissing ? g.calls : 0)),
    },
    byFeature: summarizeFeatures(input.features),
    perUserDay: summarizeUserDays(input.userDays, input.planOf),
  };
}
