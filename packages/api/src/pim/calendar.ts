import { type calendar_v3, google } from "googleapis";
import { prisma } from "../db.js";
import {
  type BusyConflict,
  type CalendarConflictItem,
  calendarLabelMap,
  selectFreeBusyCalendarIds,
  summarizeConflicts,
  summarizeFreeBusy,
  toAbsoluteInstant,
} from "../google-calendar-time.js";
import {
  getAuthedClient,
  getLinkedCalendarClients,
  isGoogleAuthError,
  markGoogleTokenForReconnect,
  markLinkedCalendarForReconnect,
} from "../mail/gmail.js";
import { captureError } from "../sentry.js";
import { normalizeTimeZone } from "../time-zone.js";
import { wrapUntrusted } from "../untrusted.js";

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

export async function listEvents(userId: string, maxResults = 10) {
  const auth = await getAuthedClient(userId);
  if (!auth)
    return { error: "Google Calendar not connected. Please connect your Google account first." };

  try {
    const calendar = google.calendar({ version: "v3", auth });
    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin: new Date().toISOString(),
      maxResults,
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = (res.data.items || []).map((e) => ({
      id: e.id,
      summary: wrapUntrusted(e.summary || "(No title)", "calendar:summary"),
      start: e.start?.dateTime || e.start?.date || "",
      end: e.end?.dateTime || e.end?.date || "",
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

/**
 * The start/end Google wants for an event. Timed events carry the user's
 * IANA zone so a naive dateTime is read in THEIR wall clock (#676). All-day
 * events are DATES (end exclusive, Google's contract) — the date is read
 * off the string, never off an instant, so "2026-08-01T00:00:00Z" and
 * "2026-08-01T00:00:00+09:00" both mean August 1st. Pure, exported for
 * its tests.
 */
export function googleEventTimes(input: {
  startTime: string;
  endTime: string;
  allDay: boolean;
  timeZone: string;
}): { start: calendar_v3.Schema$EventDateTime; end: calendar_v3.Schema$EventDateTime } {
  if (input.allDay) {
    return {
      start: { date: input.startTime.slice(0, 10) },
      end: { date: input.endTime.slice(0, 10) },
    };
  }
  return {
    start: { dateTime: input.startTime, timeZone: input.timeZone },
    end: { dateTime: input.endTime, timeZone: input.timeZone },
  };
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
  const auth = await getAuthedClient(userId);
  if (!auth) return { error: "Google Calendar not connected." };

  try {
    // A naive (offset-less) dateTime is interpreted by Google in whatever
    // timeZone field is sent — hardcoding "Asia/Seoul" here put every
    // non-KST user's event at the wrong absolute time (#676).
    const userZone = await getUserTimeZone(userId);
    const calendar = google.calendar({ version: "v3", auth });
    const res = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary,
        description: description || "",
        location: location || "",
        ...googleEventTimes({ startTime, endTime, allDay, timeZone: userZone }),
        ...(attendees && attendees.length > 0
          ? { attendees: attendees.map((email) => ({ email })) }
          : {}),
      },
      // Invitations go out only when the human-approved draft carries
      // attendees (team mode P2) — the assistant's tool path never passes them.
      ...(attendees && attendees.length > 0 ? { sendUpdates: "all" as const } : {}),
    });

    // Canonical timestamps come back from Google's response — these are the
    // values Google actually stored, after applying its own offset/timeZone
    // resolution rules. Local DB writes should use these, NOT the LLM's
    // raw input, to prevent the 2026-06-04 +13h shift bug: when the LLM
    // produces a dateTime with a wrong offset (e.g. "-04:00" instead of
    // "+09:00"), Google sanitizes via the timeZone field but
    // `new Date(rawLlmString)` parses the raw offset and stores the wrong
    // UTC moment locally.
    return {
      success: true,
      eventId: res.data.id,
      htmlLink: res.data.htmlLink,
      canonicalStart: res.data.start?.dateTime ?? res.data.start?.date ?? null,
      canonicalEnd: res.data.end?.dateTime ?? res.data.end?.date ?? null,
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
  const auth = await getAuthedClient(userId);
  if (!auth) return { error: "Google Calendar not connected." };

  try {
    const userZone = await getUserTimeZone(userId);
    const calendar = google.calendar({ version: "v3", auth });
    const requestBody: calendar_v3.Schema$Event = {
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.description !== undefined ? { description: patch.description ?? "" } : {}),
      ...(patch.location !== undefined ? { location: patch.location ?? "" } : {}),
      ...(patch.startTime && patch.endTime
        ? googleEventTimes({
            startTime: patch.startTime,
            endTime: patch.endTime,
            allDay: patch.allDay ?? false,
            timeZone: userZone,
          })
        : {}),
    };
    const res = await calendar.events.patch({ calendarId: "primary", eventId, requestBody });
    return {
      success: true,
      canonicalStart: res.data.start?.dateTime ?? res.data.start?.date ?? null,
      canonicalEnd: res.data.end?.dateTime ?? res.data.end?.date ?? null,
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
  const auth = await getAuthedClient(userId);
  if (!auth) return { error: "Google Calendar not connected." };

  const calendar = google.calendar({ version: "v3", auth });
  try {
    await calendar.events.delete({
      calendarId: "primary",
      eventId,
    });
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

/** Free/busy across every calendar the user writes to — one query covers the
 *  work / shared / secondary calendars a primary-only check structurally misses. */
async function freeBusyConflicts(calendar: calendar_v3.Calendar, timeMin: string, timeMax: string) {
  const list = await calendar.calendarList.list({ maxResults: 250, minAccessRole: "writer" });
  const ids = selectFreeBusyCalendarIds(list.data.items);
  if (ids.length === 0) return [];
  const fb = await calendar.freebusy.query({
    requestBody: { timeMin, timeMax, items: ids.map((id) => ({ id })) },
  });
  const calendars = fb.data.calendars ?? {};

  // freebusy reports per-calendar failures inline (not as an HTTP error): a
  // calendar the token can't read returns { errors:[...] } with empty busy. If
  // we ignored it, that calendar would look free — a silent false "no conflict".
  // Surface it so the gap is visible instead of becoming a missed double-book.
  const failed = Object.entries(calendars).filter(([, c]) => (c?.errors?.length ?? 0) > 0);
  if (failed.length > 0) {
    const reasons = failed.map(([id, c]) => `${id}:${c?.errors?.[0]?.reason ?? "unknown"}`);
    console.warn(`[CALENDAR] freebusy partial — ${failed.length} calendar(s) failed: ${reasons}`);
    captureError(new Error("freebusy partial result"), {
      tags: { scope: "calendar.freebusy_partial" },
      extra: { failedCount: failed.length, reasons },
    });
  }

  return summarizeFreeBusy(calendars, calendarLabelMap(list.data.items));
}

/** Primary-only busy blocks (events.list) for tokens that lack calendar.readonly.
 *  Still timezone-correct and all-day-safe — just blind to other calendars. */
async function primaryOnlyBusy(
  calendar: calendar_v3.Calendar,
  timeMin: string,
  timeMax: string,
): Promise<readonly unknown[]> {
  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime",
  });
  return summarizeConflicts((res.data.items as CalendarConflictItem[]) || []);
}

/** Busy blocks from every LINKED (secondary) Google account — e.g. a work
 *  account — which one primary token structurally can't see. Best-effort: a
 *  linked account that errors is logged + captured and skipped, never sinking
 *  the whole check (primary + the other linked accounts still count). */
async function linkedAccountConflicts(
  userId: string,
  timeMin: string,
  timeMax: string,
): Promise<{ conflicts: BusyConflict[]; accountsChecked: number }> {
  const linked = await getLinkedCalendarClients(userId);
  const conflicts: BusyConflict[] = [];
  for (const { client, id, email } of linked) {
    try {
      const cal = google.calendar({ version: "v3", auth: client });
      conflicts.push(...(await freeBusyConflicts(cal, timeMin, timeMax)));
    } catch (err) {
      // A revoked linked-calendar token 401s here. Flag it for reconnect so the
      // UI prompts a re-link instead of the account silently dropping out of
      // free/busy on every check. Only auth errors flag — a transient failure
      // must not demand a re-link. Best-effort: a DB blip in the flag-write must
      // NOT abort the loop or skip the error logging below (skip-and-continue).
      if (isGoogleAuthError(err)) {
        await markLinkedCalendarForReconnect(userId, id).catch((markErr) => {
          console.error(`[CALENDAR] Failed to flag linked calendar ${id} for reconnect:`, markErr);
          captureError(markErr, { tags: { scope: "calendar.linked.mark-reconnect" } });
        });
      }
      console.warn(
        `[CALENDAR] linked-account free/busy failed (skipped): ${err instanceof Error ? err.message : err}`,
      );
      captureError(err, {
        tags: { scope: "calendar.linked_freebusy_failed" },
        // Domain only — never send the full linked email (PII) to Sentry.
        extra: { userId, accountDomain: email.split("@")[1] ?? "unknown" },
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
  const auth = await getAuthedClient(userId);
  if (!auth) return [];
  const userZone = await getUserTimeZone(userId);
  const timeMin = toAbsoluteInstant(startTime, userZone);
  const timeMax = toAbsoluteInstant(endTime, userZone);
  if (!timeMin || !timeMax) return [];
  try {
    const calendar = google.calendar({ version: "v3", auth });
    const fb = await calendar.freebusy.query({
      requestBody: { timeMin, timeMax, items: attendeeEmails.map((id) => ({ id })) },
    });
    const calendars = fb.data.calendars ?? {};
    const out: Array<{ email: string; busy: boolean }> = [];
    for (const email of attendeeEmails) {
      const cal = calendars[email];
      if (!cal || (cal.errors?.length ?? 0) > 0) continue; // not visible — unknown
      out.push({ email, busy: (cal.busy?.length ?? 0) > 0 });
    }
    return out;
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
  const auth = await getAuthedClient(userId);
  if (!auth) return [];
  try {
    const calendar = google.calendar({ version: "v3", auth });
    const fb = await calendar.freebusy.query({
      requestBody: {
        timeMin: timeMinIso,
        timeMax: timeMaxIso,
        items: attendeeEmails.map((id) => ({ id })),
      },
    });
    const calendars = fb.data.calendars ?? {};
    const out: Array<{ start: string; end: string }> = [];
    for (const email of attendeeEmails) {
      const cal = calendars[email];
      if (!cal || (cal.errors?.length ?? 0) > 0) continue;
      for (const b of cal.busy ?? []) {
        if (b.start && b.end) out.push({ start: b.start, end: b.end });
      }
    }
    return out;
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
  const auth = await getAuthedClient(userId);
  if (!auth) return attendeeEmails.map((email) => ({ email, blocks: null }));
  try {
    const calendar = google.calendar({ version: "v3", auth });
    const fb = await calendar.freebusy.query({
      requestBody: {
        timeMin: timeMinIso,
        timeMax: timeMaxIso,
        items: attendeeEmails.map((id) => ({ id })),
      },
    });
    const calendars = fb.data.calendars ?? {};
    return attendeeEmails.map((email) => {
      const cal = calendars[email];
      if (!cal || (cal.errors?.length ?? 0) > 0) return { email, blocks: null };
      const blocks: Array<{ start: string; end: string }> = [];
      for (const b of cal.busy ?? []) {
        if (b.start && b.end) blocks.push({ start: b.start, end: b.end });
      }
      return { email, blocks };
    });
  } catch (err) {
    console.warn(`[CALENDAR] per-member busy query failed for ${userId}:`, err);
    return attendeeEmails.map((email) => ({ email, blocks: null }));
  }
}

export async function checkConflicts(userId: string, startTime: string, endTime: string) {
  const auth = await getAuthedClient(userId);
  if (!auth) return { error: "Google Calendar not connected." };

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

  const calendar = google.calendar({ version: "v3", auth });

  // Primary account: free/busy across ITS calendars, degrading to primary-only
  // events.list when the token predates the calendar.readonly scope (403).
  let primaryConflicts: readonly unknown[];
  let scope: "all_calendars" | "primary_only";
  try {
    primaryConflicts = await freeBusyConflicts(calendar, timeMin, timeMax);
    scope = "all_calendars";
  } catch (err) {
    if (isGoogleAuthError(err)) {
      await markGoogleTokenForReconnect(userId);
      return { error: "Google Calendar not connected. Please reconnect your Google account." };
    }
    if (!isForbidden(err)) throw err;
    try {
      primaryConflicts = await primaryOnlyBusy(calendar, timeMin, timeMax);
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

  return conflictResult([...primaryConflicts, ...linkedConflicts], {
    scope,
    linkedAccountsChecked: accountsChecked,
  });
}

export const CALENDAR_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "list_events",
      description: "List upcoming events from the user's Google Calendar",
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
      description:
        "Check if a time range has any conflicting events. Use before creating events to avoid double-booking.",
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
