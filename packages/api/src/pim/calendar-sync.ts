/**
 * Calendar sync into CalendarEvent rows: the window, the caps and the
 * row mapping shared by every sync site (POST /api/calendar/sync, the login
 * init-sync, the scheduler cycle). Before step C2 each site carried its own
 * copy of this; they now differ only in how they handle a failure.
 */

import { calendarHideDeclinedEnabled } from "../config.js";
import { captureError } from "../sentry.js";
import { getUserTimeZone } from "../user-timezone.js";
import {
  reconcileCancelledEvents,
  removeCancelledGoogleEventRows,
} from "./calendar-cancellation.js";
import { connectLinkedCalendars } from "./calendar-providers/dispatch.js";
import type {
  CalendarListQuery,
  CalendarSession,
  ProviderCalendarEvent,
} from "./calendar-providers/types.js";
import {
  type CalendarEventFields,
  upsertGoogleEventRow,
  upsertLinkedEventRow,
} from "./calendar-rows.js";
import { removeRowsMissingFromWindow } from "./calendar-window-reconcile.js";
import { handleLinkedCalendarFailure } from "./linked-calendar-failure.js";

export const CALENDAR_SYNC_WINDOW_DAYS = 30;
/** Per account and per sync; identical for the primary and every linked calendar. */
export const CALENDAR_SYNC_MAX_RESULTS = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The user's configured timezone (AutomationConfig), the zone naive event times
 * are read in. User has no timezone column: reading it there gave every sync the
 * default zone.
 */
export function readSyncTimezone(userId: string): Promise<string> {
  return getUserTimeZone(userId);
}

/** The listing every sync asks for: the next 30 days, in the user's zone. */
export function syncQuery(now: Date, userTimezone: string): CalendarListQuery {
  return {
    timeMin: now.toISOString(),
    timeMax: new Date(now.getTime() + CALENDAR_SYNC_WINDOW_DAYS * DAY_MS).toISOString(),
    maxResults: CALENDAR_SYNC_MAX_RESULTS,
    timeZone: userTimezone,
  };
}

/** The row fields of a synced event, or null when it has no id or no usable times. */
export function syncRowFields(event: ProviderCalendarEvent): CalendarEventFields | null {
  if (!event.externalId || !event.start || !event.end) return null;
  if (!event.startTime || !event.endTime) return null;
  return {
    title: event.summary || "Untitled",
    description: event.description,
    startTime: event.startTime,
    endTime: event.endTime,
    location: event.location,
    meetingLink: event.meetingLink,
    allDay: event.allDay,
  };
}

interface SyncRow {
  readonly externalId: string;
  readonly fields: CalendarEventFields;
  /** CalDAV only: the calendar of the account that listed it. */
  readonly calendarKey?: string;
}

/** Events as rows; events with no id or usable times are dropped. */
function toSyncRows(events: readonly ProviderCalendarEvent[]): SyncRow[] {
  return events.flatMap((event) => {
    const fields = syncRowFields(event);
    return fields ? [{ externalId: event.externalId, fields, calendarKey: event.calendarKey }] : [];
  });
}

interface SplitEvents {
  readonly kept: readonly ProviderCalendarEvent[];
  /** Ids of the Google invitations the user declined, when CALENDAR_HIDE_DECLINED_ENABLED is on. */
  readonly declined: readonly string[];
}

/** Behind CALENDAR_HIDE_DECLINED_ENABLED, a Google invitation the user declined is no row. */
function splitDeclined(
  session: CalendarSession,
  events: readonly ProviderCalendarEvent[],
): SplitEvents {
  if (session.provider !== "GOOGLE" || !calendarHideDeclinedEnabled()) {
    return { kept: events, declined: [] };
  }
  return {
    kept: events.filter((event) => event.declinedBySelf !== true),
    declined: events
      .filter((event) => event.declinedBySelf === true && event.externalId)
      .map((event) => event.externalId),
  };
}

/**
 * Remove the rows an earlier sync wrote for invitations the user has since declined,
 * through C2b's removal (this account's rows only, attention items resolved, one
 * transaction). Like the cancellation scan it never fails the sync: the live rows
 * are already written, and the next sync tries again.
 */
async function removeDeclinedRows(
  userId: string,
  linkedAccountId: string | null,
  ids: readonly string[],
  now: Date,
): Promise<void> {
  if (ids.length === 0) return;
  try {
    const { removed, resolved } = await removeCancelledGoogleEventRows(
      userId,
      linkedAccountId,
      { externalIds: [...ids], seriesIds: [] },
      now,
    );
    if (removed > 0) {
      console.log(
        `[CALENDAR] declined invitations removed ${userId}:${linkedAccountId ?? "primary"} rows=${removed} attentionResolved=${resolved}`,
      );
    }
  } catch (err) {
    console.warn(
      "[CALENDAR] declined-invitation removal failed:",
      err instanceof Error ? err.message : String(err),
    );
    captureError(err, {
      tags: { scope: "calendar.declined_removal" },
      extra: { userId, linkedAccountId },
    });
  }
}

/**
 * Sync the PRIMARY calendar's window into rows (matched by googleId), then, behind
 * CALENDAR_CANCELLATION_SYNC_ENABLED, remove the rows of events cancelled upstream
 * (a separate call that can never fail the sync, see calendar-cancellation.ts). A
 * list failure throws to the caller, which owns the failure policy. Returns the
 * number of rows written.
 */
export async function syncPrimaryCalendarWindow(
  session: CalendarSession,
  userId: string,
  userTimezone: string,
  now: Date = new Date(),
): Promise<number> {
  const { kept, declined } = splitDeclined(
    session,
    await session.listEvents(syncQuery(now, userTimezone)),
  );
  const rows = toSyncRows(kept);
  for (const row of rows) {
    await upsertGoogleEventRow(userId, row.externalId, row.fields);
  }
  await removeDeclinedRows(userId, null, declined, now);
  await reconcileCancelledEvents(session, userId, null, now);
  return rows.length;
}

/**
 * Sync one LINKED calendar's window into rows tagged with that account and with
 * the provider of the session that listed them (GOOGLE, OUTLOOK in C4, ICLOUD or
 * NAVER in C3). A session that can say its listing is complete (CalDAV, C3) is
 * listed through `listWindow`, and after the upsert the window's rows it no longer
 * has are removed (calendar-window-reconcile.ts, which owns the guard); every other
 * session is listed exactly as before and nothing is removed for being absent.
 */
export async function syncLinkedCalendarWindow(
  session: CalendarSession,
  userId: string,
  linkedAccountId: string,
  userTimezone: string,
  now: Date = new Date(),
): Promise<number> {
  const query = syncQuery(now, userTimezone);
  const listing = session.listWindow ? await session.listWindow(query) : null;
  const { kept, declined } = splitDeclined(
    session,
    listing ? listing.events : await session.listEvents(query),
  );
  const rows = toSyncRows(kept);
  for (const row of rows) {
    await upsertLinkedEventRow(
      session.provider,
      userId,
      linkedAccountId,
      row.externalId,
      row.fields,
      row.calendarKey,
    );
  }
  await removeDeclinedRows(userId, linkedAccountId, declined, now);
  if (listing) {
    await removeRowsMissingFromWindow(session.provider, userId, linkedAccountId, listing, now);
  }
  await reconcileCancelledEvents(session, userId, linkedAccountId, now);
  return rows.length;
}

export interface LinkedCalendarSyncResult {
  readonly accounts: number;
  readonly events: number;
  readonly failedAccounts: number;
}

function isForeignKeyViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === "P2003";
}

/**
 * Sync every linked calendar account of a user into rows. Accounts come from the
 * provider seam, so a provider with no implementation yet is skipped, and so is
 * an account flagged needsReconnect: a revoked token is not retried every cycle
 * until the user re-links it. Best-effort per account: one failing never skips
 * the others (see linked-calendar-failure.ts for the policy). Called only behind
 * LINKED_CALENDAR_SYNC_ENABLED and the user's entitlement; with nothing to sync it
 * reads no user row.
 */
export async function syncLinkedCalendars(
  userId: string,
  now: Date = new Date(),
): Promise<LinkedCalendarSyncResult> {
  const linked = await connectLinkedCalendars(userId, { skipNeedsReconnect: true });
  if (linked.length === 0) return { accounts: 0, events: 0, failedAccounts: 0 };

  const userTimezone = await readSyncTimezone(userId);
  let events = 0;
  let failedAccounts = 0;
  for (const { session, id, email } of linked) {
    try {
      events += await syncLinkedCalendarWindow(session, userId, id, userTimezone, now);
    } catch (err) {
      // The account was unlinked while its sync was in flight: its rows now fail
      // the foreign key, which is exactly the orphan the constraint prevents.
      if (isForeignKeyViolation(err)) continue;
      failedAccounts += 1;
      await handleLinkedCalendarFailure({
        userId,
        linkedAccountId: id,
        email,
        err,
        scope: "calendar.linked_sync_failed",
        action: "sync",
        provider: session.provider,
      });
    }
  }
  return { accounts: linked.length, events, failedAccounts };
}
