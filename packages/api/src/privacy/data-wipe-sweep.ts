/**
 * Finishes data wipes whose purge did not commit (privacy/data-wipe-fence.ts).
 *
 * `purgeAllUserData` records the wipe and cuts off access before it purges. If
 * the purge then fails (a timeout, a pool error, the process stopping), the
 * record stays pending: the fence keeps rejecting the account's inserts, and
 * this sweep retries the purge until it commits. A wipe younger than
 * PENDING_GRACE_MS is left to the request that is still running it.
 */

import { prisma } from "../db.js";
import { recordSchedulerTick, registerScheduler } from "../scheduler-heartbeat.js";
import { captureError } from "../sentry.js";
import { finishDataWipe } from "../user-deletion.js";
import { newWork } from "../work-context.js";

export const DATA_WIPE_SWEEP_INTERVAL_MS = 10 * 60_000;
const PENDING_GRACE_MS = 2 * 60_000;
/** A wipe pending this long is reported as stuck on every sweep until it ends. */
const STUCK_AFTER_MS = 30 * 60_000;
const FIRST_SWEEP_DELAY_MS = 60_000;
const SWEEP_BATCH = 20;

export async function runDataWipeSweep(
  now = new Date(),
): Promise<{ finished: number; failed: number }> {
  // Fewest attempts first, so a wipe that keeps failing cannot starve the rest.
  const pending = await prisma.dataWipe.findMany({
    where: { purgedAt: null, requestedAt: { lt: new Date(now.getTime() - PENDING_GRACE_MS) } },
    select: { userId: true, requestedAt: true },
    orderBy: [{ attempts: "asc" }, { requestedAt: "asc" }],
    take: SWEEP_BATCH,
  });
  let finished = 0;
  let failed = 0;
  for (const { userId, requestedAt } of pending) {
    try {
      if ((await finishDataWipe(userId)) === "purged") finished++;
    } catch (err) {
      failed++;
      console.error(`[DATA-WIPE] Sweep could not finish the wipe of ${userId}:`, err);
      captureError(err, { tags: { scope: "data-wipe.sweep", userId } });
      await prisma.dataWipe
        .update({ where: { userId }, data: { attempts: { increment: 1 } } })
        .catch((countErr: unknown) => {
          console.error(`[DATA-WIPE] Could not count the failed attempt for ${userId}:`, countErr);
        });
      if (now.getTime() - requestedAt.getTime() > STUCK_AFTER_MS) {
        const stuck = new Error("data wipe pending for over 30 minutes");
        console.error(
          `[DATA-WIPE] Wipe of ${userId} is stuck (pending since ${requestedAt.toISOString()}).`,
        );
        captureError(stuck, { tags: { scope: "data-wipe.stuck", userId } });
      }
    }
  }
  return { finished, failed };
}

async function tick(): Promise<void> {
  try {
    await runDataWipeSweep();
    recordSchedulerTick("data-wipe");
  } catch (err) {
    console.error("[DATA-WIPE] Sweep failed:", err);
    captureError(err, { tags: { scope: "data-wipe.sweep" } });
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null;
let firstRunTimer: ReturnType<typeof setTimeout> | null = null;

export function startDataWipeSweep(): void {
  if (intervalId || firstRunTimer) return;
  registerScheduler("data-wipe", DATA_WIPE_SWEEP_INTERVAL_MS);
  firstRunTimer = setTimeout(
    newWork(() => {
      firstRunTimer = null;
      void tick();
      intervalId = setInterval(newWork(tick), DATA_WIPE_SWEEP_INTERVAL_MS);
      intervalId.unref?.();
    }),
    FIRST_SWEEP_DELAY_MS,
  );
  firstRunTimer.unref?.();
}

export function stopDataWipeSweep(): void {
  if (firstRunTimer) {
    clearTimeout(firstRunTimer);
    firstRunTimer = null;
  }
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
