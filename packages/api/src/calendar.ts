import { type calendar_v3, google } from "googleapis";
import { prisma } from "./db.js";
import { getAuthedClient, isGoogleAuthError, markGoogleTokenForReconnect } from "./gmail.js";
import {
  type CalendarConflictItem,
  calendarLabelMap,
  selectFreeBusyCalendarIds,
  summarizeConflicts,
  summarizeFreeBusy,
  toAbsoluteInstant,
} from "./google-calendar-time.js";
import { captureError } from "./sentry.js";
import { normalizeTimeZone } from "./time-zone.js";
import { wrapUntrusted } from "./untrusted.js";

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

export async function createEvent(
  userId: string,
  summary: string,
  startTime: string,
  endTime: string,
  description?: string,
  location?: string,
) {
  const auth = await getAuthedClient(userId);
  if (!auth) return { error: "Google Calendar not connected." };

  try {
    const calendar = google.calendar({ version: "v3", auth });
    const res = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary,
        description: description || "",
        location: location || "",
        start: { dateTime: startTime, timeZone: "Asia/Seoul" },
        end: { dateTime: endTime, timeZone: "Asia/Seoul" },
      },
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

function conflictResult(conflicts: readonly unknown[], opts: { multiCalendar: boolean }) {
  return {
    hasConflicts: conflicts.length > 0,
    conflicts,
    scope: opts.multiCalendar ? "all_calendars" : "primary_only",
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

/** Primary-only fallback for tokens that lack calendar.readonly. Still
 *  timezone-correct and all-day-safe — just blind to other calendars. */
async function primaryOnlyConflicts(
  calendar: calendar_v3.Calendar,
  userId: string,
  timeMin: string,
  timeMax: string,
) {
  try {
    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
    });
    return conflictResult(summarizeConflicts((res.data.items as CalendarConflictItem[]) || []), {
      multiCalendar: false,
    });
  } catch (err) {
    if (isGoogleAuthError(err)) {
      await markGoogleTokenForReconnect(userId);
      return { error: "Google Calendar not connected. Please reconnect your Google account." };
    }
    throw err;
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

  try {
    // A double-book can sit on ANY of the user's calendars (work, shared,
    // secondary), not just primary. One free/busy query covers them all.
    const conflicts = await freeBusyConflicts(calendar, timeMin, timeMax);
    return conflictResult(conflicts, { multiCalendar: true });
  } catch (err) {
    if (isGoogleAuthError(err)) {
      await markGoogleTokenForReconnect(userId);
      return { error: "Google Calendar not connected. Please reconnect your Google account." };
    }
    if (isForbidden(err)) {
      // Token predates the calendar.readonly scope — degrade to primary-only
      // until the user reconnects and picks up multi-calendar free/busy.
      return primaryOnlyConflicts(calendar, userId, timeMin, timeMax);
    }
    throw err;
  }
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
