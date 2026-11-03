/**
 * Fact-level scoring for the facts v1 eval set (docs/design/attention-engine-v3.md
 * §5: per-field precision/recall, evidence validity rate, date accuracy).
 * Pure: compares an extracted FactsV1 with a partial label; a field missing
 * from the label is ambiguous for that item and is not scored.
 */

import type { AddressedTo, AskKind, FactsV1, MailKind, Risk, ThreadTurn } from "./facts-schema.js";

export type DueBucket = "none" | "within24h" | "later";

export interface FactLabel {
  addressedTo?: AddressedTo;
  kind?: MailKind;
  threadTurn?: ThreadTurn;
  asksPresent?: boolean;
  askKinds?: AskKind[];
  due?: DueBucket;
  event?: boolean;
  /** null = no transaction; kind null = any kind. */
  transaction?: { kind: string | null; actionRequired: boolean } | null;
  risk?: Risk[];
}

const DAY_MS = 86_400_000;

/** Earliest due among the asks, bucketed against the mail's receipt time. */
export function dueBucket(facts: FactsV1, receivedAt: Date): DueBucket {
  const dues = facts.asks
    .map((a) => (a.due === null ? Number.NaN : Date.parse(a.due)))
    .filter((t) => Number.isFinite(t));
  if (dues.length === 0) return "none";
  return Math.min(...dues) - receivedAt.getTime() <= DAY_MS ? "within24h" : "later";
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

function transactionMatches(label: FactLabel["transaction"], facts: FactsV1): boolean {
  if (label === null || label === undefined) return facts.transaction === null;
  if (!facts.transaction) return false;
  return label.kind === null || label.kind === facts.transaction.kind;
}

export type ScoredField =
  | "addressedTo"
  | "kind"
  | "threadTurn"
  | "asksPresent"
  | "due"
  | "event"
  | "transaction"
  | "risk";

/** Per-field correctness for one item (only fields the label scores). */
export function scoreItem(
  facts: FactsV1,
  label: FactLabel,
  receivedAt: Date,
): Partial<Record<ScoredField, boolean>> {
  const out: Partial<Record<ScoredField, boolean>> = {};
  if (label.addressedTo) out.addressedTo = facts.addressedTo === label.addressedTo;
  if (label.kind) out.kind = facts.kind === label.kind;
  if (label.threadTurn) out.threadTurn = facts.threadTurn === label.threadTurn;
  if (label.asksPresent !== undefined)
    out.asksPresent = facts.asks.length > 0 === label.asksPresent;
  if (label.due) out.due = dueBucket(facts, receivedAt) === label.due;
  if (label.event !== undefined) out.event = (facts.event !== null) === label.event;
  if (label.transaction !== undefined)
    out.transaction = transactionMatches(label.transaction, facts);
  if (label.risk) out.risk = sameSet(facts.risk, label.risk);
  return out;
}

export interface EvalItemResult {
  id: string;
  facts: FactsV1 | null;
  label: FactLabel;
  receivedAt: Date;
  asksChecked: number;
  asksDropped: number;
}

export function summarizeFactEval(results: readonly EvalItemResult[]) {
  const fields: Record<string, { correct: number; total: number }> = {};
  let kindTp = 0;
  let kindFp = 0;
  let kindFn = 0;
  let checked = 0;
  let dropped = 0;
  let noFacts = 0;
  const misses: { id: string; fields: string[] }[] = [];
  for (const r of results) {
    checked += r.asksChecked;
    dropped += r.asksDropped;
    if (!r.facts) {
      noFacts++;
      continue;
    }
    const scored = scoreItem(r.facts, r.label, r.receivedAt);
    const wrong: string[] = [];
    for (const [field, ok] of Object.entries(scored)) {
      fields[field] = fields[field] ?? { correct: 0, total: 0 };
      fields[field].total++;
      if (ok) fields[field].correct++;
      else wrong.push(field);
    }
    if (wrong.length) misses.push({ id: r.id, fields: wrong });
    if (r.label.askKinds) {
      const got = new Set(r.facts.asks.map((a) => a.kind));
      const want = new Set(r.label.askKinds);
      for (const k of got) want.has(k) ? kindTp++ : kindFp++;
      for (const k of want) if (!got.has(k)) kindFn++;
    }
  }
  const accuracy = Object.fromEntries(
    Object.entries(fields).map(([f, v]) => [
      f,
      { ...v, accuracy: v.total ? v.correct / v.total : null },
    ]),
  );
  return {
    items: results.length,
    noFacts,
    fields: accuracy,
    askKinds: {
      precision: kindTp + kindFp ? kindTp / (kindTp + kindFp) : null,
      recall: kindTp + kindFn ? kindTp / (kindTp + kindFn) : null,
    },
    evidenceValidity: checked ? (checked - dropped) / checked : null,
    misses,
  };
}
