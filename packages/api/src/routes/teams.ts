/**
 * Teams — named member groups for team-mode availability (P1).
 *
 * Plain owner-scoped CRUD: a team is a name plus a list of bare member
 * emails, consumed by the assistant's team_availability tool and the
 * meeting flows. No cross-user sharing in P1/P2 (that is the org model,
 * docs/design/team-mode-v3.md).
 */

import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { teamModeEnabled } from "../config.js";
import { prisma } from "../db.js";
import { getTeamAvailability } from "../pim/team-availability.js";

const NAME_MAX = 80;
const MEMBER_MAX = 30;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{1,63}$/;

/** Normalize + validate a member list; null = invalid input. */
export function normalizeMembers(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const members = [
    ...new Set(
      raw
        .filter((m): m is string => typeof m === "string")
        .map((m) => m.trim().toLowerCase())
        .filter((m) => m.length > 0),
    ),
  ];
  if (members.length === 0 || members.length > MEMBER_MAX) return null;
  if (!members.every((m) => EMAIL_RE.test(m))) return null;
  return members;
}

export async function teamRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  // Team mode is a paid team-tier capability shipped dark (config.ts).
  // 403 TEAM_REQUIRED (not 404): clients use it to hide every team surface.
  app.addHook("preHandler", async (_request, reply) => {
    if (!teamModeEnabled()) {
      return reply.code(403).send({ error: "Team mode is not enabled.", code: "TEAM_REQUIRED" });
    }
  });

  // GET /api/teams — the user's teams.
  app.get("/", async (request) => {
    const userId = getUserId(request);
    const teams = await prisma.team.findMany({
      where: { userId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, members: true, updatedAt: true },
    });
    return { teams };
  });

  // POST /api/teams — create one.
  app.post("/", async (request, reply) => {
    const userId = getUserId(request);
    const body = (request.body ?? {}) as { name?: unknown; members?: unknown };
    const name = typeof body.name === "string" ? body.name.trim().slice(0, NAME_MAX) : "";
    const members = normalizeMembers(body.members);
    if (!name) return reply.code(400).send({ error: "Team name is required." });
    if (!members) {
      return reply
        .code(400)
        .send({ error: `members must be 1–${MEMBER_MAX} valid email addresses.` });
    }
    try {
      const team = await prisma.team.create({
        data: { userId, name, members },
        select: { id: true, name: true, members: true },
      });
      return team;
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") {
        return reply.code(409).send({ error: "A team with this name already exists." });
      }
      throw err;
    }
  });

  // PATCH /api/teams/:id — rename / replace members.
  app.patch("/:id", async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { name?: unknown; members?: unknown };

    const existing = await prisma.team.findFirst({ where: { id, userId }, select: { id: true } });
    if (!existing) return reply.code(404).send({ error: "Team not found" });

    const data: { name?: string; members?: string[] } = {};
    if (body.name !== undefined) {
      const name = typeof body.name === "string" ? body.name.trim().slice(0, NAME_MAX) : "";
      if (!name) return reply.code(400).send({ error: "Team name is required." });
      data.name = name;
    }
    if (body.members !== undefined) {
      const members = normalizeMembers(body.members);
      if (!members) {
        return reply
          .code(400)
          .send({ error: `members must be 1–${MEMBER_MAX} valid email addresses.` });
      }
      data.members = members;
    }
    const team = await prisma.team.update({
      where: { id },
      data,
      select: { id: true, name: true, members: true },
    });
    return team;
  });

  // GET /api/teams/:id/availability — common free slots for the saved team
  // (the dedicated team screen's data source; the chat tool remains for
  // ad-hoc member lists). Same Google free/busy semantics: invisible
  // members come back in unknownMembers, never assumed free.
  app.get(
    "/:id/availability",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const userId = getUserId(request);
      const { id } = request.params as { id: string };
      const q = request.query as {
        window_start?: string;
        window_end?: string;
        duration_minutes?: string;
      };
      const team = await prisma.team.findFirst({
        where: { id, userId },
        select: { members: true },
      });
      if (!team) return reply.code(404).send({ error: "Team not found" });
      const members = Array.isArray(team.members)
        ? team.members.filter((m): m is string => typeof m === "string")
        : [];
      const duration = Number.parseInt(q.duration_minutes ?? "60", 10);
      const result = await getTeamAvailability(
        userId,
        members,
        q.window_start ?? "",
        q.window_end ?? "",
        Number.isFinite(duration) && duration > 0 ? Math.min(duration, 480) : 60,
      );
      if ("error" in result) return reply.code(400).send(result);
      return result;
    },
  );

  // DELETE /api/teams/:id
  app.delete("/:id", async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    const existing = await prisma.team.findFirst({ where: { id, userId }, select: { id: true } });
    if (!existing) return reply.code(404).send({ error: "Team not found" });
    await prisma.team.delete({ where: { id } });
    return { deleted: true };
  });
}
