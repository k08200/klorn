/**
 * The scheduler's co-attendance queue. The scheduler queues a user after their
 * calendar step and does not wait (automation-scheduler.ts), so the pass
 * (coattendance-sync.ts) runs outside the user's per-tick budget. The queue runs
 * one user at a time, so a flag flip that makes every user's first pass due at
 * once does not crowd the database pool, and a user already queued is not queued
 * twice. Each source's listing is bounded inside the pass. Never throws.
 */

import { calendarCoattendanceEnabled } from "../../config.js";
import { type CoAttendanceOptions, runCoAttendancePass } from "./coattendance-sync.js";

let queue: Promise<void> = Promise.resolve();
const queued = new Set<string>();

/** Queue a user's pass behind the others and return at once. Flag off: nothing. */
export function enqueueCoAttendance(userId: string, options: CoAttendanceOptions): void {
  if (!calendarCoattendanceEnabled() || queued.has(userId)) return;
  queued.add(userId);
  queue = queue
    .then(async () => {
      try {
        await runCoAttendancePass(userId, options);
      } finally {
        queued.delete(userId);
      }
    })
    // Never reached (the pass never throws), but one rejection must not stop the queue.
    .catch(() => undefined);
}

export function _drainCoAttendanceQueueForTests(): Promise<void> {
  return queue;
}
