/**
 * The KakaoTalk import scheduler (docs/providers/kakaotalk-import.md §4, §5):
 * every 30 s, under the "kakao-import" row lease so only one instance works at
 * a time.
 *
 * - The retention purge runs at most every 10 minutes and runs even while
 *   KAKAO_IMPORT_ENABLED is off: switching the flag off must not stop stored
 *   chat text from expiring. The orphan sweep (commitments of deleted
 *   imports, commitments.ts) runs with it, on the same terms.
 * - While the flag is on, each tick also processes one waiting import
 *   (process.ts), which itself stands down under BACKGROUND_AGENTS_DISABLED.
 * - While the flag is off, ticks between purges touch no database at all.
 */

import { kakaoImportLive } from "../config.js";
import { recordSchedulerTick, registerScheduler } from "../scheduler-heartbeat.js";
import { createSchedulerLease } from "../scheduler-lease.js";
import { captureError } from "../sentry.js";
import { newWork } from "../work-context.js";
import { sweepOrphanKakaoCommitments } from "./commitments.js";
import { processNextKakaoImport } from "./process.js";
import { purgeExpiredKakaoImportText } from "./purge.js";

export const KAKAO_SCHEDULER_INTERVAL_MS = 30_000;
export const KAKAO_PURGE_INTERVAL_MS = 10 * 60_000;
const LOG_PREFIX = "[KAKAO]";

const kakaoLease = createSchedulerLease({ name: "kakao-import", logPrefix: LOG_PREFIX });
let lastPurgeAt = 0;

/** Test seam: forget when the last purge ran. */
export function resetKakaoSchedulerState(): void {
  lastPurgeAt = 0;
}

/** One tick's work, run under the lease. */
export async function runKakaoWork(now: Date = new Date()): Promise<void> {
  if (now.getTime() - lastPurgeAt >= KAKAO_PURGE_INTERVAL_MS) {
    // Stamped before the attempt: a failing purge is retried after the
    // interval, not hammered every tick.
    lastPurgeAt = now.getTime();
    const purged = await purgeExpiredKakaoImportText(now);
    if (purged.messages > 0 || purged.expired > 0) {
      console.log(
        `${LOG_PREFIX} retention: deleted ${purged.messages} messages, expired ${purged.expired} imports`,
      );
    }
    const swept = await sweepOrphanKakaoCommitments();
    if (swept.commitments > 0) {
      console.log(
        `${LOG_PREFIX} orphan sweep: deleted ${swept.commitments} commitments of ${swept.imports} deleted imports`,
      );
    }
  }
  if (kakaoImportLive()) await processNextKakaoImport(now);
}

export async function kakaoSchedulerTick(
  now: Date = new Date(),
  lease: { runExclusive(work: () => Promise<void>): Promise<boolean> } = kakaoLease,
): Promise<void> {
  try {
    const purgeDue = now.getTime() - lastPurgeAt >= KAKAO_PURGE_INTERVAL_MS;
    if (kakaoImportLive() || purgeDue) await lease.runExclusive(() => runKakaoWork(now));
    recordSchedulerTick("kakao-import");
  } catch (err) {
    console.error(`${LOG_PREFIX} tick failed:`, err);
    captureError(err, { tags: { scope: "kakao-import.scheduler" } });
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startKakaoImportScheduler(): void {
  if (intervalId) return;
  registerScheduler("kakao-import", KAKAO_SCHEDULER_INTERVAL_MS);
  intervalId = setInterval(
    newWork(() => {
      void kakaoSchedulerTick();
    }),
    KAKAO_SCHEDULER_INTERVAL_MS,
  );
  intervalId.unref?.();
}

export function stopKakaoImportScheduler(): void {
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
}
