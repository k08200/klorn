/**
 * "Waiting on" route (2026-09-18) — mail I sent that nobody answered
 * (mail/sent-messages.ts). Registered by emailRoutes() against the same
 * `/api/email` prefix, like the folder routes.
 */

import type { FastifyInstance } from "fastify";
import { getUserId } from "../auth.js";
import { WAITING_ON_DEFAULT_MIN_DAYS, waitingOnThreads } from "../mail/sent-messages.js";

const MAX_MIN_DAYS = 60;

export function registerEmailWaitingRoutes(app: FastifyInstance) {
  // ?days= is the floor: how long a message must have gone unanswered to
  // count. Garbage or out-of-range falls back to the default, never a 400 —
  // a client typo must not blank the list.
  app.get("/waiting-on", async (request) => {
    const uid = getUserId(request);
    const { days } = request.query as { days?: string };
    const parsed = Number(days);
    const minDays =
      Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_MIN_DAYS
        ? Math.floor(parsed)
        : WAITING_ON_DEFAULT_MIN_DAYS;
    const items = await waitingOnThreads(uid, { minDays });
    return { items, minDays };
  });
}
