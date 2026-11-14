/**
 * Smart actions — the one-tap flows the briefing picks and the mail reader
 * offer for one of the user's own mails (SMART_ACTIONS_ENABLED, off by default;
 * `cohort` opens them to ROLLOUT_COHORT_USER_IDS only):
 *
 *   1. Draft reply → the draft shown verbatim and editable → Send.
 *      POST /emails/:id/reply-draft returns the draft (the proactive one when
 *      Klorn already wrote it, else a fresh one) with the recipient and subject
 *      the reply will carry. POST /emails/:id/reply sends only the bytes the
 *      user saw: the client sends the body and sendEmailPayloadHash of the
 *      { to, subject, body } on screen; the server derives to/subject from the
 *      user's own row, refuses on any hash difference, and mints the
 *      deterministic-floor receipt (attention-floor.ts) before anything leaves
 *      — whatever MANUAL_SEND_RECEIPTS_ENABLED says. One send path with
 *      POST /api/email/:id/reply (mail/reply-send.ts). Nothing here is reachable
 *      from a notification: a send needs the text that was on screen.
 *   2. Add to calendar → the confirm card → Save.
 *      POST /emails/:id/event-proposal never writes. POST /emails/:id/event
 *      writes only the date, time and title the user confirmed, through the
 *      same create path as POST /api/calendar (Pro), refusing with the existing
 *      events when one already overlaps unless the user chose to add anyway.
 *
 * While the flag is off every route answers Fastify's default 404 before any
 * auth (darkRouteGate); in cohort mode a user outside it gets the same 404
 * after auth (cohortGate). Lanes never trigger any of this: each call is a tap.
 */

import type {
  SmartEventCreateResponse,
  SmartEventProposalResponse,
  SmartReplyDraftWire,
  SmartReplyRepeatRefusal,
} from "@klorn/contract";
import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { requireEntitled } from "../billing/entitlement-guard.js";
import { SMART_ACTIONS_FLAG, smartActionsLive } from "../config.js";
import { prisma } from "../db.js";
import {
  type RepeatState,
  replyEnvelopeFor,
  SEND_OUTCOME_UNKNOWN_MESSAGE,
  sendReplyToEmail,
} from "../mail/reply-send.js";
import { offeredDraftFor } from "../mail/reply-state.js";
import { SEND_RECEIPT_UNAVAILABLE_MESSAGE } from "../mail/send-receipt.js";
import { validDateKey } from "../pim/commitment-due-calendar.js";
import {
  MAX_EVENT_MINUTES,
  MIN_EVENT_MINUTES,
  overlappingEvents,
  proposeEventFromEmail,
} from "../pim/event-proposal.js";
import { localDateTimeToUtc } from "../time-zone.js";
import { getUserTimeZone } from "../user-timezone.js";
import { createUserCalendarEvent } from "./calendar.js";
import { cohortGate } from "./cohort-gate.js";
import { darkRouteGate } from "./dark-route-gate.js";
import { draftReplyForEmailId, sendReplyDraftFailure } from "./email-replies.js";

const SMART_ACTIONS_FLAGS = [SMART_ACTIONS_FLAG] as const;
/** The reminder chip's choices, in minutes before the start. */
export const REMINDER_MINUTES = [10, 30, 60] as const;
const MAX_REPLY_BODY_CHARS = 20_000;
const MINUTE_MS = 60_000;

const PAYLOAD_MISMATCH_MESSAGE =
  "This reply changed before it was sent, so nothing was sent. Review it and send again.";
const REPEAT_SEND_MESSAGE =
  "This reply already went to this mail moments ago, so it was not sent again.";
const SEND_IN_PROGRESS_MESSAGE =
  "This reply is already being sent, so it was not sent a second time. Check Sent Items in a moment.";
/** The 409 for each kind of repeat: only a send that went out is "already sent". */
const REPEAT_REFUSALS: Record<RepeatState, SmartReplyRepeatRefusal> = {
  in_progress: { error: SEND_IN_PROGRESS_MESSAGE, code: "SEND_IN_PROGRESS" },
  sent: { error: REPEAT_SEND_MESSAGE, code: "ALREADY_SENT" },
  outcome_unknown: { error: SEND_OUTCOME_UNKNOWN_MESSAGE, code: "SEND_OUTCOME_UNKNOWN" },
};
const DUPLICATE_EVENT_MESSAGE = "Something is already on your calendar at this time.";
const NOT_FOUND = { error: "Email not found" };

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1, maxLength: 200 } },
} as const;

const sendBody = {
  type: "object",
  required: ["body", "payloadHash"],
  properties: {
    body: { type: "string", minLength: 1, maxLength: MAX_REPLY_BODY_CHARS },
    payloadHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
  },
} as const;

const eventBody = {
  type: "object",
  required: ["title", "date", "time", "durationMinutes"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    time: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
    durationMinutes: { type: "integer", minimum: MIN_EVENT_MINUTES, maximum: MAX_EVENT_MINUTES },
    location: { type: "string", maxLength: 200 },
    reminderMinutes: { type: "integer", enum: [...REMINDER_MINUTES] },
    allowDuplicate: { type: "boolean" },
  },
} as const;

interface EventBody {
  title: string;
  date: string;
  time: string;
  durationMinutes: number;
  location?: string;
  reminderMinutes?: number;
  allowDuplicate?: boolean;
}

/** The user's own mail by id or gmailId — never another user's. */
function ownEmail(userId: string, ref: string) {
  return { userId, OR: [{ id: ref }, { gmailId: ref }] };
}

/** A year back to five ahead: a misread or a typo outside it is refused, not written. */
const EVENT_WINDOW_PAST_MS = 366 * 86_400_000;
const EVENT_WINDOW_FUTURE_MS = 5 * 366 * 86_400_000;

function isWithinEventWindow(start: Date, nowMs: number): boolean {
  const at = start.getTime();
  return at >= nowMs - EVENT_WINDOW_PAST_MS && at <= nowMs + EVENT_WINDOW_FUTURE_MS;
}

function isRealDate(dateKey: string): boolean {
  const [year, month, day] = dateKey.split("-").map((part) => Number.parseInt(part, 10));
  return validDateKey(year, month, day) === dateKey;
}

export async function smartActionsRoutes(app: FastifyInstance) {
  app.addHook("onRequest", darkRouteGate(smartActionsLive));

  // POST /api/smart-actions/emails/:id/reply-draft — never sends.
  // One LLM call at most (none when a proactive draft exists): /reply-draft's budget.
  app.post(
    "/emails/:id/reply-draft",
    {
      preHandler: [requireAuth, cohortGate(SMART_ACTIONS_FLAGS), requireEntitled],
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { params: idParams },
    },
    async (request, reply) => {
      const uid = getUserId(request);
      const { id } = request.params as { id: string };
      const email = await prisma.emailMessage.findFirst({
        where: ownEmail(uid, id),
        select: { id: true, from: true, subject: true, proactiveDraft: true, repliedAt: true },
      });
      if (!email) return reply.code(404).send(NOT_FOUND);
      const envelope = replyEnvelopeFor(email);

      const offered = offeredDraftFor(email);
      if (offered)
        return { ...envelope, body: offered, source: "proactive" } satisfies SmartReplyDraftWire;

      let body: string | null;
      try {
        body = await draftReplyForEmailId(uid, email.id, "foreground");
      } catch (err) {
        return sendReplyDraftFailure(reply, err, { userId: uid, emailId: email.id });
      }
      if (body === null) return reply.code(404).send(NOT_FOUND);
      return { ...envelope, body, source: "generated" } satisfies SmartReplyDraftWire;
    },
  );

  // POST /api/smart-actions/emails/:id/reply — the Send tap. Body + the hash of
  // what was on screen; receipt always minted before the provider is called.
  app.post(
    "/emails/:id/reply",
    {
      preHandler: [requireAuth, cohortGate(SMART_ACTIONS_FLAGS), requireEntitled],
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: { params: idParams, body: sendBody },
    },
    async (request, reply) => {
      const uid = getUserId(request);
      const { id } = request.params as { id: string };
      const { body, payloadHash } = request.body as { body: string; payloadHash: string };
      if (!body.trim()) return reply.code(400).send({ error: "Missing required field: body" });

      const outcome = await sendReplyToEmail({
        userId: uid,
        emailRef: id,
        body,
        receipt: "required",
        route: "smart-reply",
        expectedPayloadHash: payloadHash,
      });
      switch (outcome.kind) {
        case "not_found":
          return reply.code(404).send(NOT_FOUND);
        case "payload_mismatch":
          // 412: the precondition (the hash of what was shown) failed — told
          // apart from 409, the provider refusing a send.
          return reply.code(412).send({ error: PAYLOAD_MISMATCH_MESSAGE });
        case "repeat":
          return reply.code(409).send(REPEAT_REFUSALS[outcome.state]);
        case "receipt_unavailable":
          return reply.code(503).send({ error: SEND_RECEIPT_UNAVAILABLE_MESSAGE });
        case "outcome_unknown":
          return reply.code(502).send({ error: SEND_OUTCOME_UNKNOWN_MESSAGE });
        case "unsupported":
          return reply.code(501).send({ error: outcome.error });
        case "refused":
          return reply.code(409).send(outcome.result);
        case "sent":
          return outcome.response;
      }
    },
  );

  // POST /api/smart-actions/emails/:id/event-proposal — reads only, never writes.
  // Open to the free tier like POST /api/calendar/parse-event; the Save is Pro.
  app.post(
    "/emails/:id/event-proposal",
    {
      preHandler: [requireAuth, cohortGate(SMART_ACTIONS_FLAGS)],
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { params: idParams },
    },
    async (request, reply) => {
      const uid = getUserId(request);
      const { id } = request.params as { id: string };
      const email = await prisma.emailMessage.findFirst({
        where: ownEmail(uid, id),
        select: { subject: true, body: true, receivedAt: true },
      });
      if (!email) return reply.code(404).send(NOT_FOUND);
      return {
        proposal: await proposeEventFromEmail(uid, email),
      } satisfies SmartEventProposalResponse;
    },
  );

  // POST /api/smart-actions/emails/:id/event — the Save tap on the confirm card:
  // the user-confirmed date, time and title, written in the user's timezone.
  app.post(
    "/emails/:id/event",
    {
      preHandler: [requireAuth, cohortGate(SMART_ACTIONS_FLAGS), requireEntitled],
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: { params: idParams, body: eventBody },
    },
    async (request, reply) => {
      const uid = getUserId(request);
      const { id } = request.params as { id: string };
      const input = request.body as EventBody;
      const title = input.title.trim();
      if (!title) return reply.code(400).send({ error: "title is required" });
      if (!isRealDate(input.date))
        return reply.code(400).send({ error: "date is not a real date" });

      const email = await prisma.emailMessage.findFirst({
        where: ownEmail(uid, id),
        select: { id: true },
      });
      if (!email) return reply.code(404).send(NOT_FOUND);

      const timeZone = await getUserTimeZone(uid);
      const start = localDateTimeToUtc(input.date, input.time, timeZone);
      const end = new Date(start.getTime() + input.durationMinutes * MINUTE_MS);
      if (!isWithinEventWindow(start, Date.now())) {
        return reply.code(400).send({ error: "date is outside the calendar window" });
      }
      if (input.allowDuplicate !== true) {
        const existing = await overlappingEvents(uid, start, end);
        if (existing.length > 0) {
          return reply.code(409).send({ error: DUPLICATE_EVENT_MESSAGE, existing });
        }
      }

      const { event, googleId } = await createUserCalendarEvent(uid, {
        title,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        location: input.location?.trim() || undefined,
        allDay: false,
        attendees: [],
        ...(input.reminderMinutes !== undefined ? { reminderMinutes: input.reminderMinutes } : {}),
      });
      return {
        event: {
          id: event.id,
          title: event.title,
          startTime: event.startTime.toISOString(),
          endTime: event.endTime.toISOString(),
        },
        reminderSet: input.reminderMinutes !== undefined && googleId !== null,
        timeZone,
      } satisfies SmartEventCreateResponse;
    },
  );
}
