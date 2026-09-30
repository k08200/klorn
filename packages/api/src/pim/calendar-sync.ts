/**
 * Calendar sync into CalendarEvent rows: the window, the caps and the
 * row mapping shared by every sync site (POST /api/calendar/sync, the login
 * init-sync, the scheduler cycle). Before step C2 each site carried its own
 * copy of this; they now differ only in how they handle a failure.
 */

import { prisma } from "../db.js";
import { normalizeTimeZone } from "../time-zone.js";
import { connectLinkedCalendars } from "./calendar-providers/dispatch.js";
import type {
  CalendarListQuery,
  CalendarSession,
  ProviderCalendarEvent,
} from "./calendar-providers/types.js";
import {
  type CalendarEventFields,
  removeCancelledGoogleEventRows,
  upsertGoogleEventRow,
  upsertLinkedGoogleEventRow,
} from "./calendar-rows.js";
import { handleLinkedCalendarFailure } from "./linked-calendar-failure.js";

export const CALENDAR_SYNC_WINDOW_DAYS = 30;
/** Per account and per sync; identical for the primary and every linked calendar. */
export const CALENDAR_SYNC_MAX_RESULTS = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The user's stored timezone, the zone naive event times are read in. */
export async function readSyncTimezone(userId: string): Promise<string> {
  const userRow = (await prisma.user.findUnique({ where: { id: userId } })) as {
    timezone?: string | null;
  } | null;
  return normalizeTimeZone(userRow?.timezone);
}

/**
 * The listing every sync asks for: the next 30 days, in the user's zone, with
 * cancelled events so a deletion upstream can be seen (C2b).
 */
export function syncQuery(now: Date, userTimezone: string): CalendarListQuery {
  return {
    timeMin: now.toISOString(),
    timeMax: new Date(now.getTime() + CALENDAR_SYNC_WINDOW_DAYS * DAY_MS).toISOString(),
    maxResults: CALENDAR_SYNC_MAX_RESULTS,
    timeZone: userTimezone,
    includeCancelled: true,
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
}

interface SyncWindow {
  readonly rows: SyncRow[];
  /** Ids the provider reported cancelled: the rows to remove, never inferred from absence. */
  readonly cancelledIds: string[];
}

/**
 * One account's sync window: rows for the live events (those with no id or
 * usable times are dropped) and the ids of the cancelled ones. A cancelled event
 * is never written, even when the provider still sends its details.
 */
async function listSyncWindow(
  session: CalendarSession,
  userTimezone: string,
  now: Date,
): Promise<SyncWindow> {
  const events = await session.listEvents(syncQuery(now, userTimezone));
  const rows: SyncRow[] = [];
  const cancelledIds: string[] = [];
  for (const event of events) {
    if (event.cancelled) {
      if (event.externalId) cancelledIds.push(event.externalId);
      continue;
    }
    const fields = syncRowFields(event);
    if (fields) rows.push({ externalId: event.externalId, fields });
  }
  return { rows, cancelledIds };
}

/**
 * Sync the PRIMARY calendar's window into rows (matched by googleId) and remove
 * the rows of events cancelled upstream. A list failure throws to the caller,
 * which owns the failure policy. Returns the number of rows written.
 */
export async function syncPrimaryCalendarWindow(
  session: CalendarSession,
  userId: string,
  userTimezone: string,
  now: Date = new Date(),
): Promise<number> {
  const { rows, cancelledIds } = await listSyncWindow(session, userTimezone, now);
  for (const row of rows) {
    await upsertGoogleEventRow(userId, row.externalId, row.fields);
  }
  await removeCancelledGoogleEventRows(userId, null, cancelledIds, now);
  return rows.length;
}

/** Sync one LINKED calendar's window into rows tagged with that account. */
export async function syncLinkedCalendarWindow(
  session: CalendarSession,
  userId: string,
  linkedAccountId: string,
  userTimezone: string,
  now: Date = new Date(),
): Promise<number> {
  const { rows, cancelledIds } = await listSyncWindow(session, userTimezone, now);
  for (const row of rows) {
    await upsertLinkedGoogleEventRow(userId, linkedAccountId, row.externalId, row.fields);
  }
  await removeCancelledGoogleEventRows(userId, linkedAccountId, cancelledIds, now);
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
      });
    }
  }
  return { accounts: linked.length, events, failedAccounts };
}
