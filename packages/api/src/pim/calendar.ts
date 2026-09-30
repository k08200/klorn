import { unifiedCalendarReadEnabled } from "../config.js";
import { prisma } from "../db.js";
import { type BusyConflict, toAbsoluteInstant } from "../google-calendar-time.js";
import { isGoogleAuthError, markGoogleTokenForReconnect } from "../mail/gmail.js";
import { normalizeTimeZone } from "../time-zone.js";
import { wrapUntrusted } from "../untrusted.js";
import { connectLinkedCalendars, connectPrimaryCalendar } from "./calendar-providers/dispatch.js";
import { readOverlappingTimedEvents, readUpcomingEvents } from "./calendar-read.js";
import { mergeConflicts, toRowConflict, toToolEvent } from "./calendar-read-format.js";
import { handleLinkedCalendarFailure } from "./linked-calendar-failure.js";

// Tests and the web layer import this from here; the implementation moved behind
// the provider seam (step C2) without changing.
export { googleEventTimes } from "./calendar-providers/google.js";

/**
 * The user's configured IANA timezone (defaults to the product default). Used to
 * interpret an offset-less conflict window in the user's wall clock. Mirrors
 * proactive-actions.getUserTimeZone — extract to a shared util if a third caller
 * appears.
 */
async function getUserTimeZone(userId: string): Promise<string> {
  const config = await prisma.automationConfig.findUnique({
    where: { userId },
    select: { timezone: true },
  });
  return normalizeTimeZone(config?.timezone);
}

const LIST_NOT_CONNECTED =
  "Google Calendar not connected. Please connect your Google account first.";

/** What the model is told when rows exist but the primary Google connection is gone. */
const STALE_ROWS_NOTICE =
  "The events below are from Klorn's last sync and may be out of date until Google is reconnected.";

/**
 * `list_events` with UNIFIED_CALENDAR_READ_ENABLED on (step C7): the synced rows
 * through the one read path, so linked calendars show once, marked read-only, and
 * no Google API call is made. The primary connection is still checked (a local
 * read and decrypt, no network) so the live path's prompt survives: with no
 * connection and no rows the answer is main's not-connected error; with rows it
 * is the events plus the same prompt as a `warning`, since they are a stale copy.
 */
async function listEventsFromRows(userId: string, maxResults: number) {
  try {
    const now = new Date();
    const timeZone = await getUserTimeZone(userId);
    const [rows, session] = await Promise.all([
      readUpcomingEvents(userId, maxResults, now, timeZone),
      connectPrimaryCalendar(userId),
    ]);
    if (!session && rows.length === 0) return { error: LIST_NOT_CONNECTED };
    const events = rows.map((row) => toToolEvent(row, timeZone));
    return session ? { events } : { events, warning: `${LIST_NOT_CONNECTED} ${STALE_ROWS_NOTICE}` };
  } catch (err) {
    console.error("[CALENDAR] listEvents (rows) failed:", err);
    return { error: "Could not read the synced calendar right now." };
  }
}

export async function listEvents(userId: string, maxResults = 10) {
  if (unifiedCalendarReadEnabled()) return listEventsFromRows(userId, maxResults);

  const session = await connectPrimaryCalendar(userId);
  if (!session) return { error: LIST_NOT_CONNECTED };

  try {
    const listed = await session.listEvents({ timeMin: new Date().toISOString(), maxResults });

    const events = listed.map((e) => ({
      id: e.externalId,
      summary: wrapUntrusted(e.summary || "(No title)", "calendar:summary"),
      start: e.start,
      end: e.end,
      location: wrapUntrusted(e.location, "calendar:location"),
      description: wrapUntrusted(e.description, "calendar:description"),
    }));

    return { events };
  } catch (err: unknown) {
    if (isGoogleAuthError(err)) {
      await markGoogleTokenForReconnect(userId);
      return { error: "Google Calendar not connected. Please reconnect your Google account." };
    }
    const gaxiosErr = err as {
      response?: { status?: number; data?: { error?: { message?: string; status?: string } } };
      message?: string;
    };
    const status = gaxiosErr.response?.status;
    const apiMsg = gaxiosErr.response?.data?.error?.message || gaxiosErr.message || "Unknown error";
    console.error(`[CALENDAR] listEvents failed (HTTP ${status}):`, apiMsg);
    return { error: `Calendar API error (${status}): ${apiMsg}` };
  }
}

export async function createEvent(
  userId: string,
  summary: string,
  startTime: string,
  endTime: string,
  description?: string,
  location?: string,
  attendees?: string[],
  allDay = false,
) {
  const session = await connectPrimaryCalendar(userId);
  if (!session) return { error: "Google Calendar not connected." };

  try {
    // A naive (offset-less) dateTime is interpreted by Google in whatever
    // timeZone field is sent — hardcoding "Asia/Seoul" here put every
    // non-KST user's event at the wrong absolute time (#676).
    const userZone = await getUserTimeZone(userId);
    // Invitations go out only when the human-approved draft carries attendees
    // (team mode P2) — the assistant's tool path never passes them.
    const written = await session.createEvent({
      summary,
      description,
      location,
      startTime,
      endTime,
      allDay,
      timeZone: userZone,
      attendees,
    });

    // Canonical timestamps come back from the provider's response — these are
    // the values it actually stored, after applying its own offset/timeZone
    // resolution rules. Local DB writes should use these, NOT the LLM's
    // raw input, to prevent the 2026-06-04 +13h shift bug: when the LLM
    // produces a dateTime with a wrong offset (e.g. "-04:00" instead of
    // "+09:00"), Google sanitizes via the timeZone field but
    // `new Date(rawLlmString)` parses the raw offset and stores the wrong
    // UTC moment locally.
    return {
      success: true,
      eventId: written.eventId,
      htmlLink: written.htmlLink,
      canonicalStart: written.canonicalStart,
      canonicalEnd: written.canonicalEnd,
    };
  } catch (err: unknown) {
    if (isGoogleAuthError(err)) {
      await markGoogleTokenForReconnect(userId);
      return { error: "Google Calendar not connected. Please reconnect your Google account." };
    }
    const gaxiosErr = err as {
      response?: { status?: number; data?: { error?: { message?: string; status?: string } } };
      message?: string;
    };
    const status = gaxiosErr.response?.status;
    const apiMsg = gaxiosErr.response?.data?.error?.message || gaxiosErr.message || "Unknown error";
    console.error(`[CALENDAR] createEvent failed (HTTP ${status}):`, apiMsg);
    return { error: `Calendar API error (${status}): ${apiMsg}` };
  }
}

export interface GoogleEventPatch {
  summary?: string;
  description?: string | null;
  location?: string | null;
  /** Both or neither — Google needs a consistent start/end pair. */
  startTime?: string;
  endTime?: string;
  allDay?: boolean;
}

/**
 * Push an edit to the Google copy of a synced event (2026-09-11). Without
 * this, an edit made in Klorn lived only in the local row and the next
 * Google sync (upsert by googleId) silently reverted it. Same timezone and
 * all-day rules as createEvent; auth failures flag the token for reconnect
 * like every other calendar write.
 */
export async function updateEvent(userId: string, eventId: string, patch: GoogleEventPatch) {
  const session = await connectPrimaryCalendar(userId);
  if (!session) return { error: "Google Calendar not connected." };

  try {
    const userZone = await getUserTimeZone(userId);
    const written = await session.updateEvent(eventId, { ...patch, timeZone: userZone });
    return {
      success: true,
      canonicalStart: written.canonicalStart,
      canonicalEnd: written.canonicalEnd,
    };
  } catch (err: unknown) {
    if (isGoogleAuthError(err)) {
      await markGoogleTokenForReconnect(userId);
      return { error: "Google Calendar not connected. Please reconnect your Google account." };
    }
    const gaxiosErr = err as {
      response?: { status?: number; data?: { error?: { message?: string } } };
      message?: string;
    };
    const status = gaxiosErr.response?.status;
    const apiMsg = gaxiosErr.response?.data?.error?.message || gaxiosErr.message || "Unknown error";
    console.error(`[CALENDAR] updateEvent failed (HTTP ${status}):`, apiMsg);
    return { error: `Calendar API error (${status}): ${apiMsg}` };
  }
}

export async function deleteEvent(userId: string, eventId: string) {
  const session = await connectPrimaryCalendar(userId);
  if (!session) return { error: "Google Calendar not connected." };

  try {
    await session.deleteEvent(eventId);
  } catch (err) {
    if (isGoogleAuthError(err)) {
      await markGoogleTokenForReconnect(userId);
      return { error: "Google Calendar not connected. Please reconnect your Google account." };
    }
    throw err;
  }

  return { success: true };
}

/** A 403 from the calendar API. On the multi-calendar path this means the token
 *  predates the calendar.readonly scope (existing users), so we degrade to
 *  primary-only rather than failing the whole conflict check. */
function isForbidden(err: unknown): boolean {
  const e = err as { response?: { status?: number }; code?: number | string };
  return e?.response?.status === 403 || e?.code === 403;
}

function conflictResult(
  conflicts: readonly unknown[],
  opts: { scope: "all_calendars" | "primary_only"; linkedAccountsChecked: number },
) {
  return {
    hasConflicts: conflicts.length > 0,
    conflicts,
    scope: opts.scope,
    linkedAccountsChecked: opts.linkedAccountsChecked,
    message:
      conflicts.length > 0
        ? `Found ${conflicts.length} conflicting event(s) in this time range.`
        : "No conflicts — this time slot is free.",
  };
}

/** Busy blocks from every LINKED (secondary) calendar account — e.g. a work
 *  account — which one primary token structurally can't see. Accounts come from
 *  the provider seam, so a provider with no implementation yet is skipped. Best-
 *  effort: a linked account that errors goes through the shared failure policy
 *  (flagged for reconnect on a revoked token, otherwise logged + captured) and is
 *  skipped, never sinking the whole check (primary + the other linked accounts
 *  still count). */
async function linkedAccountConflicts(
  userId: string,
  timeMin: string,
  timeMax: string,
): Promise<{ conflicts: BusyConflict[]; accountsChecked: number }> {
  // A flagged account is still tried: a successful token refresh clears the flag.
  const linked = await connectLinkedCalendars(userId, { skipNeedsReconnect: false });
  const conflicts: BusyConflict[] = [];
  for (const { session, id, email } of linked) {
    try {
      conflicts.push(...(await session.busyBlocks({ timeMin, timeMax })));
    } catch (err) {
      await handleLinkedCalendarFailure({
        userId,
        linkedAccountId: id,
        email,
        err,
        scope: "calendar.linked_freebusy_failed",
        action: "free/busy",
      });
    }
  }
  return { conflicts, accountsChecked: linked.length };
}

/**
 * Team-mode v1 (founder 2026-08-15/19): are the OTHER people free at the
 * proposed slot? Queries Google free/busy for the given attendee addresses —
 * works whenever their calendars are visible to this account (same Workspace
 * or explicitly shared). A calendar we can't read reports an inline error and
 * is OMITTED (unknown, never "free"). Best-effort by contract: any transport
 * failure returns [] and the caller says nothing rather than guessing.
 */
export async function checkAttendeeBusy(
  userId: string,
  attendeeEmails: string[],
  startTime: string,
  endTime: string,
): Promise<Array<{ email: string; busy: boolean }>> {
  if (attendeeEmails.length === 0) return [];
  const session = await connectPrimaryCalendar(userId);
  if (!session) return [];
  const userZone = await getUserTimeZone(userId);
  const timeMin = toAbsoluteInstant(startTime, userZone);
  const timeMax = toAbsoluteInstant(endTime, userZone);
  if (!timeMin || !timeMax) return [];
  try {
    const people = await session.peopleFreeBusy(attendeeEmails, { timeMin, timeMax });
    // A calendar we cannot see (blocks null) is unknown — omitted, never "free".
    return people.flatMap((p) => (p.blocks ? [{ email: p.email, busy: p.anyBusy }] : []));
  } catch (err) {
    console.warn(`[CALENDAR] attendee freebusy failed for ${userId}:`, err);
    return [];
  }
}

/**
 * Team mode v2: the attendees' BUSY INTERVALS over a window (not just a
 * boolean at one slot) — the input the alternative-slot suggester needs.
 * Same visibility rule as checkAttendeeBusy: calendars this account cannot
 * see contribute nothing (absent ≠ free), and any failure degrades to [].
 */
export async function getAttendeeBusyBlocks(
  userId: string,
  attendeeEmails: string[],
  timeMinIso: string,
  timeMaxIso: string,
): Promise<Array<{ start: string; end: string }>> {
  if (attendeeEmails.length === 0) return [];
  const session = await connectPrimaryCalendar(userId);
  if (!session) return [];
  try {
    const people = await session.peopleFreeBusy(attendeeEmails, {
      timeMin: timeMinIso,
      timeMax: timeMaxIso,
    });
    return people.flatMap((p) => p.blocks ?? []);
  } catch (err) {
    console.warn(`[CALENDAR] attendee busy-block query failed for ${userId}:`, err);
    return [];
  }
}

/**
 * Team mode P1: per-member busy intervals with VISIBILITY made explicit —
 * blocks: null means "this calendar is not visible to the user" (absent ≠
 * free; callers must report those members as unknown, never as available).
 */
export async function getAttendeeBusyByMember(
  userId: string,
  attendeeEmails: string[],
  timeMinIso: string,
  timeMaxIso: string,
): Promise<Array<{ email: string; blocks: Array<{ start: string; end: string }> | null }>> {
  if (attendeeEmails.length === 0) return [];
  const session = await connectPrimaryCalendar(userId);
  if (!session) return attendeeEmails.map((email) => ({ email, blocks: null }));
  try {
    const people = await session.peopleFreeBusy(attendeeEmails, {
      timeMin: timeMinIso,
      timeMax: timeMaxIso,
    });
    return people.map(({ email, blocks }) => ({ email, blocks }));
  } catch (err) {
    console.warn(`[CALENDAR] per-member busy query failed for ${userId}:`, err);
    return attendeeEmails.map((email) => ({ email, blocks: null }));
  }
}

export async function checkConflicts(userId: string, startTime: string, endTime: string) {
  const session = await connectPrimaryCalendar(userId);
  if (!session) return { error: "Google Calendar not connected." };

  // The conflict window must be an absolute instant. The tool contract asks the
  // agent for offset-bearing ISO8601, but a naive (offset-less) string must be
  // read in the USER's zone, never the server's UTC — otherwise the queried
  // window is hours off and a real clash is missed or invented.
  const userZone = await getUserTimeZone(userId);
  const timeMin = toAbsoluteInstant(startTime, userZone);
  const timeMax = toAbsoluteInstant(endTime, userZone);
  if (!timeMin || !timeMax) {
    return { error: "Invalid time range — start_time and end_time must be valid ISO 8601." };
  }

  const window = { timeMin, timeMax };

  // Primary account: free/busy across ITS calendars, degrading to primary-only
  // events.list when the token predates the calendar.readonly scope (403).
  let primaryConflicts: readonly unknown[];
  let scope: "all_calendars" | "primary_only";
  try {
    primaryConflicts = await session.busyBlocks(window);
    scope = "all_calendars";
  } catch (err) {
    if (isGoogleAuthError(err)) {
      await markGoogleTokenForReconnect(userId);
      return { error: "Google Calendar not connected. Please reconnect your Google account." };
    }
    if (!isForbidden(err)) throw err;
    try {
      primaryConflicts = await session.primaryBusyBlocks(window);
      scope = "primary_only";
    } catch (fallbackErr) {
      if (isGoogleAuthError(fallbackErr)) {
        await markGoogleTokenForReconnect(userId);
        return { error: "Google Calendar not connected. Please reconnect your Google account." };
      }
      throw fallbackErr;
    }
  }

  // Linked (secondary) accounts widen the window ACROSS Google accounts — the
  // real fix for a double-book that lives on a separate work account.
  const { conflicts: linkedConflicts, accountsChecked } = await linkedAccountConflicts(
    userId,
    timeMin,
    timeMax,
  );

  const live = [...primaryConflicts, ...linkedConflicts];
  const conflicts = unifiedCalendarReadEnabled()
    ? await withRowConflicts(userId, { timeMin, timeMax, userZone }, live)
    : live;

  return conflictResult(conflicts, { scope, linkedAccountsChecked: accountsChecked });
}

/**
 * Step C7 (UNIFIED_CALENDAR_READ_ENABLED on): add the synced rows that overlap
 * the window to the live free/busy answer, through the one read path (scope,
 * dedupe, provider and readOnly per event). Free/busy stays in: it sees calendars
 * the sync does not mirror and changes newer than the last sync. A row read that
 * fails throws, like any other unexpected failure here: never answer "free" on
 * half the evidence.
 */
async function withRowConflicts(
  userId: string,
  window: { timeMin: string; timeMax: string; userZone: string },
  live: readonly unknown[],
): Promise<unknown[]> {
  const rows = await readOverlappingTimedEvents(userId, {
    start: new Date(window.timeMin),
    end: new Date(window.timeMax),
  });
  const rowConflicts = rows.map((row) => toRowConflict(row, window.userZone));
  return mergeConflicts(rowConflicts, rows, live);
}

const LIST_EVENTS_DESCRIPTION = "List upcoming events from the user's Google Calendar";
const CHECK_CONFLICTS_DESCRIPTION =
  "Check if a time range has any conflicting events. Use before creating events to avoid double-booking.";

// Step C7. The freshness trade-off is stated to the model: rows are a synced
// copy, so a change lags and an event deleted or cancelled in Google can still be
// listed until the sync removes it.
const LIST_EVENTS_UNIFIED_DESCRIPTION =
  "List upcoming events from the user's calendars, read from Klorn's synced copy " +
  "(refreshed about every 15 minutes, covering the next month), not live from Google: an " +
  "event created or moved in the last 15 minutes may not show yet, and an event deleted or " +
  "cancelled in Google may still be listed until Klorn's sync removes it. Each event says " +
  "its provider and whether it is readOnly (a linked calendar's event cannot be edited or deleted).";
const CHECK_CONFLICTS_UNIFIED_DESCRIPTION =
  "Check if a time range has any conflicting events. Use before creating events to avoid " +
  "double-booking. Timed events come from Klorn's synced copy of the calendars (refreshed about " +
  "every 15 minutes), combined with a live Google free/busy check, so a change made in the " +
  "last 15 minutes is seen only through free/busy, and an event deleted or cancelled in Google " +
  "may still count until Klorn's sync removes it. All-day events are not counted.";

export const CALENDAR_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "list_events",
      // Request time: the text changes only while the flag is on (step C7).
      get description() {
        return unifiedCalendarReadEnabled()
          ? LIST_EVENTS_UNIFIED_DESCRIPTION
          : LIST_EVENTS_DESCRIPTION;
      },
      parameters: {
        type: "object",
        properties: {
          max_results: {
            type: "number",
            description: "Number of upcoming events to fetch (default 10)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_event",
      description: "Create a new event on the user's Google Calendar",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Event title" },
          start_time: {
            type: "string",
            description: "Start time in ISO 8601 format (e.g. 2026-03-25T14:00:00+09:00)",
          },
          end_time: {
            type: "string",
            description: "End time in ISO 8601 format (e.g. 2026-03-25T15:00:00+09:00)",
          },
          description: { type: "string", description: "Event description (optional)" },
          location: { type: "string", description: "Event location (optional)" },
          // INVARIANT: this parameter exists so the MODEL can propose
          // invitees for the chat confirm card. The tool-executor's
          // create_event case deliberately IGNORES it — the only caller that
          // ever passes attendees to createEvent() is the human-approved
          // POST /api/calendar. Do not wire it into the executor.
          attendees: {
            type: "array",
            items: { type: "string" },
            description:
              "Attendee email addresses to invite (optional). In chat this becomes part of the " +
              "confirm card — invitations are sent only after the user approves.",
          },
        },
        required: ["summary", "start_time", "end_time"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "check_calendar_conflicts",
      get description() {
        return unifiedCalendarReadEnabled()
          ? CHECK_CONFLICTS_UNIFIED_DESCRIPTION
          : CHECK_CONFLICTS_DESCRIPTION;
      },
      parameters: {
        type: "object",
        properties: {
          start_time: {
            type: "string",
            description: "Start time in ISO 8601 format (e.g. 2026-03-25T14:00:00+09:00)",
          },
          end_time: {
            type: "string",
            description: "End time in ISO 8601 format (e.g. 2026-03-25T15:00:00+09:00)",
          },
        },
        required: ["start_time", "end_time"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete_event",
      description: "Delete an event from the user's Google Calendar by its ID",
      parameters: {
        type: "object",
        properties: {
          event_id: { type: "string", description: "The Google Calendar event ID to delete" },
        },
        required: ["event_id"],
      },
    },
  },
];
