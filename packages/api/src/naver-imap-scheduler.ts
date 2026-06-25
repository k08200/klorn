/**
 * Naver IMAP polling scheduler.
 *
 * Every POLL_INTERVAL_MS, walks every User that has Naver IMAP connected
 * and runs syncNaverImapForUser on them. Errors from one user never block
 * the others — caught + logged.
 *
 * Why polling instead of IMAP IDLE: Render's free tier dyno can sleep,
 * and IMAP IDLE holds a TCP connection that breaks when the dyno wakes.
 * Polling every 5 minutes is the simplest robust shape; we can revisit
 * once we move off free tier.
 */

import { prisma } from "./db.js";
import { syncNaverImapForUser } from "./naver-imap.js";
import { captureError } from "./sentry.js";

let intervalId: ReturnType<typeof setInterval> | null = null;
let firstTickTimer: ReturnType<typeof setTimeout> | null = null;
const POLL_INTERVAL_MS = 5 * 60_000; // 5 minutes

async function tickOnce(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { naverImapEmail: { not: null } },
    select: { id: true, naverImapEmail: true },
  });
  if (users.length === 0) return;

  // Run serially — Naver IMAP per-user rate-limits aggressively when you
  // open multiple LOGIN sessions from the same IP in quick succession.
  for (const user of users) {
    try {
      const result = await syncNaverImapForUser(user.id);
      if (result) {
        console.log(
          `[naver-imap] ${user.naverImapEmail}: fetched=${result.fetched} inserted=${result.inserted} errors=${result.errors}`,
        );
      }
    } catch (err) {
      // Terminal handler for the per-user Naver sync — console first so a
      // failure is visible without a Sentry DSN (self-host / dev).
      console.warn(`[naver-imap-scheduler] sync failed for user ${user.id}:`, err);
      captureError(err, {
        tags: { scope: "naver-imap-scheduler" },
        extra: { userId: user.id },
      });
    }
  }
}

export function startNaverImapScheduler(): void {
  // Guard the boot window too: intervalId isn't set until the first tick fires
  // ~30s in, so a second start() call before then would schedule a duplicate
  // first tick. Track the setTimeout handle so the double-start guard covers it.
  if (intervalId || firstTickTimer) return;
  // First tick after 30s so the API server can finish booting before
  // we open IMAP sockets. Subsequent ticks on the regular interval.
  firstTickTimer = setTimeout(() => {
    firstTickTimer = null;
    tickOnce().catch((err) =>
      captureError(err, { tags: { scope: "naver-imap-scheduler.first-tick" } }),
    );
    intervalId = setInterval(() => {
      tickOnce().catch((err) =>
        captureError(err, { tags: { scope: "naver-imap-scheduler.tick" } }),
      );
    }, POLL_INTERVAL_MS);
  }, 30_000);
  console.log(
    `[naver-imap-scheduler] started — first tick in 30s, then every ${POLL_INTERVAL_MS / 1000}s`,
  );
}

export function stopNaverImapScheduler(): void {
  if (firstTickTimer) {
    clearTimeout(firstTickTimer);
    firstTickTimer = null;
  }
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
