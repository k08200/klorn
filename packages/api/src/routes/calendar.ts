/**
 * Calendar API — Manage events and schedule
 *
 * Provides local calendar events stored in DB + optional Google Calendar sync.
 */
import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { requireAppAccess, requireEntitled } from "../billing/entitlement-guard.js";
import { prisma } from "../db.js";
import {
  deleteAttentionForCalendarEvents,
  upsertAttentionForCalendarEvent,
} from "../judge/attention-mirror.js";
import { isGoogleAuthError, markGoogleTokenForReconnect } from "../mail/gmail.js";
import {
  createEvent as googleCreateEvent,
  deleteEvent as googleDeleteEvent,
  updateEvent as googleUpdateEvent,
} from "../pim/calendar.js";
import { dedupeCalendarEvents } from "../pim/calendar-dedupe.js";
import { connectPrimaryCalendar } from "../pim/calendar-providers/dispatch.js";
import { eventSourceForGoogleId } from "../pim/calendar-rows.js";
import { readSyncTimezone, syncPrimaryCalendarWindow } from "../pim/calendar-sync.js";
import { buildMeetingPrepPack } from "../pim/meeting-prep-pack.js";
import { captureError } from "../sentry.js";

const listEventsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    days: { type: "string", maxLength: 500 },
    start: { type: "string", maxLength: 500 },
    end: { type: "string", maxLength: 500 },
  },
} as const;

const TITLE_MAX = 300;

/**
 * Events synced from a linked calendar are read-only mirrors (C2): Klorn holds
 * only calendar.readonly there, and the next sync would silently revert an edit
 * or bring a deleted event back.
 */
const LINKED_READ_ONLY = "This event comes from a linked calendar and is read-only in Klorn.";

function isLinkedCalendarRow(event: { sourceAccountId?: string | null }): boolean {
  return (event.sourceAccountId ?? null) !== null;
}

/**
 * The one validation the write routes share: a title that is a non-empty
 * string, ISO times that parse, and an end after the start. Returns the
 * message for a 400, or null when the input is sound. Fields that are
 * absent (a partial PATCH) are not judged — the caller merges first.
 */
export function eventWriteError(input: {
  title?: unknown;
  startTime?: unknown;
  endTime?: unknown;
}): string | null {
  if (input.title !== undefined) {
    if (typeof input.title !== "string" || !input.title.trim()) return "title is required";
    if (input.title.length > TITLE_MAX) return `title must be at most ${TITLE_MAX} characters`;
  }
  const start = input.startTime === undefined ? null : parseIso(input.startTime);
  const end = input.endTime === undefined ? null : parseIso(input.endTime);
  if (input.startTime !== undefined && !start) return "startTime must be an ISO date-time";
  if (input.endTime !== undefined && !end) return "endTime must be an ISO date-time";
  if (start && end && end.getTime() <= start.getTime()) return "endTime must be after startTime";
  return null;
}

function parseIso(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function calendarRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  // Usable free tier: reading the calendar + conflict/prep views is core free
  // value, so admit any non-hard-walled user. Event writes (create/update/
  // delete) keep their OWN per-route requireEntitled below (calendar_write is
  // Pro). No-op pre-launch.
  app.addHook("preHandler", requireAppAccess);

  // List events — supports ?start=ISO&end=ISO or ?days=N (from today)
  app.get("/", { schema: { querystring: listEventsQuerySchema } }, async (request) => {
    const uid = getUserId(request);
    const { days, start, end } = request.query as { days?: string; start?: string; end?: string };

    let rangeStart: Date;
    let rangeEnd: Date;

    if (start && end) {
      rangeStart = new Date(start);
      rangeEnd = new Date(end);
    } else {
      const daysAhead = Number(days) || 14;
      rangeStart = new Date();
      rangeStart.setHours(0, 0, 0, 0);
      rangeEnd = new Date(rangeStart.getTime() + daysAhead * 24 * 60 * 60 * 1000);
    }

    const rows = await prisma.calendarEvent.findMany({
      where: {
        userId: uid,
        startTime: { gte: rangeStart, lte: rangeEnd },
      },
      orderBy: { startTime: "asc" },
    });

    // An invite in both the primary and a linked calendar is two rows (C2).
    return { events: dedupeCalendarEvents(rows) };
  });

  // Get deterministic prep pack for a meeting/event
  app.get("/:id/prep-pack", async (request, reply) => {
    const uid = getUserId(request);
    const { id } = request.params as { id: string };
    const pack = await buildMeetingPrepPack(uid, id);
    if (!pack) return reply.code(404).send({ error: "Event not found" });
    return pack;
  });

  // Get single event
  app.get("/:id", async (request, reply) => {
    const uid = getUserId(request);
    const { id } = request.params as { id: string };
    const event = await prisma.calendarEvent.findUnique({ where: { id } });
    if (!event) return reply.code(404).send({ error: "Event not found" });
    if (event.userId !== uid) return reply.code(403).send({ error: "Forbidden" });
    return event;
  });

  // Parse free text (voice transcript) into an event draft — read-side, free
  // tier included. The client prefills the New event modal; the SAVE still
  // goes through the Pro-gated POST "/" below.
  app.post(
    "/parse-event",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const userId = getUserId(request);
      const body = (request.body ?? {}) as { text?: unknown };
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return reply.code(400).send({ error: "text is required" });
      if (text.length > 500) {
        return reply.code(400).send({ error: "text must be at most 500 characters" });
      }

      try {
        const { parseEventText } = await import("../event-parse.js");
        const event = await parseEventText(userId, text);
        return { event };
      } catch (err) {
        console.error(`[CALENDAR] parse-event failed for user ${userId}:`, err);
        captureError(err, { tags: { scope: "calendar.parse_event", userId } });
        return reply.code(502).send({ error: "Could not parse the text right now" });
      }
    },
  );

  // Create event (local + Google Calendar sync) — Pro (calendar_write)
  app.post("/", { preHandler: requireEntitled }, async (request, reply) => {
    const userId = getUserId(request);
    const { title, description, startTime, endTime, location, meetingLink, color, allDay } =
      request.body as {
        title: string;
        description?: string;
        startTime: string;
        endTime: string;
        location?: string;
        meetingLink?: string;
        color?: string;
        allDay?: boolean;
      };
    // A create must carry all three; the shared check judges what it sees.
    const invalid = eventWriteError({
      title: title ?? "",
      startTime: startTime ?? "",
      endTime: endTime ?? "",
    });
    if (invalid) return reply.code(400).send({ error: invalid });
    // Team mode P2: invitees from the human-approved draft. Validated here —
    // this endpoint is the approval gate that actually sends invitations.
    const rawAttendees = (request.body as { attendees?: unknown }).attendees;
    const attendees = Array.isArray(rawAttendees)
      ? [
          ...new Set(
            rawAttendees
              .filter((a): a is string => typeof a === "string")
              .map((a) => a.trim().toLowerCase())
              .filter((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)),
          ),
        ].slice(0, 20)
      : [];

    // Try to sync to Google Calendar
    let googleId: string | null = null;
    try {
      const result = await googleCreateEvent(
        userId,
        title,
        startTime,
        endTime,
        description,
        location,
        attendees,
        allDay === true,
      );
      if ("eventId" in result && result.eventId) {
        googleId = result.eventId;
      }
    } catch (err) {
      const gaxiosErr = err as {
        response?: { status?: number; data?: { error?: { message?: string } } };
        message?: string;
      };
      console.error(
        `[CALENDAR] Google sync on create failed (HTTP ${gaxiosErr.response?.status}):`,
        gaxiosErr.response?.data?.error?.message || gaxiosErr.message || err,
      );
    }

    const event = await prisma.calendarEvent.create({
      data: {
        userId,
        title,
        description: description || null,
        startTime: new Date(startTime),
        endTime: new Date(endTime),
        location: location || null,
        meetingLink: meetingLink || null,
        color: color || null,
        allDay: allDay || false,
        googleId,
        // C1 dual-write: a Google id makes the row GOOGLE, none makes it LOCAL.
        // Never taken from the request body.
        ...eventSourceForGoogleId(googleId),
      },
    });
    await upsertAttentionForCalendarEvent(event);

    return event;
  });

  // Update event — Pro (calendar_write)
  app.patch("/:id", { preHandler: requireEntitled }, async (request, reply) => {
    const uid = getUserId(request);
    const { id } = request.params as { id: string };
    const existing = await prisma.calendarEvent.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "Event not found" });
    if (existing.userId !== uid) return reply.code(403).send({ error: "Forbidden" });
    if (isLinkedCalendarRow(existing)) return reply.code(409).send({ error: LINKED_READ_ONLY });

    const body = request.body as Record<string, unknown>;
    // The model's title field is `title`; `summary` stays accepted as an
    // alias (the old name silently never updated anything — audit 2026-07-20).
    const title = body.title !== undefined ? body.title : body.summary;
    const invalid = eventWriteError({
      title,
      startTime: body.startTime,
      endTime: body.endTime,
    });
    if (invalid) return reply.code(400).send({ error: invalid });
    // A moved start with the old end (or vice versa) must still be ordered.
    const mergedStart =
      typeof body.startTime === "string" ? new Date(body.startTime) : existing.startTime;
    const mergedEnd = typeof body.endTime === "string" ? new Date(body.endTime) : existing.endTime;
    if (mergedEnd.getTime() <= mergedStart.getTime()) {
      return reply.code(400).send({ error: "endTime must be after startTime" });
    }

    // Only allow safe fields — prevent userId/id overwrite
    const data: Record<string, unknown> = {};
    if (typeof title === "string") data.title = title;
    if (body.description !== undefined) data.description = body.description;
    if (body.location !== undefined) data.location = body.location;
    if (body.allDay !== undefined) data.allDay = body.allDay;
    if (typeof body.startTime === "string") data.startTime = mergedStart;
    if (typeof body.endTime === "string") data.endTime = mergedEnd;

    // Push the edit to Google FIRST when the event is synced — the next
    // sync upserts by googleId and would otherwise revert a local-only
    // edit. Best-effort like delete: a Google failure is logged, the local
    // edit still lands (and the sync will re-align it either way).
    if (existing.googleId) {
      try {
        const result = await googleUpdateEvent(uid, existing.googleId, {
          ...(typeof title === "string" ? { summary: title } : {}),
          ...(body.description !== undefined
            ? { description: body.description as string | null }
            : {}),
          ...(body.location !== undefined ? { location: body.location as string | null } : {}),
          ...(typeof body.startTime === "string" || typeof body.endTime === "string"
            ? {
                startTime: mergedStart.toISOString(),
                endTime: mergedEnd.toISOString(),
                allDay: typeof body.allDay === "boolean" ? body.allDay : existing.allDay,
              }
            : {}),
        });
        if ("error" in result) {
          console.warn(
            "[calendar] Google update failed, proceeding with local update:",
            result.error,
          );
        }
      } catch (err) {
        console.warn("[calendar] Google update threw, proceeding with local update:", err);
        captureError(err, {
          tags: { scope: "calendar.update.google-sync" },
          extra: { userId: uid, googleId: existing.googleId },
        });
      }
    }

    const event = await prisma.calendarEvent.update({
      where: { id },
      data,
    });
    await upsertAttentionForCalendarEvent(event);
    return event;
  });

  // Delete event (local + Google Calendar sync) — Pro (calendar_write)
  app.delete("/:id", { preHandler: requireEntitled }, async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    const event = await prisma.calendarEvent.findUnique({ where: { id } });
    if (!event) return reply.code(404).send({ error: "Event not found" });
    if (event.userId !== userId) return reply.code(403).send({ error: "Forbidden" });
    if (isLinkedCalendarRow(event)) return reply.code(409).send({ error: LINKED_READ_ONLY });

    // Delete from Google Calendar if synced
    if (event.googleId) {
      try {
        await googleDeleteEvent(userId, event.googleId);
      } catch (err) {
        // Best-effort: still delete locally. But don't swallow silently — a
        // systemic Google-delete failure (token/quota/API) would otherwise be
        // invisible while events resurface on the next sync.
        console.warn("[calendar] Google delete failed, proceeding with local delete:", err);
        captureError(err, {
          tags: { scope: "calendar.delete.google-sync" },
          extra: { userId, googleId: event.googleId },
        });
      }
    }

    await prisma.calendarEvent.delete({ where: { id } });
    await deleteAttentionForCalendarEvents([id], userId);
    return reply.code(204).send();
  });

  // Sync from Google Calendar
  app.post("/sync", async (request) => {
    const uid = getUserId(request);

    // The session resolves CLIENT_ID/SECRET-backed credentials (automatic token refresh).
    const session = await connectPrimaryCalendar(uid);
    if (!session) {
      return { error: "Google not connected", synced: 0 };
    }

    try {
      // The user's stored timezone is passed both to Google (canonicalize the
      // response) AND to the defensive parser for naive strings, which together
      // remove the "naive dateTime gets parsed as server-local UTC" failure mode
      // that caused the 2026-06-04 ±N-hour shift.
      const userTimezone = await readSyncTimezone(uid);
      const synced = await syncPrimaryCalendarWindow(session, uid, userTimezone);
      return { success: true, synced };
    } catch (err) {
      if (isGoogleAuthError(err)) {
        await markGoogleTokenForReconnect(uid);
        return { error: "Google not connected. Please reconnect your Google account.", synced: 0 };
      }
      const gaxiosErr = err as {
        response?: { status?: number; data?: { error?: { message?: string; errors?: unknown[] } } };
        message?: string;
      };
      const status = gaxiosErr.response?.status;
      const apiMsg =
        gaxiosErr.response?.data?.error?.message || gaxiosErr.message || "Unknown error";
      const apiErrors = gaxiosErr.response?.data?.error?.errors;
      console.error(
        `[CALENDAR SYNC] Failed (HTTP ${status}):`,
        apiMsg,
        apiErrors ? JSON.stringify(apiErrors) : "",
      );
      return { error: `Sync failed (${status}): ${apiMsg}`, synced: 0 };
    }
  });

  // Today's schedule summary
  app.get("/today/summary", async (request) => {
    const uid = getUserId(request);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const events = dedupeCalendarEvents(
      await prisma.calendarEvent.findMany({
        where: {
          userId: uid,
          startTime: { gte: todayStart, lte: todayEnd },
        },
        orderBy: { startTime: "asc" },
      }),
    );

    const now = new Date();
    const upcoming = events.filter((e: { startTime: Date }) => e.startTime > now);
    const current = events.find(
      (e: { startTime: Date; endTime: Date }) => e.startTime <= now && e.endTime > now,
    );

    return {
      total: events.length,
      current: current || null,
      upcoming,
      nextEvent: upcoming[0] || null,
    };
  });
}
