/**
 * IMAP polling scheduler (formerly naver-imap-scheduler; generalized in
 * Phase 2 to every app-password IMAP provider).
 *
 * Every POLL_INTERVAL_MS, walks every (user, provider) pair that has an
 * enabled IMAP provider connected and fans out over their rows. Errors from
 * one user never block the others — caught + logged.
 *
 * Why polling instead of IMAP IDLE: Render's free tier dyno can sleep,
 * and IMAP IDLE holds a TCP connection that breaks when the dyno wakes.
 * Polling every 5 minutes is the simplest robust shape; we can revisit
 * once we move off free tier.
 */

import { prisma } from "../db.js";
import { notifyConversationsUpdated } from "../notify/conversations-updated.js";
import { recordSchedulerTick, registerScheduler } from "../scheduler-heartbeat.js";
import { captureError } from "../sentry.js";
import { syncImapAccountsForUser } from "./imap-accounts.js";
import { enabledImapProviderKeys, IMAP_PROVIDERS, type ImapProviderKey } from "./imap-providers.js";

let intervalId: ReturnType<typeof setInterval> | null = null;
let firstTickTimer: ReturnType<typeof setTimeout> | null = null;
const POLL_INTERVAL_MS = 5 * 60_000; // 5 minutes

async function tickOnce(): Promise<void> {
  // Providers re-evaluated each tick so a flag flip (ICLOUD_INBOX_ENABLED)
  // takes effect without a restart. Rows for a disabled provider are simply
  // never selected — connect is blocked separately at the route (404).
  const providers = enabledImapProviderKeys();
  const owners = await prisma.linkedInboxAccount.groupBy({
    by: ["userId", "provider"],
    where: { provider: { in: providers } },
  });
  if (owners.length === 0) return;

  // Run serially — IMAP providers rate-limit aggressively when you open
  // multiple LOGIN sessions from the same IP in quick succession.
  for (const owner of owners) {
    const provider = IMAP_PROVIDERS[owner.provider as ImapProviderKey];
    if (!provider) continue; // groupBy is provider-filtered; belt and braces
    try {
      const result = await syncImapAccountsForUser(owner.userId, provider);
      if (result) {
        console.log(
          `[${provider.logScope}] user ${owner.userId}: fetched=${result.fetched} inserted=${result.inserted} errors=${result.errors}`,
        );
        // IMAP mail previously reached clients only via their own polling —
        // no WS signal existed anywhere on this path. Same wake the Gmail
        // paths send; per-user throttle inside.
        if (result.inserted > 0) notifyConversationsUpdated(owner.userId);
      }
    } catch (err) {
      // Terminal handler for the per-user sync — console first so a
      // failure is visible without a Sentry DSN (self-host / dev).
      console.warn(`[imap-scheduler] sync failed for user ${owner.userId}:`, err);
      captureError(err, {
        tags: { scope: "imap-scheduler" },
        extra: { userId: owner.userId, provider: owner.provider },
      });
    }
  }
}

/**
 * One poll tick. There is no global lock: ticks used to be serialised by one boolean,
 * so a tick that never settled stopped ALL IMAP polling for good, Naver and iCloud
 * included, while the heartbeat (recorded before the guard) stayed green. Double-polling
 * is prevented per ACCOUNT instead, inside the fan-out (imap-accounts.ts): an account whose
 * previous poll is still running is skipped, so a stuck account blocks neither the
 * others nor the next tick, and every session ends by its own wall-clock deadline
 * (FIXED_HOST_SESSION_DEADLINE_MS, GENERIC_SESSION_DEADLINE_MS). The heartbeat is
 * recorded here, by a tick that actually runs.
 */
export async function runImapTick(): Promise<void> {
  recordSchedulerTick("imap");
  await tickOnce();
}

export function startImapScheduler(): void {
  // Guard the boot window too: intervalId isn't set until the first tick fires
  // ~30s in, so a second start() call before then would schedule a duplicate
  // first tick. Track the setTimeout handle so the double-start guard covers it.
  if (intervalId || firstTickTimer) return;
  registerScheduler("imap", POLL_INTERVAL_MS);
  // First tick after 30s so the API server can finish booting before
  // we open IMAP sockets. Subsequent ticks on the regular interval.
  firstTickTimer = setTimeout(() => {
    firstTickTimer = null;
    runImapTick().catch((err) =>
      captureError(err, { tags: { scope: "imap-scheduler.first-tick" } }),
    );
    intervalId = setInterval(() => {
      runImapTick().catch((err) => captureError(err, { tags: { scope: "imap-scheduler.tick" } }));
    }, POLL_INTERVAL_MS);
  }, 30_000);
  console.log(
    `[imap-scheduler] started — first tick in 30s, then every ${POLL_INTERVAL_MS / 1000}s`,
  );
}

export function stopImapScheduler(): void {
  if (firstTickTimer) {
    clearTimeout(firstTickTimer);
    firstTickTimer = null;
  }
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
