/**
 * QUEUE ranking, the Today list (docs/design/attention-engine-v3.md §3(5)):
 * items held by the interrupt budget first, by importance and then in the
 * order they were held (so mail from strangers that spent the budget cannot
 * push a known sender's held alert down); then importance × deadline proximity; ties go to newer mail, then id, so the order
 * is total and independent of input order. Pure; returns a new array.
 * No numeric score is exposed to clients (it would read as an accuracy claim).
 */

import type { FactAsk, FactsV1 } from "./policy-types.js";

/** Proximity rises linearly from 1 (due this far away or more) to 2 (due now or overdue). */
export const DEADLINE_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PROXIMITY_BOOST = 1;

export interface RankableItem {
  id: string;
  receivedAt: Date;
  /** Importance in [0, 1] (importancePrior until P5). */
  importance: number;
  /** Earliest ask deadline, ISO 8601, or null. */
  due: string | null;
  /** When the interrupt budget held it, or null. */
  heldAt: Date | null;
}

export function deadlineProximity(due: string | null, now: Date): number {
  const at = due ? Date.parse(due) : Number.NaN;
  if (!Number.isFinite(at)) return 1;
  const remaining = Math.max(0, at - now.getTime());
  const closeness = Math.max(0, (DEADLINE_HORIZON_MS - remaining) / DEADLINE_HORIZON_MS);
  return 1 + MAX_PROXIMITY_BOOST * closeness;
}

export function rankScore(item: RankableItem, now: Date): number {
  return item.importance * deadlineProximity(item.due, now);
}

/** The earliest valid deadline among the asks, as written, or null. */
export function earliestDue(asks: readonly FactAsk[]): string | null {
  let best: { due: string; at: number } | null = null;
  for (const ask of asks) {
    const at = ask.due ? Date.parse(ask.due) : Number.NaN;
    if (!ask.due || !Number.isFinite(at)) continue;
    if (best === null || at < best.at) best = { due: ask.due, at };
  }
  return best?.due ?? null;
}

/**
 * The deadline an item ranks by: its earliest ask deadline. A payment/security
 * risk with no deadline ranks as due now; it is time-sensitive by nature, and
 * an untrusted one sits in QUEUE rather than interrupting (policy.ts).
 */
export function rankDue(facts: FactsV1, decidedAt: Date): string | null {
  const due = earliestDue(facts.asks);
  if (due !== null) return due;
  const risky = facts.risk.includes("payment_failed") || facts.risk.includes("security_alert");
  return risky && !facts.risk.includes("phishing_suspect") ? decidedAt.toISOString() : null;
}

export function rankQueue<T extends RankableItem>(items: readonly T[], now: Date): T[] {
  const scored = items.map((item) => ({ item, score: rankScore(item, now) }));
  scored.sort((a, b) => compareRanked(a.item, a.score, b.item, b.score));
  return scored.map((s) => s.item);
}

function compareRanked(a: RankableItem, aScore: number, b: RankableItem, bScore: number): number {
  if (a.heldAt && b.heldAt) {
    return b.importance - a.importance || a.heldAt.getTime() - b.heldAt.getTime() || tieBreak(a, b);
  }
  if (a.heldAt) return -1;
  if (b.heldAt) return 1;
  return bScore - aScore || tieBreak(a, b);
}

function tieBreak(a: RankableItem, b: RankableItem): number {
  const byTime = b.receivedAt.getTime() - a.receivedAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
