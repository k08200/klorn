/**
 * Who a team_availability tool call covers. Two sources, each behind its own
 * flag: the user's saved teams and ad-hoc address lists (team mode,
 * TEAM_MODE_ENABLED: Google free/busy of addresses the user names) and the
 * user's Klorn organization (TEAMS_ENABLED: co-members, under their own
 * free/busy grant). With only TEAMS open, the call is limited to co-members —
 * it never becomes a way to probe arbitrary addresses.
 */

import { teamModeEnabled, teamsOpenTo } from "../config.js";
import { prisma } from "../db.js";
import { orgAvailabilityMembers } from "../org/org-availability.js";
import { isOrgError } from "../org/org-error.js";

/** The most members one availability query takes (team-availability.ts). */
export const MAX_TEAM_AVAILABILITY_MEMBERS = 30;

export type MembersResolution =
  | { members: string[] }
  | { error: string; code?: string; availableTeams?: string[] };

interface ToolArgs {
  team_name?: unknown;
  members?: unknown;
  org_members?: unknown;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

async function orgMembers(userId: string, args: ToolArgs): Promise<MembersResolution> {
  if (!teamsOpenTo(userId)) {
    return { error: "Organizations are not available on this account." };
  }
  const requested = args.org_members === true ? undefined : stringList(args.members);
  if (args.org_members !== true && (requested === undefined || requested.length === 0)) {
    return { error: "Pass org_members: true, or members of your organization." };
  }
  let members: string[];
  try {
    members = await orgAvailabilityMembers(userId, requested);
  } catch (err) {
    if (isOrgError(err)) return { error: err.message, code: err.code };
    throw err;
  }
  if (members.length === 0) return { error: "The organization has no other members yet." };
  if (members.length > MAX_TEAM_AVAILABILITY_MEMBERS) {
    return {
      error: `More than ${MAX_TEAM_AVAILABILITY_MEMBERS} members: pass up to ${MAX_TEAM_AVAILABILITY_MEMBERS} of them in members.`,
    };
  }
  return { members };
}

async function savedTeamMembers(userId: string, teamName: string): Promise<MembersResolution> {
  const teams = await prisma.team.findMany({
    where: { userId },
    select: { name: true, members: true },
  });
  const wanted = teamName.trim().toLowerCase();
  const team = teams.find((t) => t.name.toLowerCase() === wanted);
  if (!team) {
    return {
      error: `No saved team named "${teamName}".`,
      availableTeams: teams.map((t) => t.name),
    };
  }
  return { members: stringList(team.members) ?? [] };
}

export async function teamAvailabilityMembers(
  userId: string,
  args: ToolArgs,
): Promise<MembersResolution> {
  if (args.org_members === true || !teamModeEnabled()) return orgMembers(userId, args);
  if (typeof args.team_name === "string" && args.team_name.trim()) {
    return savedTeamMembers(userId, args.team_name);
  }
  return { members: stringList(args.members) ?? [] };
}
