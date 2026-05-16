/**
 * Feedback Adaptor — closes the FeedbackEvent → attention tier loop.
 *
 * Problem: FeedbackEvent records every DISMISSED/IGNORED signal from the user,
 * but nothing was reading those signals to change future behavior.
 *
 * Solution: Periodically analyse dismiss rates per (attention source, type) pair
 * and write the suppressed pairs to Memory. attention-mirror.ts reads that
 * Memory at upsert time and forces SILENT tier for consistently-rejected patterns.
 *
 * Flow:
 *   1. runFeedbackAdaptation(userId) — weekly, called from pattern-learner
 *   2. Reads FeedbackEvent + joins AttentionItem to get (source, type) counts
 *   3. Writes "attention_suppression_v1" Memory key with suppressed pairs JSON
 *   4. getSuppressionSet(userId) — cached 10-min TTL, read by attention-mirror
 */

import { prisma } from "./db.js";
import { remember } from "./memory.js";

const SUPPRESSION_KEY = "attention_suppression_v1";
const DISMISS_THRESHOLD = 4; // dismiss ≥4 of same type in 30 days → SILENT
const LOOK_BACK_DAYS = 30;

export interface SuppressionEntry {
  source: string;
  type: string;
  dismissCount: number;
}

// In-process cache to avoid per-upsert DB reads
const cache = new Map<string, { set: Set<string>; expiresAt: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ─── Public: read ────────────────────────────────────────────────────────────

/**
 * Returns a Set of "SOURCE:TYPE" strings the user consistently dismisses.
 * Backed by a 10-minute in-process cache; falls back to empty set on error.
 */
export async function getSuppressionSet(userId: string): Promise<Set<string>> {
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.set;

  try {
    const mem = await prisma.memory.findUnique({
      where: { userId_type_key: { userId, type: "CONTEXT", key: SUPPRESSION_KEY } },
    });
    if (!mem) {
      const empty = new Set<string>();
      cache.set(userId, { set: empty, expiresAt: Date.now() + CACHE_TTL_MS });
      return empty;
    }
    const entries = JSON.parse(mem.content) as SuppressionEntry[];
    const set = new Set(entries.map((e) => `${e.source}:${e.type}`));
    cache.set(userId, { set, expiresAt: Date.now() + CACHE_TTL_MS });
    return set;
  } catch {
    return new Set();
  }
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

    // Fetch source/type for each dismissed AttentionItem
    const items = await (prisma.attentionItem as unknown as {
      findMany: (args: unknown) => Promise<Array<{ id: string; source: string; type: string }>>;
    }).findMany({
      where: { id: { in: attentionIds } },
      select: { id: true, source: true, type: true },
    });

    const itemMap = new Map(items.map((i) => [i.id, i]));

    // Count dismissals per (source, type) pair
    const counts = new Map<string, number>();
    for (const event of events) {
      const item = itemMap.get(event.sourceId);
      if (!item) continue;
      const key = `${item.source}:${item.type}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    // Collect pairs that exceed the threshold
    const suppressed: SuppressionEntry[] = [];
    for (const [key, count] of counts) {
      if (count >= DISMISS_THRESHOLD) {
        const [source, type] = key.split(":");
        suppressed.push({ source, type, dismissCount: count });
      }
    }

    // Persist to Memory (overwrites any previous version)
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
        `[FEEDBACK-ADAPTOR] ${suppressed.length} suppressed pair(s) for user ${userId}:`,
        suppressed.map((s) => `${s.source}/${s.type}(${s.dismissCount}x)`).join(", "),
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
