/**
 * Calendar API — Manage events and schedule
 *
 * Provides local calendar events stored in DB + optional Google Calendar sync.
 */
import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { requireAppAccess, requireEntitled } from "../billing/entitlement-guard.js";
import { prisma } from "../db.js";
import { parseGoogleDateTime } from "../google-calendar-time.js";
import {
  deleteAttentionForCalendarEvents,
  upsertAttentionForCalendarEvent,
} from "../judge/attention-mirror.js";
import { getAuthedClient, isGoogleAuthError, markGoogleTokenForReconnect } from "../mail/gmail.js";
import {
  createEvent as googleCreateEvent,
  deleteEvent as googleDeleteEvent,
} from "../pim/calendar.js";
import { buildMeetingPrepPack } from "../pim/meeting-prep-pack.js";
import { captureError } from "../sentry.js";
import { normalizeTimeZone } from "../time-zone.js";

export async function calendarRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  // Usable free tier: reading the calendar + conflict/prep views is core free
  // value, so admit any non-hard-walled user. Event writes (create/update/
  // delete) keep their OWN per-route requireEntitled below (calendar_write is
  // Pro). No-op pre-launch.
  app.addHook("preHandler", requireAppAccess);

  // List events — supports ?start=ISO&end=ISO or ?days=N (from today)
  app.get("/", async (request) => {
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

    const events = await prisma.calendarEvent.findMany({
      where: {
        userId: uid,
        startTime: { gte: rangeStart, lte: rangeEnd },
      },
      orderBy: { startTime: "asc" },
    });

    return { events };
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
  app.post("/parse-event", async (request, reply) => {
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
  });

  // Create event (local + Google Calendar sync) — Pro (calendar_write)
  app.post("/", { preHandler: requireEntitled }, async (request) => {
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

    const body = request.body as Record<string, unknown>;

    // Only allow safe fields — prevent userId/id overwrite
    const data: Record<string, unknown> = {};
    if (body.summary !== undefined) data.summary = body.summary;
    if (body.description !== undefined) data.description = body.description;
    if (body.location !== undefined) data.location = body.location;
    if (body.allDay !== undefined) data.allDay = body.allDay;
    if (typeof body.startTime === "string") data.startTime = new Date(body.startTime);
    if (typeof body.endTime === "string") data.endTime = new Date(body.endTime);

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

    // Use getAuthedClient which includes CLIENT_ID/SECRET for automatic token refresh
    const auth = await getAuthedClient(uid);
    if (!auth) {
      return { error: "Google not connected", synced: 0 };
    }

    try {
      const { google } = await import("googleapis");

      const calendar = google.calendar({ version: "v3", auth });
      const now = new Date();
      const later = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // next 30 days

      // Fetch the user's stored timezone so we can pass it both to Google
      // (canonicalize the response) AND to our naive-string fallback parser.
      const userRow = (await prisma.user.findUnique({ where: { id: uid } })) as {
        timezone?: string | null;
      } | null;
      const userTimezone = normalizeTimeZone(userRow?.timezone);

      const response = await calendar.events.list({
        calendarId: "primary",
        timeMin: now.toISOString(),
        timeMax: later.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 100,
        // Tell Google to render dateTimes in the user's zone. Combined with
        // the defensive parser below, this eliminates the "naive dateTime
        // gets parsed as server-local UTC" failure mode that caused the
        // 2026-06-04 ±N-hour shift.
        timeZone: userTimezone,
      });

      let synced = 0;
      for (const item of response.data.items || []) {
        const googleId = item.id || "";
        if (!googleId) continue;

        const startTime = item.start?.dateTime || item.start?.date || "";
        const endTime = item.end?.dateTime || item.end?.date || "";
        if (!startTime || !endTime) continue;

        // Extract meeting link
        let meetingLink: string | null = null;
        if (item.conferenceData?.entryPoints) {
          const video = item.conferenceData.entryPoints.find((e) => e.entryPointType === "video");
          if (video) meetingLink = video.uri || null;
        }
        if (!meetingLink && item.hangoutLink) meetingLink = item.hangoutLink;

        const isTimed = Boolean(item.start?.dateTime);
        const data = {
          userId: uid,
          title: item.summary || "Untitled",
          description: item.description || null,
          startTime: isTimed
            ? parseGoogleDateTime(startTime, item.start?.timeZone ?? null, userTimezone)
            : new Date(startTime),
          endTime: isTimed
            ? parseGoogleDateTime(endTime, item.end?.timeZone ?? null, userTimezone)
            : new Date(endTime),
          location: item.location || null,
          meetingLink,
          allDay: !isTimed,
          googleId,
        };

        // Upsert by (userId, googleId) — the same Google event can live in two
        // users' calendars, so the match must be scoped to this user.
        await prisma.calendarEvent.upsert({
          where: { userId_googleId: { userId: uid, googleId } },
          create: data,
          update: {
            title: data.title,
            description: data.description,
            startTime: data.startTime,
            endTime: data.endTime,
            location: data.location,
            meetingLink: data.meetingLink,
            allDay: data.allDay,
          },
        });
        synced++;
      }

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

    const events = await prisma.calendarEvent.findMany({
      where: {
        userId: uid,
        startTime: { gte: todayStart, lte: todayEnd },
      },
      orderBy: { startTime: "asc" },
    });

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
