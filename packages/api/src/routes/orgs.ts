/**
 * /api/orgs — Klorn Teams v1 (docs/design/pricing-tiers.md "Team (company)
 * plan", docs/design/team-mode-v3.md). Organizations, members, invites by
 * email, the member's free/busy grant, org availability, admin ceilings, the
 * audit log and the member transparency view.
 *
 * Dark behind TEAMS_ENABLED (config.ts): off → every route answers Fastify's
 * default 404, even unauthenticated; cohort → only ROLLOUT_COHORT_USER_IDS.
 * Admin actions are OWNER-only (never a role named ADMIN, which means a Klorn
 * operator in User.role). No route here returns or reads a member's mail,
 * attention items or commitments (org-privacy-guard.test.ts).
 */

import type { FastifyError, FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { TEAMS_FLAG, teamsLive } from "../config.js";
import { handleError } from "../error-handler.js";
import { orgAvailabilityMembers } from "../org/org-availability.js";
import { isOrgError, OrgError } from "../org/org-error.js";
import {
  acceptInvite,
  inviteMember,
  listInvites,
  previewInvite,
  revokeInvite,
} from "../org/org-invites.js";
import {
  createOrganization,
  currentOrgView,
  listAudit,
  listMembers,
  requireMembership,
  setAvailabilityGrant,
  updateOrganization,
} from "../org/org-members.js";
import {
  leaveOrganization,
  removeMember,
  transferOwnership,
} from "../org/org-membership-changes.js";
import { transparencyFor } from "../org/transparency.js";
import { getTeamAvailability } from "../pim/team-availability.js";
import { cohortGate } from "./cohort-gate.js";
import { darkRouteGate } from "./dark-route-gate.js";
import { type RouteRateLimit, rateLimitHook } from "./rate-limit-hook.js";

const MAX_AVAILABILITY_MEMBERS = 30;
const DEFAULT_DURATION_MINUTES = 60;
const MAX_DURATION_MINUTES = 480;

export async function orgRoutes(app: FastifyInstance) {
  app.addHook("onRequest", darkRouteGate(teamsLive));
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", cohortGate([TEAMS_FLAG]));
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (isOrgError(error)) {
      return reply.code(error.statusCode).send({ error: error.message, code: error.code });
    }
    return handleError(error, request, reply);
  });

  app.get("/current", async (request) => currentOrgView(getUserId(request)));

  // Per-user limits on top of the per-address route limits: mail-sending and
  // organization-creating routes must not scale with the number of addresses.
  const perUser = (name: string, limit: RouteRateLimit) =>
    rateLimitHook(
      app,
      limit,
      (request) => `orgs:${name}:user:${getUserId(request)}`,
      "Too many requests. Try again later.",
    );

  app.post(
    "/",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 hour" } },
      preHandler: perUser("create", { max: 5, timeWindow: "1 hour" }),
    },
    async (request, reply) => {
      reply.code(201);
      return createOrganization(getUserId(request), request.body);
    },
  );

  app.patch("/current", async (request) => updateOrganization(getUserId(request), request.body));

  app.get("/current/members", async (request) => ({
    members: await listMembers(getUserId(request)),
  }));

  app.delete("/current/members/:membershipId", async (request) => {
    const { membershipId } = request.params as { membershipId: string };
    return removeMember(getUserId(request), membershipId);
  });

  app.post("/current/transfer", async (request) =>
    transferOwnership(getUserId(request), request.body),
  );

  app.post("/current/leave", async (request) => leaveOrganization(getUserId(request)));

  app.post(
    "/current/invites",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 hour" } },
      preHandler: perUser("invite", { max: 30, timeWindow: "1 hour" }),
    },
    async (request, reply) => {
      reply.code(201);
      return { invite: await inviteMember(getUserId(request), request.body) };
    },
  );

  app.get("/current/invites", async (request) => ({
    invites: await listInvites(getUserId(request)),
  }));

  app.delete("/current/invites/:inviteId", async (request) => {
    const { inviteId } = request.params as { inviteId: string };
    return revokeInvite(getUserId(request), inviteId);
  });

  // The token travels in the body, never the URL, so it stays out of logs.
  app.post(
    "/invites/preview",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => previewInvite(getUserId(request), request.body),
  );

  app.post(
    "/invites/accept",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request) => acceptInvite(getUserId(request), request.body),
  );

  app.put("/current/availability-grant", async (request) =>
    setAvailabilityGrant(getUserId(request), request.body),
  );

  // Common free slots with the organization's members. Members who have not
  // shared free/busy (and whom the user's Google calendar cannot see) come
  // back in unknownMembers — never assumed free.
  app.get(
    "/current/availability",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request) => {
      const userId = getUserId(request);
      const q = request.query as {
        window_start?: string;
        window_end?: string;
        duration_minutes?: string;
        members?: string | string[];
      };
      const members = await orgAvailabilityMembers(userId, q.members);
      if (members.length === 0) {
        throw new OrgError(400, "NOT_A_MEMBER", "Your organization has no other members yet.");
      }
      if (members.length > MAX_AVAILABILITY_MEMBERS) {
        throw new OrgError(
          400,
          "INVALID_BODY",
          `Pick up to ${MAX_AVAILABILITY_MEMBERS} members with ?members=.`,
        );
      }
      const duration = Number.parseInt(q.duration_minutes ?? "", 10);
      const result = await getTeamAvailability(
        userId,
        members,
        q.window_start ?? "",
        q.window_end ?? "",
        Number.isFinite(duration) && duration > 0
          ? Math.min(duration, MAX_DURATION_MINUTES)
          : DEFAULT_DURATION_MINUTES,
      );
      if ("error" in result) throw new OrgError(400, "INVALID_BODY", result.error);
      return result;
    },
  );

  app.get("/current/transparency", async (request) => {
    const userId = getUserId(request);
    await requireMembership(userId);
    return transparencyFor(userId);
  });

  // ?kind=admin leaves out the free/busy reads; ?before=<event id> pages back.
  app.get("/current/audit", async (request) =>
    listAudit(getUserId(request), request.query as { kind?: unknown; before?: unknown }),
  );
}
