/**
 * Lane routes (productization plan P5/P6). Registered against the email
 * plugin, so they inherit its requireAuth + requireAppAccess hooks. Two
 * readers: Mail v2 (MAIL_V2) and Today (UNIFIED_HOME). While both are off the
 * route answers Fastify's own 404.
 */

import type { EmailLaneCountsResponse, LiveTier } from "@klorn/contract";
import type { FastifyInstance } from "fastify";
import { getUserId } from "../auth.js";
import { laneReadsEnabled } from "../config.js";
import { prisma } from "../db.js";
import { countEmailsByLane, foldLaneCounts, resolveInboxScope } from "../judge/email-lanes.js";
import { darkRouteGate } from "./dark-route-gate.js";

const laneCountsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    inbox: { type: "string", maxLength: 500 },
  },
} as const;

// Read on every view change and after every action; well above a busy session,
// well below a scripted loop. Same shape as the sibling email routes.
const LANE_COUNTS_RATE_LIMIT = { max: 120, timeWindow: "1 minute" } as const;

interface DemoLaneRow {
  tier: LiveTier;
  isRead: boolean;
}

export function registerEmailLaneRoutes(
  app: FastifyInstance,
  options: { demoRows: () => readonly DemoLaneRow[] },
) {
  // GET /api/email/lane-counts?inbox= — mail per lane (total + unread) for the
  // lane control: one grouped query, not one count per lane.
  app.get(
    "/lane-counts",
    {
      onRequest: darkRouteGate(laneReadsEnabled),
      schema: { querystring: laneCountsQuerySchema },
      config: { rateLimit: LANE_COUNTS_RATE_LIMIT },
    },
    async (request): Promise<EmailLaneCountsResponse> => {
      const uid = getUserId(request);
      const { inbox } = request.query as { inbox?: string };
      // Same demo switch as the list, so the control and the rows agree.
      const token = await prisma.userToken.findFirst({
        where: { userId: uid, provider: "google" },
        select: { id: true },
      });
      if (!token) {
        const rows = options
          .demoRows()
          .map((row) => ({ tier: row.tier, total: 1, unread: row.isRead ? 0 : 1 }));
        return { counts: foldLaneCounts(rows), source: "demo" };
      }
      // A linked id is checked against its owner; one that is not the caller's
      // counts nothing.
      const scope = await resolveInboxScope(uid, inbox);
      return { counts: await countEmailsByLane(uid, scope), source: "gmail" };
    },
  );
}
