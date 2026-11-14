/**
 * GET /api/briefing/meeting-prep — the caller's meeting prep, read-only
 * (registered by briefingRoutes). requireAuth first, then the cohort gate: with
 * CONTEXT_MEETING_PREP_ENABLED off, or on `cohort` for a user outside the
 * cohort, a signed-in caller gets the same 404 as an unknown route. Takes no id:
 * it can only ever read the session user's own data. A failure answers 503 and
 * is logged by error class only — never the query, which carries attendee
 * addresses.
 */

import type { MeetingPrepBlock } from "@klorn/contract";
import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { CONTEXT_MEETING_PREP_FLAGS } from "../config.js";
import { cohortGate } from "../routes/cohort-gate.js";
import { buildMeetingPrep } from "./meeting-prep.js";

export function meetingPrepRoutes(app: FastifyInstance): void {
  app.get(
    "/meeting-prep",
    { preHandler: [requireAuth, cohortGate(CONTEXT_MEETING_PREP_FLAGS)] },
    async (request, reply) => {
      const now = new Date();
      try {
        const block = await buildMeetingPrep(getUserId(request), now);
        const meetingPrep: MeetingPrepBlock = block ?? {
          generatedAt: now.toISOString(),
          meetings: [],
        };
        return { meetingPrep };
      } catch (err) {
        console.warn(
          `[MEETING_PREP] route failed: ${err instanceof Error ? err.name : typeof err}`,
        );
        return reply.code(503).send({ error: "Meeting prep is unavailable right now" });
      }
    },
  );
}
