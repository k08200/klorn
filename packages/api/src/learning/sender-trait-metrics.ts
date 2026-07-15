import type { SenderTraitKind } from "./sender-trait-policy.js";

export interface TraitRow {
  sender: string;
  factKind: SenderTraitKind;
  status: "active" | "superseded" | "conflicted";
  confidence: number;
}

export interface TraitMetrics {
  totalTraits: number;
  sendersWithTrait: number;
  coverage: number; // sendersWithTrait / activeSenderCount
  conflicted: number;
  conflictRate: number; // conflicted / totalTraits
  confidenceBuckets: { high: number; mid: number; low: number }; // >=0.8 / >=0.5 / <0.5
}

function ratio(n: number, d: number): number {
  return d === 0 ? 0 : n / d;
}

/**
 * Honest-by-construction measurement (mirrors decision-metrics.ts): all derived
 * from real rows, no invented confidence. `activeSenderCount` is the universe of
 * senders seen in the window, supplied by the caller.
 */
export function summarizeTraits(rows: TraitRow[], activeSenderCount: number): TraitMetrics {
  const senders = new Set(rows.map((r) => r.sender));
  const conflicted = rows.filter((r) => r.status === "conflicted").length;
  const buckets = { high: 0, mid: 0, low: 0 };
  for (const r of rows) {
    if (r.confidence >= 0.8) buckets.high++;
    else if (r.confidence >= 0.5) buckets.mid++;
    else buckets.low++;
  }
  return {
    totalTraits: rows.length,
    sendersWithTrait: senders.size,
    coverage: ratio(senders.size, activeSenderCount),
    conflicted,
    conflictRate: ratio(conflicted, rows.length),
    confidenceBuckets: buckets,
  };
}

/** Read traits + the distinct-sender universe for a user (or all) and summarize. */
export async function getTraitMetrics(prisma: typeof import("../db.js").prisma, userId?: string) {
  const where = userId ? { userId } : {};
  const [rows, senderGroups] = await Promise.all([
    prisma.senderTrait.findMany({
      where,
      select: { sender: true, factKind: true, status: true, confidence: true },
    }),
    // Coverage denominator = distinct senders the user has actually received
    // mail from, NOT the trait rows themselves (that would force coverage to a
    // meaningless 1.0). groupBy returns one row per distinct `from`.
    prisma.emailMessage.groupBy({ by: ["from"], where }),
  ]);
  return summarizeTraits(rows as TraitRow[], Math.max(senderGroups.length, 1));
}
