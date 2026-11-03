/**
 * The scheduler's co-attendance job: runs the pass (coattendance-sync.ts) for each
 * of a user's Google calendar sources whose interval has passed, outside the
 * user's per-tick budget. The scheduler queues it after the user's calendar step
 * and does not wait (automation-scheduler.ts); the queue runs one user at a time,
 * so a flag flip that makes every user's first pass due at once does not crowd
 * the database pool, and a user already queued is not queued twice. Each pass is
 * bounded by COATTENDANCE_PASS_TIMEOUT_MS, so a hung one does not hold the rest;
 * it keeps running in the background and its own in-flight guard stops an
 * overlap. Never throws.
 *
 * Sources are read before connecting, so a source whose interval has not passed
 * costs one row read and no token work.
 */

import { calendarCoattendanceEnabled } from "../../config.js";
import { captureError } from "../../sentry.js";
import { withTimeout } from "../../with-timeout.js";
import { connectLinkedCalendars, connectPrimaryCalendar } from "../calendar-providers/dispatch.js";
import { dueLinkedSourceIds, isPassDue, readSourceState } from "./coattendance-sources.js";
import { COATTENDANCE_PASS_INTERVAL_MS, countCoAttendance } from "./coattendance-sync.js";

/** One source's pass; the Google listing alone may take 4 pages of 10 s. */
export const COATTENDANCE_PASS_TIMEOUT_MS = 120_000;

export interface CoAttendanceJobOptions {
  /** Linked calendars too: LINKED_CALENDAR_SYNC_ENABLED and the user's entitlement. */
  readonly includeLinked: boolean;
}

let queue: Promise<void> = Promise.resolve();
const queued = new Set<string>();

function bounded(work: Promise<unknown>, timeoutMs: number, label: string): Promise<unknown> {
  return withTimeout(work, timeoutMs, label).catch(() => undefined);
}

async function runPrimary(userId: string, now: Date, timeoutMs: number): Promise<void> {
  const state = await readSourceState(userId, null);
  if (!state || !isPassDue(state, now, COATTENDANCE_PASS_INTERVAL_MS)) return;
  const session = await connectPrimaryCalendar(userId);
  if (!session) return;
  await bounded(countCoAttendance(session, userId, null, now), timeoutMs, "coattendance.primary");
}

async function runLinked(userId: string, now: Date, timeoutMs: number): Promise<void> {
  const due = await dueLinkedSourceIds(userId, now, COATTENDANCE_PASS_INTERVAL_MS);
  if (due.size === 0) return;
  const linked = await connectLinkedCalendars(userId, { skipNeedsReconnect: true });
  for (const { id, session } of linked) {
    if (!due.has(id) || session.provider !== "GOOGLE") continue;
    await bounded(countCoAttendance(session, userId, id, now), timeoutMs, "coattendance.linked");
  }
}

/** Every due Google calendar source of one user, one after another. Never throws. */
export async function runCoAttendanceForUser(
  userId: string,
  options: CoAttendanceJobOptions,
  now: Date = new Date(),
  limits: { readonly passTimeoutMs?: number } = {},
): Promise<void> {
  if (!calendarCoattendanceEnabled()) return;
  const timeoutMs = limits.passTimeoutMs ?? COATTENDANCE_PASS_TIMEOUT_MS;
  for (const run of [runPrimary, ...(options.includeLinked ? [runLinked] : [])]) {
    try {
      await run(userId, now, timeoutMs);
    } catch (err) {
      // A connect or source read failed; the next tick tries again.
      const name = err instanceof Error ? err.name : typeof err;
      console.warn(`[CALENDAR] co-attendance job step failed for ${userId}: ${name}`);
      captureError(new Error(`calendar co-attendance job step failed: ${name}`), {
        tags: { scope: "calendar.coattendance" },
        extra: { userId },
      });
    }
  }
}

/** Queue a user's job behind the others and return at once. Flag off: nothing. */
export function enqueueCoAttendance(userId: string, options: CoAttendanceJobOptions): void {
  if (!calendarCoattendanceEnabled() || queued.has(userId)) return;
  queued.add(userId);
  queue = queue
    .then(async () => {
      try {
        await runCoAttendanceForUser(userId, options);
      } finally {
        queued.delete(userId);
      }
    })
    // Never reached (the job never throws), but one rejection must not stop the queue.
    .catch(() => undefined);
}

export function _drainCoAttendanceQueueForTests(): Promise<void> {
  return queue;
}
