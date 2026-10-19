/**
 * Outlook polling scheduler — Phase 3B, mirroring mail/imap-scheduler.ts.
 *
 * Every POLL_INTERVAL_MS, walks every user with an OUTLOOK row and fans out
 * via syncOutlookAccountsForUser. The scheduler itself always starts (so the
 * heartbeat registry stays truthful); the FLAG is checked per tick, so
 * flipping OUTLOOK_INBOX_ENABLED takes effect without a restart and rows are
 * simply never selected while it is off (CASA freeze — connect is separately
 * blocked at the 404-gated routes).
 *
 * Poll-first by design: Graph change-notification webhooks are a later
 * optimization (multi-provider plan Phase 3), not a launch requirement.
 */

import { outlookInboxEnabled } from "../config.js";
import { prisma } from "../db.js";
import { recordSchedulerTick, registerScheduler } from "../scheduler-heartbeat.js";
import { captureError } from "../sentry.js";
import { newWork } from "../work-context.js";
import { syncOutlookAccountsForUser } from "./outlook-accounts.js";

let intervalId: ReturnType<typeof setInterval> | null = null;
let firstTickTimer: ReturnType<typeof setTimeout> | null = null;
const POLL_INTERVAL_MS = 5 * 60_000; // 5 minutes

async function tickOnce(): Promise<void> {
  if (!outlookInboxEnabled()) return;
  const owners = await prisma.linkedInboxAccount.groupBy({
    by: ["userId"],
    where: { provider: "OUTLOOK" },
  });
  if (owners.length === 0) return;

  // Serial — Graph throttles per app+mailbox, and the shared persist path's
  // judge work is the real cost anyway.
  for (const owner of owners) {
    try {
      const result = await syncOutlookAccountsForUser(owner.userId);
      if (result) {
        console.log(
          `[outlook-sync] user ${owner.userId}: fetched=${result.fetched} inserted=${result.inserted} errors=${result.errors}`,
        );
      }
    } catch (err) {
      // Terminal handler for the per-user sync — console first so a failure
      // is visible without a Sentry DSN (self-host / dev).
      console.warn(`[outlook-scheduler] sync failed for user ${owner.userId}:`, err);
      captureError(err, {
        tags: { scope: "outlook-scheduler" },
        extra: { userId: owner.userId },
      });
    }
  }
}

export function startOutlookScheduler(): void {
  // Double-start guard covers the boot window too (see imap-scheduler).
  if (intervalId || firstTickTimer) return;
  registerScheduler("outlook", POLL_INTERVAL_MS);
  firstTickTimer = setTimeout(() => {
    firstTickTimer = null;
    recordSchedulerTick("outlook");
    tickOnce().catch((err) =>
      captureError(err, { tags: { scope: "outlook-scheduler.first-tick" } }),
    );
    intervalId = setInterval(
      newWork(() => {
        recordSchedulerTick("outlook");
        tickOnce().catch((err) => captureError(err, { tags: { scope: "outlook-scheduler.tick" } }));
      }),
      POLL_INTERVAL_MS,
    );
  }, 30_000);
  console.log(
    `[outlook-scheduler] started — first tick in 30s, then every ${POLL_INTERVAL_MS / 1000}s`,
  );
}

export function stopOutlookScheduler(): void {
  if (firstTickTimer) {
    clearTimeout(firstTickTimer);
    firstTickTimer = null;
  }
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
