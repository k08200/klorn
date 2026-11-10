/**
 * Importance prior for policy v3 (docs/design/attention-engine-v3.md §3(3)):
 * until P5 learns per-user importance from outcomes, the relationship layer
 * stands in. Pure, in [0, 1]. Unknown (null) features contribute nothing, so a
 * sender we know nothing about sits at the `unknown` base. Calendar
 * co-attendance is always null until attendee data exists (P2), so its weight
 * is reachable only later.
 */

import type { RelationshipSnapshot } from "./policy-types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const IMPORTANCE_PRIOR = {
  /** A sender with no relationship data. */
  unknown: 0.2,
  /** Positive weights sum to 1 - unknown, so a maximal correspondent reaches 1. */
  weights: { sent: 0.35, recency: 0.15, replyLatency: 0.1, sameOrg: 0.1, coAttendance: 0.1 },
  /** Dismissals subtract up to this much. */
  dismissWeight: 0.25,
  /** Sent count at which the (log-scaled) sent feature saturates. */
  sentSaturation: 20,
  recencyHalfLifeDays: 30,
  /** Reply latency at or under `fast` scores 1, at or over `slow` scores 0. */
  replyLatencyMs: { fast: 60 * 60 * 1000, slow: 7 * DAY_MS },
  dismissSaturation: 5,
} as const;

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

function sentFeature(sentCount: number | null): number {
  if (sentCount === null || sentCount <= 0) return 0;
  return clamp01(Math.log1p(sentCount) / Math.log1p(IMPORTANCE_PRIOR.sentSaturation));
}

function recencyFeature(lastSentAt: string | null, now: Date): number {
  const at = lastSentAt ? Date.parse(lastSentAt) : Number.NaN;
  if (!Number.isFinite(at)) return 0;
  const ageDays = Math.max(0, (now.getTime() - at) / DAY_MS);
  return 0.5 ** (ageDays / IMPORTANCE_PRIOR.recencyHalfLifeDays);
}

function replyLatencyFeature(ms: number | null): number {
  if (ms === null || !Number.isFinite(ms)) return 0;
  const { fast, slow } = IMPORTANCE_PRIOR.replyLatencyMs;
  return 1 - clamp01((ms - fast) / (slow - fast));
}

export function importancePrior(rel: RelationshipSnapshot | null, now: Date): number {
  if (!rel) return IMPORTANCE_PRIOR.unknown;
  // VIP (an investor/customer label or a PUSH pin) is maximal. A pin alone sets
  // the lane by precedence; "always QUEUE" is not "important", so it adds nothing.
  if (rel.vip === true) return 1;
  const w = IMPORTANCE_PRIOR.weights;
  const dismiss =
    rel.dismissCount === null ? 0 : clamp01(rel.dismissCount / IMPORTANCE_PRIOR.dismissSaturation);
  return clamp01(
    IMPORTANCE_PRIOR.unknown +
      w.sent * sentFeature(rel.sentCount) +
      w.recency * recencyFeature(rel.lastSentAt, now) +
      w.replyLatency * replyLatencyFeature(rel.medianReplyLatencyMs) +
      w.sameOrg * (rel.sameOrgDomain === true ? 1 : 0) +
      w.coAttendance * ((rel.coAttendanceNext14d ?? 0) > 0 ? 1 : 0) -
      IMPORTANCE_PRIOR.dismissWeight * dismiss,
  );
}
