import { google } from "googleapis";
import { getAuthedClient, isGoogleAuthError, markGoogleTokenForReconnect } from "./gmail.js";
import { wrapUntrusted } from "./untrusted.js";

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

export async function checkConflicts(userId: string, startTime: string, endTime: string) {
  const auth = await getAuthedClient(userId);
  if (!auth) return { error: "Google Calendar not connected." };

  const calendar = google.calendar({ version: "v3", auth });
  let res: {
    data: {
      items?: Array<{
        id?: string | null;
        summary?: string | null;
        start?: { dateTime?: string | null; date?: string | null } | null;
        end?: { dateTime?: string | null; date?: string | null } | null;
      }> | null;
    };
  };
  try {
    res = await calendar.events.list({
      calendarId: "primary",
      timeMin: startTime,
      timeMax: endTime,
      singleEvents: true,
      orderBy: "startTime",
    });
  } catch (err) {
    if (isGoogleAuthError(err)) {
      await markGoogleTokenForReconnect(userId);
      return { error: "Google Calendar not connected. Please reconnect your Google account." };
    }
    throw err;
  }

  const conflicts = (res.data.items || []).map((e) => ({
    id: e.id,
    summary: e.summary || "(No title)",
    start: e.start?.dateTime || e.start?.date || "",
    end: e.end?.dateTime || e.end?.date || "",
  }));

  return {
    hasConflicts: conflicts.length > 0,
    conflicts,
    message:
      conflicts.length > 0
        ? `Found ${conflicts.length} conflicting event(s) in this time range.`
        : "No conflicts — this time slot is free.",
  };
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
