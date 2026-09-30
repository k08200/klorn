/**
 * Calendar sync into CalendarEvent rows: the window, the caps and the
 * row mapping shared by every sync site (POST /api/calendar/sync, the login
 * init-sync, the scheduler cycle). Before step C2 each site carried its own
 * copy of this; they now differ only in how they handle a failure.
 */

import { prisma } from "../db.js";
import {
  getLinkedCalendarClients,
  isGoogleAuthError,
  markLinkedCalendarForReconnect,
} from "../mail/gmail.js";
import { captureError } from "../sentry.js";
import { normalizeTimeZone } from "../time-zone.js";
import { googleSessionFromClient } from "./calendar-providers/google.js";
import type {
  CalendarListQuery,
  CalendarSession,
  ProviderCalendarEvent,
} from "./calendar-providers/types.js";
import {
  type CalendarEventFields,
  upsertGoogleEventRow,
  upsertLinkedGoogleEventRow,
} from "./calendar-rows.js";

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
}

/** One account's sync window as rows; events with no id or usable times are dropped. */
async function listSyncRows(
  session: CalendarSession,
  userTimezone: string,
  now: Date,
): Promise<SyncRow[]> {
  const events = await session.listEvents(syncQuery(now, userTimezone));
  return events.flatMap((event) => {
    const fields = syncRowFields(event);
    return fields ? [{ externalId: event.externalId, fields }] : [];
  });
}

/**
 * Sync the PRIMARY calendar's window into rows (matched by googleId). A list
 * failure throws to the caller, which owns the failure policy. Returns the
 * number of rows written.
 */
export async function syncPrimaryCalendarWindow(
  session: CalendarSession,
  userId: string,
  userTimezone: string,
  now: Date = new Date(),
): Promise<number> {
  const rows = await listSyncRows(session, userTimezone, now);
  for (const row of rows) {
    await upsertGoogleEventRow(userId, row.externalId, row.fields);
  }
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
  const rows = await listSyncRows(session, userTimezone, now);
  for (const row of rows) {
    await upsertLinkedGoogleEventRow(userId, linkedAccountId, row.externalId, row.fields);
  }
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
 * A linked account that fails is flagged (auth errors only: a transient failure
 * must not demand a re-link), logged and captured, then skipped. The flag write
 * is best-effort so a DB blip cannot hide the sync error or abort the loop.
 * Domain only goes to Sentry, never the full linked address (PII).
 */
async function reportLinkedSyncFailure(
  userId: string,
  linkedAccountId: string,
  email: string,
  err: unknown,
): Promise<void> {
  if (isGoogleAuthError(err)) {
    await markLinkedCalendarForReconnect(userId, linkedAccountId).catch((markErr) => {
      console.error(
        `[CALENDAR] Failed to flag linked calendar ${linkedAccountId} for reconnect:`,
        markErr,
      );
      captureError(markErr, { tags: { scope: "calendar.linked.mark-reconnect" } });
    });
  }
  console.warn(
    `[CALENDAR] linked-account sync failed (skipped): ${err instanceof Error ? err.message : err}`,
  );
  captureError(err, {
    tags: { scope: "calendar.linked_sync_failed" },
    extra: { userId, accountDomain: email.split("@")[1] ?? "unknown" },
  });
}

/**
 * Sync every linked GOOGLE calendar account of a user into rows. Best-effort per
 * account: one account failing never skips the others. Called only behind
 * LINKED_CALENDAR_SYNC_ENABLED; with no linked account it reads nothing else.
 */
export async function syncLinkedCalendars(
  userId: string,
  now: Date = new Date(),
): Promise<LinkedCalendarSyncResult> {
  const linked = await getLinkedCalendarClients(userId);
  if (linked.length === 0) return { accounts: 0, events: 0, failedAccounts: 0 };

  const userTimezone = await readSyncTimezone(userId);
  let events = 0;
  let failedAccounts = 0;
  for (const { client, id, email } of linked) {
    try {
      events += await syncLinkedCalendarWindow(
        googleSessionFromClient(client),
        userId,
        id,
        userTimezone,
        now,
      );
    } catch (err) {
      // The account was unlinked while its sync was in flight: its rows now fail
      // the foreign key, which is exactly the orphan the constraint prevents.
      if (isForeignKeyViolation(err)) continue;
      failedAccounts += 1;
      await reportLinkedSyncFailure(userId, id, email, err);
    }
  }
  return { accounts: linked.length, events, failedAccounts };
}
