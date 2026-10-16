/**
 * POST /api/auth/link/complete { handle } — finish an account-link OAuth flow
 * with the session of the client that started it.
 *
 * The link callbacks park the authorization code under a single-use handle
 * (routes/link-handoff.ts). Only here is the code exchanged, and only when the
 * caller's session user is the user who started the flow. A different session
 * gets 409: the parked entry is dropped, the code is never exchanged, nothing
 * is written, and the attempt is reported. That closes account-linking CSRF:
 * a consent URL sent to a victim can no longer attach the victim's account to
 * the sender's.
 *
 * `next` is always a relative path from the fixed set the flows below return,
 * never caller input.
 */

import type { FastifyInstance } from "fastify";
import {
  LINK_FLOW_PATHS,
  type LinkFinish,
  type LinkMarker,
  takePendingLink,
} from "../auth/pending-links.js";
import { getUserId, requireAuth } from "../auth.js";
import { outlookCalendarEnabled, outlookInboxEnabled } from "../config.js";
import { captureError } from "../sentry.js";
import { exchangeAndFinishGoogleLink } from "./google-link-finish.js";
import { finishOutlookInboxLink } from "./outlook-auth.js";
import { finishOutlookCalendarLink } from "./outlook-calendar-link.js";

const NOT_FOUND = {
  error: "This connection link has expired or was already used. Please start again.",
  // Tells the page "expired" apart from a finisher's own 404 (a primary connect
  // whose user is gone answers { error: "User not found" }, unchanged).
  code: "LINK_EXPIRED",
} as const;

const completeBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["handle"],
  properties: {
    handle: { type: "string", pattern: "^[0-9a-f]{64}$" },
  },
} as const;

interface LinkFlow {
  readonly finish: (userId: string, code: string) => Promise<LinkFinish>;
}

export function linkCompleteRoutes(
  opts: {
    /** Defaults to OUTLOOK_INBOX_ENABLED, the gate of the Outlook inbox routes. */
    outlookInboxGate?: () => boolean;
    /** Defaults to OUTLOOK_CALENDAR_ENABLED + OUTLOOK_INBOX_ENABLED. */
    outlookCalendarGate?: () => boolean;
  } = {},
): (app: FastifyInstance) => Promise<void> {
  const inboxGate = opts.outlookInboxGate ?? outlookInboxEnabled;
  const calendarGate = opts.outlookCalendarGate ?? outlookCalendarEnabled;

  const FLOWS: Record<LinkMarker, LinkFlow> = {
    __oauth_state__: {
      finish: (userId, code) => exchangeAndFinishGoogleLink("__oauth_state__", userId, code),
    },
    __link_calendar__: {
      finish: (userId, code) => exchangeAndFinishGoogleLink("__link_calendar__", userId, code),
    },
    __link_inbox__: {
      finish: (userId, code) => exchangeAndFinishGoogleLink("__link_inbox__", userId, code),
    },
    __link_outlook__: {
      // The Outlook surface is dark while its flag is off (CASA surface
      // freeze): a link parked before the flag went off is never exchanged.
      finish: async (userId, code) => ({
        next: inboxGate() ? await finishOutlookInboxLink(userId, code) : "/settings?inbox=failed",
      }),
    },
    __link_outlook_calendar__: {
      finish: async (userId, code) => ({
        next: await finishOutlookCalendarLink({ code, userId, enabled: calendarGate() }),
      }),
    },
  };

  return async function routes(app: FastifyInstance) {
    app.post(
      "/link/complete",
      {
        preHandler: requireAuth,
        schema: { body: completeBodySchema },
        config: { rateLimit: { max: 20, timeWindow: "15 minutes" } },
      },
      async (request, reply) => {
        const { handle } = request.body as { handle: string };
        // Taken (deleted) before anything else: whatever happens next, this
        // handle can never be presented again.
        const link = takePendingLink(handle);
        if (!link) return reply.code(404).send(NOT_FOUND);
        const flow = FLOWS[link.marker];
        const sessionUserId = getUserId(request);
        if (sessionUserId !== link.userId) {
          console.warn(
            `[LINK-CSRF] ${link.marker} started by ${link.userId} was completed by ${sessionUserId}; dropped without exchanging the code`,
          );
          captureError(new Error("account link completed by a different session"), {
            tags: { scope: "auth.link.mismatch" },
            extra: { startedBy: link.userId, completedBy: sessionUserId, marker: link.marker },
          });
          // The bare page, no result marker: the completion page shows its own
          // mismatch message, so no failure toast may stack on top of it.
          return reply.code(409).send({ next: LINK_FLOW_PATHS[link.marker].base });
        }
        const result = await flow.finish(link.userId, link.code);
        if ("next" in result) return reply.send({ next: result.next });
        return reply.code(result.status).send({ error: result.error });
      },
    );
  };
}
