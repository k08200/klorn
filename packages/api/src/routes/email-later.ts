/**
 * POST /api/email/:id/later — the in-app "Later": a reminder about one mail
 * (Mail v2 rows, the reader, the legacy list, the Today cards). Registered by
 * emailRoutes() against the `/api/email` prefix, so it inherits that plugin's
 * requireAuth + requireAppAccess hooks.
 *
 * The client sends only the time it chose (later today / tomorrow 09:00 /
 * next week 09:00 in its own time zone); the title and the mail link are
 * written server-side by the service the web push Later shares
 * (pim/mail-reminder.ts), so a reminder looks the same wherever it was set.
 */

import type { FastifyInstance } from "fastify";
import { getUserId } from "../auth.js";
import { noteEmailOutcome } from "../judge/user-outcome.js";
import { PUSH_LATER_HOURS } from "../notify/push-later.js";
import { setMailReminder } from "../pim/mail-reminder.js";
import { captureError } from "../sentry.js";
import { rateLimitHook } from "./rate-limit-hook.js";

const HOUR_MS = 3_600_000;
/** The furthest ahead a mail reminder may be set. */
export const MAIL_REMINDER_MAX_DAYS = 30;
const MAX_AHEAD_MS = MAIL_REMINDER_MAX_DAYS * 24 * HOUR_MS;

/** A busy triage session sets a few; a scripted loop is cut off well before it hurts. */
export const MAIL_LATER_USER_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const;

const laterParamsSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1, maxLength: 128 } },
} as const;

const laterBodySchema = {
  type: ["object", "null"],
  additionalProperties: false,
  properties: { remindAt: { type: "string", format: "date-time", maxLength: 64 } },
} as const;

/** The reminder time, or a reason it is refused: in the future and at most 30 days out. */
function resolveRemindAt(raw: string | undefined, now: Date): Date | null {
  if (raw === undefined) return new Date(now.getTime() + PUSH_LATER_HOURS * HOUR_MS);
  const at = new Date(raw);
  const ahead = at.getTime() - now.getTime();
  if (!Number.isFinite(ahead) || ahead <= 0 || ahead > MAX_AHEAD_MS) return null;
  return at;
}

export function registerEmailLaterRoutes(app: FastifyInstance) {
  const userLimit = rateLimitHook(
    app,
    MAIL_LATER_USER_RATE_LIMIT,
    (request) => `email:later:user:${getUserId(request)}`,
    "Too many reminders. Try again shortly.",
  );

  app.post(
    "/:id/later",
    {
      schema: { params: laterParamsSchema, body: laterBodySchema },
      preHandler: userLimit,
    },
    async (request, reply) => {
      const userId = getUserId(request);
      const { id } = request.params as { id: string };
      const { remindAt: raw } = (request.body ?? {}) as { remindAt?: string };

      const remindAt = resolveRemindAt(raw, new Date());
      if (!remindAt) {
        return reply
          .code(400)
          .send({ error: `remindAt must be in the next ${MAIL_REMINDER_MAX_DAYS} days` });
      }

      try {
        const result = await setMailReminder(userId, id, remindAt, { onPending: "move" });
        if (!result.ok) return reply.code(404).send({ error: "Email not found" });
        // ok means `id` is the user's own EmailMessage id (setMailReminder looks
        // it up by id and userId). A repeat Later is the same signal; first wins.
        noteEmailOutcome(userId, id, "SNOOZED");
        return { ok: true, created: result.created, reminder: result.reminder };
      } catch (err) {
        captureError(err, { tags: { scope: "email.later" }, extra: { emailId: id } });
        return reply.code(500).send({ error: "Could not set the reminder" });
      }
    },
  );
}
