/**
 * GitHub notifications polling scheduler.
 *
 * Mirrors naver-imap-scheduler: every POLL_INTERVAL_MS, walk every User
 * with a connected GitHub token and run syncGitHubForUser. Per-user errors
 * never block the others. Polling (not webhooks) so self-hosters behind
 * NAT need no public endpoint — the same trade-off the Naver poller makes.
 */

import { prisma } from "./db.js";
import { syncGitHubForUser } from "./github-source.js";
import { captureError } from "./sentry.js";

let intervalId: ReturnType<typeof setInterval> | null = null;
let firstTickTimer: ReturnType<typeof setTimeout> | null = null;
const POLL_INTERVAL_MS = 5 * 60_000; // 5 minutes — GitHub asks pollers to honor ≥60s

async function tickOnce(): Promise<void> {
  const users = (await prisma.user.findMany({
    where: { githubTokenCipher: { not: null } },
    select: { id: true },
  })) as Array<{ id: string }>;
  if (users.length === 0) return;

  for (const user of users) {
    try {
      const result = await syncGitHubForUser(user.id);
      if (result && result.fetched > 0) {
        console.log(`[github] ${user.id}: fetched=${result.fetched} surfaced=${result.surfaced}`);
      }
    } catch (err) {
      // Terminal handler for the per-user GitHub sync — console first so a
      // failure is visible without a Sentry DSN (self-host / dev), matching
      // naver-imap-scheduler. Without this, a broken token or API change
      // silently stalls that user's GitHub notifications with no trace.
      console.warn(`[github-scheduler] sync failed for user ${user.id}:`, err);
      captureError(err, { tags: { scope: "github-scheduler" }, extra: { userId: user.id } });
    }
  }
}

export function startGitHubScheduler(): void {
  // Guard the 30s boot window too: intervalId isn't set until the first tick
  // fires, so a second start() before then would schedule a duplicate tick.
  if (intervalId || firstTickTimer) return;
  firstTickTimer = setTimeout(() => {
    firstTickTimer = null;
    tickOnce().catch((err) =>
      captureError(err, { tags: { scope: "github-scheduler.first-tick" } }),
    );
    intervalId = setInterval(() => {
      tickOnce().catch((err) => captureError(err, { tags: { scope: "github-scheduler.tick" } }));
    }, POLL_INTERVAL_MS);
  }, 30_000);
  console.log(
    `[github-scheduler] started — first tick in 30s, then every ${POLL_INTERVAL_MS / 1000}s`,
  );
}

export function stopGitHubScheduler(): void {
  if (firstTickTimer) {
    clearTimeout(firstTickTimer);
    firstTickTimer = null;
  }
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
