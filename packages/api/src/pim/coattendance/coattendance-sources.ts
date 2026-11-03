/**
 * Per-source co-attendance markers: for each Google calendar a user has (the
 * primary login's UserToken, each GOOGLE LinkedCalendarAccount),
 *   - coAttendanceObservedSince: the UTC day its counting window first started,
 *     set once by the first successful pass. A reader may treat a missing
 *     ContactCoAttendance row as 0 only when every Google source has one;
 *   - coAttendanceLastPassAt: its last successful pass, the persisted interval.
 * Only a successful pass writes them; a failure backs off in memory instead
 * (coattendance-sync.ts). Re-linking or reconnecting a grant clears both
 * (routes/google-link-finish.ts); unlinking deletes the row.
 */

import { prisma } from "../../db.js";

export interface SourceState {
  readonly observedSince: Date | null;
  readonly lastPassAt: Date | null;
}

const STATE = { coAttendanceObservedSince: true, coAttendanceLastPassAt: true } as const;

function toState(row: {
  coAttendanceObservedSince: Date | null;
  coAttendanceLastPassAt: Date | null;
}): SourceState {
  return { observedSince: row.coAttendanceObservedSince, lastPassAt: row.coAttendanceLastPassAt };
}

/** The source's markers, or null when the user has no such Google source. */
export async function readSourceState(
  userId: string,
  linkedAccountId: string | null,
): Promise<SourceState | null> {
  if (linkedAccountId === null) {
    const token = await prisma.userToken.findUnique({
      where: { userId_provider: { userId, provider: "google" } },
      select: STATE,
    });
    return token ? toState(token) : null;
  }
  const linked = await prisma.linkedCalendarAccount.findFirst({
    where: { id: linkedAccountId, userId, provider: "GOOGLE" },
    select: STATE,
  });
  return linked ? toState(linked) : null;
}

/** True when the source has never passed, or its last pass is at least `intervalMs` old. */
export function isPassDue(state: SourceState, now: Date, intervalMs: number): boolean {
  return state.lastPassAt === null || now.getTime() - state.lastPassAt.getTime() >= intervalMs;
}

/** The user's GOOGLE linked calendars (not awaiting a re-link) whose pass is due. */
export async function dueLinkedSourceIds(
  userId: string,
  now: Date,
  intervalMs: number,
): Promise<Set<string>> {
  const rows = await prisma.linkedCalendarAccount.findMany({
    where: { userId, provider: "GOOGLE", needsReconnect: false },
    select: { id: true, ...STATE },
  });
  return new Set(rows.filter((row) => isPassDue(toState(row), now, intervalMs)).map((r) => r.id));
}

/**
 * Record a successful pass: the pass time, and the observed-since day if the
 * source had none. Conditional on the pass time read before the pass, so a
 * re-link that cleared the markers meanwhile is not overwritten.
 */
export async function recordPassSucceeded(
  userId: string,
  linkedAccountId: string | null,
  before: SourceState,
  windowStartDay: Date,
  now: Date,
): Promise<void> {
  const data = {
    coAttendanceLastPassAt: now,
    coAttendanceObservedSince: before.observedSince ?? windowStartDay,
  };
  const unchanged = { coAttendanceLastPassAt: before.lastPassAt };
  if (linkedAccountId === null) {
    await prisma.userToken.updateMany({
      where: { userId, provider: "google", ...unchanged },
      data,
    });
    return;
  }
  await prisma.linkedCalendarAccount.updateMany({
    where: { id: linkedAccountId, userId, provider: "GOOGLE", ...unchanged },
    data,
  });
}
