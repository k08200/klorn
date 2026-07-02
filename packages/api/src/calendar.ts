import { type calendar_v3, google } from "googleapis";
import { prisma } from "./db.js";
import {
  getAuthedClient,
  getLinkedCalendarClients,
  isGoogleAuthError,
  markGoogleTokenForReconnect,
  markLinkedCalendarForReconnect,
} from "./gmail.js";
import {
  type BusyConflict,
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
