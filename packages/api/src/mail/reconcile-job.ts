/**
 * The scheduler's INBOX reconcile, run detached from its per-user cycle.
 *
 * Reconcile lists the whole Gmail INBOX and re-reads up to 500 messages per
 * inbox (email-sync.ts reconcileInboxScope), so its cost grows with the mailbox
 * rather than with what changed. Production, 2026-11-11: for the two users with
 * a few thousand mirrored messages the re-read alone took 41-51 s per inbox.
 * Awaited inside runUserCycle it overran the 30 s per-user budget every time it
 * ran, and since withTimeout cannot cancel, it went on in the background anyway
 * while the next tick re-entered the same user. Reconcile is maintenance (drop
 * rows that left the INBOX, refresh read/star state) with a 30-minute cadence,
 * so nothing waits on it: it runs here, at most one run per user and
 * MAX_CONCURRENT_RECONCILES users at a time, and never rejects. A run released
 * as stale is no longer counted but is not cancelled either (googleapis takes no
 * signal here), so it can briefly overlap its replacement; reconcile's deletes
 * and updates are idempotent and account-scoped, so that costs only Gmail reads.
 */

import { captureDbFailure, logDbFailure } from "../report-db-failure.js";
import { captureError } from "../sentry.js";
import { reconcileEmails, reconcileLinkedInboxes } from "./email-sync.js";

/** Users reconciled at once. Each run makes up to 8 concurrent Gmail reads. */
export const MAX_CONCURRENT_RECONCILES = 2;
/**
 * A run still going after this long gives its slot back. googleapis sets no
 * request timeout, so one hung call would otherwise hold the slot (and, at the
 * cap, every user's reconcile) until the process restarts.
 */
export const RECONCILE_STALE_AFTER_MS = 15 * 60_000;

/** userId → when its run started (also the run's claim token). */
const running = new Map<string, number>();

/** Test seam: the guard is module state. */
export function resetReconcileJobsForTests(): void {
  running.clear();
}

export interface ReconcileJobOptions {
  /** Also reconcile the user's linked inboxes (MULTI_INBOX_SYNC_ENABLED). */
  includeLinked: boolean;
}

/**
 * Start a detached reconcile for the user. Returns the run, which never
 * rejects, or null when the user's previous run is still going or
 * MAX_CONCURRENT_RECONCILES runs are; the caller tries again on a later tick.
 */
export function startDetachedReconcile(
  userId: string,
  opts: ReconcileJobOptions,
  now = Date.now(),
): Promise<void> | null {
  releaseStaleRuns(now);
  if (running.has(userId) || running.size >= MAX_CONCURRENT_RECONCILES) return null;
  running.set(userId, now);
  return reconcileUser(userId, opts)
    .catch((err) => {
      // Backstop only: reconcileUser catches its own failures. The caller drops
      // this promise, and an unhandled rejection would take the process down.
      logDbFailure("[AUTOMATION] Reconcile run escaped its handlers", err, {
        level: "error",
        ids: { userId },
      });
    })
    .finally(() => {
      // A run released as stale must not free the slot of the run that replaced it.
      if (running.get(userId) === now) running.delete(userId);
    });
}

function releaseStaleRuns(now: number): void {
  for (const [userId, startedAt] of running) {
    if (now - startedAt < RECONCILE_STALE_AFTER_MS) continue;
    running.delete(userId);
    const minutes = Math.round((now - startedAt) / 60_000);
    console.warn(`[AUTOMATION] Reconcile for ${userId} still running after ${minutes} min`);
    // One constant message so Sentry groups every occurrence into one issue.
    captureError(new Error("Reconcile run outlived its slot"), {
      tags: { scope: "automation.reconcile.stale", userId },
      extra: { minutes },
    });
  }
}

/** Primary first, then linked; each isolated so one failure never skips the other. */
async function reconcileUser(userId: string, opts: ReconcileJobOptions): Promise<void> {
  try {
    await reconcileEmails(userId);
  } catch (err) {
    logDbFailure("[AUTOMATION] Reconcile failed", err, { level: "error", ids: { userId } });
    captureDbFailure("[AUTOMATION] Reconcile failed", err, {
      tags: { scope: "automation.reconcile", userId },
    });
  }
  if (!opts.includeLinked) return;
  try {
    await reconcileLinkedInboxes(userId);
  } catch (err) {
    logDbFailure("[AUTOMATION] Linked-inbox reconcile failed", err, {
      level: "error",
      ids: { userId },
    });
    captureDbFailure("[AUTOMATION] Linked-inbox reconcile failed", err, {
      tags: { scope: "automation.reconcile.linked", userId },
    });
  }
}
