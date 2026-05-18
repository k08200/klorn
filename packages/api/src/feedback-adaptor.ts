/**
 * Feedback Adaptor — closes the FeedbackEvent → attention tier loop.
 *
 * Problem: FeedbackEvent records every DISMISSED/IGNORED signal from the user,
 * but nothing was reading those signals to change future behavior.
 *
 * Solution: Periodically analyse dismiss rates per (attention source, type,
 * priority bucket) tuple and write the suppressed tuples to Memory.
 * attention-mirror.ts reads that Memory at upsert time and forces SILENT
 * tier for consistently-rejected patterns.
 *
 * Granularity (audited 2026-05-19): the previous (source, type) pair was
 * too blunt — dismissing 4 due-today commitments would silence every
 * commitment-due signal, including overdue ones. We now also key on a
 * coarse priority bucket so the user can say "I don't care about LOW
 * priority due commitments" without losing the HIGH ones.
 *
 * The v2 key remains backward-compatible: a v1 entry without bucket
 * matches all buckets, so the old data still works while we migrate.
 *
 * Flow:
 *   1. runFeedbackAdaptation(userId) — weekly, called from pattern-learner
 *   2. Reads FeedbackEvent + joins AttentionItem to get (source, type, bucket) counts
 *   3. Writes "attention_suppression_v2" Memory key with suppressed tuples JSON
 *   4. getSuppressionSet(userId) — cached 10-min TTL, read by attention-mirror
 */

import { prisma } from "./db.js";
import { remember } from "./memory.js";

const SUPPRESSION_KEY = "attention_suppression_v2";
const LEGACY_SUPPRESSION_KEY = "attention_suppression_v1";
const DISMISS_THRESHOLD = 4; // dismiss ≥4 of same tuple in 30 days → SILENT
const LOOK_BACK_DAYS = 30;

export type PriorityBucket = "HIGH" | "MEDIUM" | "LOW";

export interface SuppressionEntry {
  source: string;
  type: string;
  /** Optional priority bucket; absent = matches every bucket (legacy v1 row). */
  bucket?: PriorityBucket;
  dismissCount: number;
}

/** Map AttentionItem.priority (0-100) into a coarse bucket. */
export function priorityBucket(priority: number): PriorityBucket {
  if (priority >= 70) return "HIGH";
  if (priority >= 40) return "MEDIUM";
  return "LOW";
}

/** Stable key for a suppression tuple. */
export function suppressionKey(
  source: string,
  type: string,
  bucket?: PriorityBucket | null,
): string {
  return bucket ? `${source}:${type}:${bucket}` : `${source}:${type}`;
}

// In-process cache to avoid per-upsert DB reads
const cache = new Map<string, { set: Set<string>; expiresAt: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ─── Public: read ────────────────────────────────────────────────────────────

/**
 * Returns a Set of suppression-key strings the user consistently dismisses.
 * Each entry is either `SOURCE:TYPE` (legacy/wildcard) or `SOURCE:TYPE:BUCKET`
 * (granular). Backed by a 10-minute in-process cache; empty set on error.
 *
 * Reads v2 first, then falls back to v1 so existing data keeps working.
 */
export async function getSuppressionSet(userId: string): Promise<Set<string>> {
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.set;

  try {
    const mems = await prisma.memory.findMany({
      where: {
        userId,
        type: "CONTEXT",
        key: { in: [SUPPRESSION_KEY, LEGACY_SUPPRESSION_KEY] },
      },
    });
    const set = new Set<string>();
    for (const mem of mems) {
      try {
        const entries = JSON.parse(mem.content) as SuppressionEntry[];
        for (const e of entries) {
          set.add(suppressionKey(e.source, e.type, e.bucket ?? null));
        }
      } catch {
        // Skip malformed memory blobs; the next adaptation run will repair them.
      }
    }
    cache.set(userId, { set, expiresAt: Date.now() + CACHE_TTL_MS });
    return set;
  } catch {
    return new Set();
  }
}

/**
 * Test whether the (source, type, priority) tuple is suppressed. Matches in
 * order of specificity: granular bucket → broad pair (legacy / wildcard).
 *
 * Callers should pass `priority` from the AttentionItem when they have it.
 * When priority is unknown, only the broad pair is checked.
 */
export function isSuppressed(
  set: Set<string>,
  source: string,
  type: string,
  priority?: number,
): boolean {
  if (typeof priority === "number") {
    const bucket = priorityBucket(priority);
    if (set.has(suppressionKey(source, type, bucket))) return true;
  }
  return set.has(suppressionKey(source, type));
}

/** Invalidate the cache for a user — call after runFeedbackAdaptation */
export function invalidateSuppressionCache(userId: string): void {
  cache.delete(userId);
}

// ─── Public: write ───────────────────────────────────────────────────────────

/**
 * Analyse the last 30 days of FeedbackEvents and update the suppression Memory.
 * Called from pattern-learner weekly cycle.
 */
export async function runFeedbackAdaptation(userId: string): Promise<number> {
  try {
    const since = new Date(Date.now() - LOOK_BACK_DAYS * 24 * 60 * 60 * 1000);

    // Fetch dismissed/ignored AttentionItem feedback events
    const events = await prisma.feedbackEvent.findMany({
      where: {
        userId,
        source: "ATTENTION_ITEM",
        signal: { in: ["DISMISSED", "IGNORED"] },
        createdAt: { gte: since },
      },
      select: { sourceId: true },
    });

    if (events.length === 0) return 0;

    const attentionIds = [...new Set(events.map((e) => e.sourceId))];

    // Fetch source/type/priority for each dismissed AttentionItem so we can
    // bucket them and avoid over-broad suppression.
    const items = await (
      prisma.attentionItem as unknown as {
        findMany: (args: unknown) => Promise<
          Array<{ id: string; source: string; type: string; priority: number }>
        >;
      }
    ).findMany({
      where: { id: { in: attentionIds } },
      select: { id: true, source: true, type: true, priority: true },
    });

    const itemMap = new Map(items.map((i) => [i.id, i]));

    // Count dismissals per (source, type, bucket) tuple.
    interface CountKey {
      source: string;
      type: string;
      bucket: PriorityBucket;
    }
    const counts = new Map<string, { key: CountKey; count: number }>();
    for (const event of events) {
      const item = itemMap.get(event.sourceId);
      if (!item) continue;
      const bucket = priorityBucket(item.priority);
      const k = suppressionKey(item.source, item.type, bucket);
      const existing = counts.get(k);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(k, { key: { source: item.source, type: item.type, bucket }, count: 1 });
      }
    }

    // Collect tuples that exceed the threshold.
    const suppressed: SuppressionEntry[] = [];
    for (const { key, count } of counts.values()) {
      if (count >= DISMISS_THRESHOLD) {
        suppressed.push({
          source: key.source,
          type: key.type,
          bucket: key.bucket,
          dismissCount: count,
        });
      }
    }

    // Persist to Memory (overwrites previous v2; v1 is left alone so an
    // accidental rollback to old code still has data to read).
    await remember(
      userId,
      "CONTEXT",
      SUPPRESSION_KEY,
      JSON.stringify(suppressed),
      "feedback-adaptor",
    );

    invalidateSuppressionCache(userId);

    if (suppressed.length > 0) {
      console.log(
        `[FEEDBACK-ADAPTOR] ${suppressed.length} suppressed tuple(s) for user ${userId}:`,
        suppressed
          .map((s) => `${s.source}/${s.type}/${s.bucket ?? "*"}(${s.dismissCount}x)`)
          .join(", "),
      );
    }

    return suppressed.length;
  } catch (err) {
    console.warn("[FEEDBACK-ADAPTOR] runFeedbackAdaptation failed for", userId, err);
    return 0;
  }
}

// ─── Batch runner ─────────────────────────────────────────────────────────────

export async function runFeedbackAdaptationForAllUsers(): Promise<void> {
  try {
    const configs = await prisma.automationConfig.findMany({
      where: { autonomousAgent: true },
      select: { userId: true },
    });
    for (const { userId } of configs) {
      try {
        await runFeedbackAdaptation(userId);
      } catch {
        // skip individual failures
      }
    }
  } catch (err) {
    console.error("[FEEDBACK-ADAPTOR] Batch run failed:", err);
  }
}
