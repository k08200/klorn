/**
 * Two-model fact labelling for the founder's own mail
 * (docs/design/attention-engine-v3.md §5, protocol decided 2026-10-31): two
 * different frontier models label each mail independently; every disagreement
 * and every PUSH/MEETING-relevant item goes to the founder; only reconciled
 * labels count. Pure: compares two fact sets and drafts the label.
 */

import { dueBucket, type FactLabel } from "./fact-eval.js";
import type { FactsV1 } from "./facts-schema.js";

const URGENT_RISKS = new Set(["payment_failed", "security_alert"]);

/** The scored projection of a fact set (what the eval compares). */
export function labelFromFacts(facts: FactsV1, receivedAt: Date): Required<FactLabel> {
  return {
    addressedTo: facts.addressedTo,
    kind: facts.kind,
    threadTurn: facts.threadTurn,
    asksPresent: facts.asks.length > 0,
    askKinds: [...new Set(facts.asks.map((a) => a.kind))].sort(),
    due: dueBucket(facts, receivedAt),
    event: facts.event !== null,
    transaction: facts.transaction
      ? { kind: facts.transaction.kind, actionRequired: facts.transaction.actionRequired }
      : null,
    risk: [...facts.risk].sort(),
  };
}

/** Field names where the two drafts differ. */
export function labelDiffs(a: Required<FactLabel>, b: Required<FactLabel>): string[] {
  return (Object.keys(a) as (keyof FactLabel)[]).filter(
    (k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]),
  );
}

/** Could this item interrupt (PUSH) or notify (MEETING)? Then the founder decides. */
export function pushOrMeetingRelevant(label: Required<FactLabel>): boolean {
  return label.due === "within24h" || label.event || label.risk.some((r) => URGENT_RISKS.has(r));
}

export interface PairVerdict {
  agree: boolean;
  diffs: string[];
  needsReview: boolean;
  reviewReasons: string[];
  /** The agreed label (null when the models disagree or one gave no facts). */
  draft: Required<FactLabel> | null;
  /** Counts toward the eval now: agreed and not PUSH/MEETING-relevant. */
  reconciled: Required<FactLabel> | null;
}

export function comparePair(a: FactsV1 | null, b: FactsV1 | null, receivedAt: Date): PairVerdict {
  if (!a || !b) {
    return {
      agree: false,
      diffs: [],
      needsReview: true,
      reviewReasons: ["no_facts"],
      draft: null,
      reconciled: null,
    };
  }
  const la = labelFromFacts(a, receivedAt);
  const lb = labelFromFacts(b, receivedAt);
  const diffs = labelDiffs(la, lb);
  const relevant = pushOrMeetingRelevant(la) || pushOrMeetingRelevant(lb);
  const reviewReasons = [
    ...(diffs.length ? ["disagree"] : []),
    ...(relevant ? ["push_or_meeting"] : []),
  ];
  const draft = diffs.length === 0 ? la : null;
  return {
    agree: diffs.length === 0,
    diffs,
    needsReview: reviewReasons.length > 0,
    reviewReasons,
    draft,
    reconciled: reviewReasons.length === 0 ? draft : null,
  };
}
