/**
 * Removing events that were deleted or cancelled upstream (step C2b of
 * docs/providers/unified-platform-plan.md). After a sync has upserted the live
 * window, and only while CALENDAR_CANCELLATION_SYNC_ENABLED is on, the provider is
 * asked in a call of its own which events were cancelled since the last scan;
 * their rows go, and so do the attention items mirrored from them (resolved, not
 * deleted: the less destructive choice).
 *
 * Nothing here may fail a sync: the live events are already written, so a failing
 * scan is logged once and the next sync tries again from where the last complete
 * (or truncated, see below) scan stopped. A non-transient failure is reported to
 * Sentry once per process, so an outage cannot raise one event per account per
 * sync cycle.
 *
 * Known limits (documented in the plan): "this and following" deletions truncate
 * the series' recurrence and leave no tombstone for the instances, and a row can be
 * removed and re-created if the event is restored between a scan's read and its
 * removal. Nothing is ever removed because it is absent from a listing.
 */

import { calendarCancellationSyncEnabled } from "../config.js";
import { INTERACTIVE_TX_OPTIONS, prisma } from "../db.js";
import { captureError } from "../sentry.js";
import type { CalendarSession, CancelledEventsResult } from "./calendar-providers/types.js";
import { googleSourceScope, sourceKeyFor } from "./calendar-rows.js";

/** How far back the first scan of an account looks, and the most any scan ever does. */
export const CANCELLED_LOOKBACK_DAYS = 7;
/** A complete scan resumes this much before it began, so a clock skew or a slow commit loses nothing. */
export const CANCELLED_SCAN_MARGIN_MS = 30 * 60 * 1000;
/**
 * A scan cut off by the page cap resumes this much before the last `updated` it
 * read. Google does not document whether `updatedMin` is inclusive, so a group of
 * events sharing that `updated` that the cut split is read again; removals are
 * idempotent.
 */
export const CANCELLED_RESUME_OVERLAP_MS = 1000;
/** Accounts whose scan progress and warnings are remembered; the least recently scanned is forgotten. */
export const CANCELLED_SCAN_STATE_CAP = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Where each account's next scan starts (epoch ms), per process. Not persisted:
 * after a restart an account falls back to the lookback, which only costs a
 * larger (still bounded, still paged) first scan.
 */
const resumeFrom = new Map<string, number>();
/** What was already logged for an account, by kind, so one trouble never hides another. */
type Trouble = "failure" | "truncation" | "stalled";
const warned = new Set<string>();
let reportedNonTransient = false;

/** Test hook: forget every scan position, every logged warning and the Sentry report. */
export function _resetCancelledScanStateForTests(): void {
  resumeFrom.clear();
  warned.clear();
  reportedNonTransient = false;
}

/** Insert as the most recent entry of a bounded collection, forgetting the oldest past the cap. */
function remember<T>(collection: Map<string, T> | Set<string>, key: string, value?: T): void {
  collection.delete(key);
  if (collection instanceof Map) collection.set(key, value as T);
  else collection.add(key);
  if (collection.size > CANCELLED_SCAN_STATE_CAP) {
    const oldest = collection.keys().next();
    if (!oldest.done) collection.delete(oldest.value);
  }
}

/**
 * The later of (now - lookback) and where this account's last scan left off:
 * small and cheap in steady state, never wider than the lookback after a gap.
 */
export function cancelledScanUpdatedMin(key: string, now: Date): Date {
  const floor = now.getTime() - CANCELLED_LOOKBACK_DAYS * DAY_MS;
  const stored = resumeFrom.get(key);
  return new Date(stored === undefined ? floor : Math.max(floor, stored));
}

function warnOnce(trouble: Trouble, key: string, message: string): void {
  const entry = `${trouble}:${key}`;
  if (warned.has(entry)) return;
  remember(warned, entry);
  console.warn(message);
}

/** The account is fine again for these kinds of trouble: the next one is worth a line. */
function recovered(key: string, ...troubles: Trouble[]): void {
  for (const trouble of troubles) warned.delete(`${trouble}:${key}`);
}

/** The basic-ISO UTC start of a timed instance, or the date of an all-day one. */
const INSTANCE_START = /^\d{8}(?:T\d{6}Z?)?$/;

/**
 * The series id of an instance id (`<seriesId>_<start>`), read off the LAST
 * separator so a series id that itself holds an underscore still parses; null for
 * anything that does not end in an instance start. Google documents base32hex
 * (a-v, 0-9, no underscore) only for ids a client supplies, and the instance form
 * itself is observed behaviour, so this is a strict match, never a bare prefix.
 */
function seriesIdOfInstance(id: string): string | null {
  const separator = id.lastIndexOf("_");
  if (separator <= 0 || !INSTANCE_START.test(id.slice(separator + 1))) return null;
  return id.slice(0, separator);
}

export interface CancelledRemoval {
  readonly removed: number;
  readonly resolved: number;
}

/**
 * Remove the rows of events a scan reported cancelled, and resolve the attention
 * items mirrored from them, in ONE transaction. Only what the scan named is
 * touched, never a row merely absent from a listing. The match is the row's whole
 * identity: this user, GOOGLE, the source calendar (`linkedAccountId` null is the
 * primary) and the event id, so another account's row with the same id, another
 * user's, and LOCAL rows (no externalId) are never reached. A cancelled series
 * (`seriesIds`) also takes its instance rows, `<seriesId>_<start>`. A PRIMARY row
 * the previous release wrote during the C1 deploy overlap has no externalId yet (the
 * next upsert would stamp it), so it is matched by its googleId; a linked row never
 * has one. The database filter only narrows the candidates; the match is decided in
 * code. Items the user already dismissed keep their outcome.
 */
export async function removeCancelledGoogleEventRows(
  userId: string,
  linkedAccountId: string | null,
  scan: Pick<CancelledEventsResult, "externalIds" | "seriesIds">,
  now: Date,
): Promise<CancelledRemoval> {
  const ids = [...new Set(scan.externalIds.filter(Boolean))];
  if (ids.length === 0) return { removed: 0, resolved: 0 };
  const series = new Set(scan.seriesIds.filter(Boolean));
  const exact = new Set(ids);
  const primary = linkedAccountId === null;
  const named = (key: string | null): boolean => {
    if (!key) return false;
    if (exact.has(key)) return true;
    const parent = seriesIdOfInstance(key);
    return parent !== null && series.has(parent);
  };
  const prefixes = [...series].map((id) => `${id}_`);

  return prisma.$transaction(async (tx) => {
    const candidates = await tx.calendarEvent.findMany({
      where: {
        ...googleSourceScope(userId, linkedAccountId),
        OR: [
          { externalId: { in: ids } },
          ...prefixes.map((prefix) => ({ externalId: { startsWith: prefix } })),
          ...(primary
            ? [
                { externalId: null, googleId: { in: ids } },
                ...prefixes.map((prefix) => ({
                  externalId: null,
                  googleId: { startsWith: prefix },
                })),
              ]
            : []),
        ],
      },
      select: { id: true, externalId: true, googleId: true },
    });
    const rowIds = candidates
      .filter((row) => named(primary ? (row.externalId ?? row.googleId) : row.externalId))
      .map((row) => row.id);
    if (rowIds.length === 0) return { removed: 0, resolved: 0 };

    const resolved = await tx.attentionItem.updateMany({
      where: {
        userId,
        source: "CALENDAR_EVENT",
        sourceId: { in: rowIds },
        status: { in: ["OPEN", "SNOOZED"] },
      },
      data: { status: "RESOLVED", resolvedAt: now },
    });
    const removed = await tx.calendarEvent.deleteMany({ where: { userId, id: { in: rowIds } } });
    return { removed: removed.count, resolved: resolved.count };
  }, INTERACTIVE_TX_OPTIONS);
}

/**
 * Where the next scan starts. After a complete scan: a margin before it. After a
 * truncated one: 1 s before the last `updated` it read, so a tie group the cut
 * split is read again (see CANCELLED_RESUME_OVERLAP_MS). If that does not move
 * forward (more than one cap's worth of events share the window, so the same pages
 * would be read forever), step 1 ms past the stuck point and warn once: the events
 * tied at that point beyond the cap are missed, which is accepted and recorded in
 * the plan as a limit to check during the live verification.
 */
function advance(key: string, scan: CancelledEventsResult, startedFrom: Date, now: Date): void {
  recovered(key, "failure");
  if (!scan.truncated) {
    remember(resumeFrom, key, now.getTime() - CANCELLED_SCAN_MARGIN_MS);
    recovered(key, "truncation", "stalled");
    return;
  }
  const stopped = scan.resumeUpdatedMin === null ? Number.NaN : Date.parse(scan.resumeUpdatedMin);
  if (!Number.isFinite(stopped)) {
    warnOnce(
      "stalled",
      key,
      `[CALENDAR] cancelled-event scan truncated for ${key} and made no progress: nothing to resume from, the rest is not removed yet`,
    );
    return;
  }
  const resume = stopped - CANCELLED_RESUME_OVERLAP_MS;
  if (resume > startedFrom.getTime()) {
    remember(resumeFrom, key, resume);
    recovered(key, "stalled");
    warnOnce(
      "truncation",
      key,
      `[CALENDAR] cancelled-event scan truncated for ${key}: more changes than one scan reads, continuing from ${new Date(resume).toISOString()} on the next sync`,
    );
    return;
  }
  remember(resumeFrom, key, Math.max(stopped, startedFrom.getTime()) + 1);
  warnOnce(
    "stalled",
    key,
    `[CALENDAR] cancelled-event scan truncated for ${key} and made no progress: more changes share one timestamp than a scan reads, stepping past ${scan.resumeUpdatedMin}; events tied there beyond the cap are missed`,
  );
}

function httpStatusOf(err: unknown): number | undefined {
  const e = err as { response?: { status?: unknown }; code?: unknown } | null;
  const status = e?.response?.status ?? e?.code;
  return typeof status === "number" ? status : undefined;
}

/** A client error that retrying will not fix: Google refused the request (429 is a wait, not a refusal). */
function isNonTransient(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500 && status !== 429;
}

function reportFailure(key: string, err: unknown): void {
  const status = httpStatusOf(err);
  if (isNonTransient(status) && !reportedNonTransient) {
    reportedNonTransient = true;
    captureError(err, { tags: { scope: "calendar.cancelled_scan" }, extra: { status } });
  }
  const reason = err instanceof Error ? err.message : String(err);
  warnOnce(
    "failure",
    key,
    `[CALENDAR] cancelled-event scan failed for ${key}, events deleted upstream stay until it succeeds: ${reason}`,
  );
}

/**
 * Scan one account for cancelled events and remove their rows. `linkedAccountId`
 * null is the primary calendar. A no-op while the flag is off (read here, at sync
 * time) or when the provider has no cancellation call. Never throws.
 */
export async function reconcileCancelledEvents(
  session: CalendarSession,
  userId: string,
  linkedAccountId: string | null,
  now: Date,
): Promise<void> {
  if (!calendarCancellationSyncEnabled()) return;
  if (!session.listCancelledEvents) return;
  const key = `${userId}:${sourceKeyFor(linkedAccountId)}`;
  try {
    const startedFrom = cancelledScanUpdatedMin(key, now);
    const scan = await session.listCancelledEvents({ updatedMin: startedFrom.toISOString() });
    const removal = await removeCancelledGoogleEventRows(userId, linkedAccountId, scan, now);
    if (removal.removed > 0) {
      console.log(
        `[CALENDAR] cancelled events removed ${key} rows=${removal.removed} attentionResolved=${removal.resolved}`,
      );
    }
    advance(key, scan, startedFrom, now);
  } catch (err) {
    reportFailure(key, err);
  }
}
