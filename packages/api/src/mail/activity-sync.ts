/**
 * Activity-driven mail pull.
 *
 * The scheduler's per-user email sync sits behind gates a user can silently
 * fall out of — most sharply, a user with NO AutomationConfig row is never in
 * the scheduler's loop at all. With Gmail push unconfigured there is then no
 * second path and mail simply stops with no in-app signal.
 *
 * Scope, stated honestly: this fixes the GATE-FALLOUT class only. A dead or
 * revoked OAuth token (invalid_grant) still needs the user to reconnect —
 * that path is surfaced by /api/email/inboxes needsReconnect and the
 * clients' reconnect affordance, not repaired here.
 *
 * Cadence caveat: the desktop client polls on a timer whether or not anyone
 * is looking, so for it this is closer to "signed in" than "active". It is
 * therefore opt-OUT-able without a deploy (ACTIVITY_MAIL_SYNC_DISABLED) and
 * respects the user's own emailAutoClassify toggle.
 *
 * Deliberately its own module: the firewall read path must not statically
 * import the whole ingestion graph (googleapis, judge, persist) just to fire
 * a background pull. syncEmails is loaded on demand, inside the try.
 */

import { prisma } from "../db.js";
import { captureError } from "../sentry.js";

const mailSyncLastRun = new Map<string, number>();
const MAIL_SYNC_DEBOUNCE_MS = 60_000;
const ACTIVITY_SYNC_MAX_RESULTS = 30;
// The debounce map is process-lifetime state; drop the oldest half rather
// than growing it per distinct user forever.
const MAX_TRACKED_USERS = 5_000;

/** Operator kill switch — this runs on the hottest endpoint, so it must be
 * stoppable by an env flip, not a deploy. Read at call time. */
function activitySyncDisabled(): boolean {
  return ["true", "1", "yes", "on"].includes(
    (process.env.ACTIVITY_MAIL_SYNC_DISABLED ?? "").trim().toLowerCase(),
  );
}

/** Honor the user's own switch: a MISSING config is the gate-fallout case
 * this hook exists for (sync), an explicit `false` is a real preference
 * (skip). Never throws — a lookup failure falls through to syncing. */
async function autoClassifyAllows(userId: string): Promise<boolean> {
  try {
    const config = await prisma.automationConfig.findUnique({
      where: { userId },
      select: { emailAutoClassify: true },
    });
    return config?.emailAutoClassify !== false;
  } catch {
    return true;
  }
}

/**
 * Pull recent mail because the user is LOOKING at the app right now.
 * Fire-and-forget safe: never throws, debounced per user (60 s, in-memory —
 * the scheduler's own cadence, so an active user is not synced twice as
 * often as a passive one). `sync` is injectable for tests only.
 */
export async function ensureRecentMailSync(
  userId: string,
  sync?: (userId: string, maxResults: number) => Promise<unknown>,
): Promise<void> {
  if (activitySyncDisabled()) return;
  const last = mailSyncLastRun.get(userId);
  if (last && Date.now() - last < MAIL_SYNC_DEBOUNCE_MS) return;
  mailSyncLastRun.set(userId, Date.now());
  if (mailSyncLastRun.size > MAX_TRACKED_USERS) {
    for (const key of [...mailSyncLastRun.keys()].slice(0, MAX_TRACKED_USERS / 2)) {
      mailSyncLastRun.delete(key);
    }
  }
  try {
    if (!(await autoClassifyAllows(userId))) return;
    const run = sync ?? (await import("./email-sync.js")).syncEmails;
    const result = await run(userId, ACTIVITY_SYNC_MAX_RESULTS);
    // Every other sync producer wakes the open clients on new mail; this one
    // silently didn't, so opening the firewall on one device left a second
    // device stale until its own poll (realtime audit 2026-08-18).
    const newCount = (result as { newCount?: number } | undefined)?.newCount ?? 0;
    if (newCount > 0) {
      const { notifyConversationsUpdated } = await import("../notify/conversations-updated.js");
      notifyConversationsUpdated(userId);
    }
  } catch (err) {
    // "Gmail not connected" is the expected shape for a dead token — the
    // reconnect prompt is surfaced by /api/email/inboxes, not by shouting
    // here every 60 s. Anything else is a real fault worth a breadcrumb.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/not connected/i.test(msg)) {
      console.warn(`[MAIL-SYNC] activity sync failed for ${userId}: ${msg}`);
      captureError(err, { tags: { scope: "mail.activity-sync" }, extra: { userId } });
    }
  }
}
