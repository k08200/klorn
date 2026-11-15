/**
 * Admin ceilings (Klorn Teams launch feature 5): an organization's owner can
 * turn auto-reply off and cap the agent mode for everyone in the organization,
 * the owner included. Enforced where the work happens, never only in a route:
 *   - auto-reply off: agentcore/unattended-reply-guards.ts (both unattended
 *     reply paths, before the LLM drafts) and agentcore/auto-reply-send.ts
 *     (the send floor, in case a draft raced the switch);
 *   - agent mode cap: agentcore/autonomous-agent.ts runAgentForUser, the one
 *     entry every agent run takes.
 * While TEAMS_ENABLED is closed to the user no ceiling applies and nothing is
 * read (config.ts: turning the flag off is the kill switch for the plan). A
 * failed lookup propagates: a send or an agent run is skipped rather than run
 * on a guess that no ceiling applies.
 */

import { type AgentMode, normalizeAgentMode } from "../agentcore/agent-mode.js";
import { teamsOpenTo } from "../config.js";
import { prisma } from "../db.js";

export const AGENT_MODE_CAPS = ["OFF", "SHADOW", "SUGGEST"] as const;
export type AgentModeCap = (typeof AGENT_MODE_CAPS)[number];

export interface OrgCeilings {
  autoReplyDisabled: boolean;
  agentModeCap: AgentModeCap | null;
}

const NO_CEILINGS: OrgCeilings = { autoReplyDisabled: false, agentModeCap: null };

/** OFF < SHADOW < SUGGEST < AUTO. */
const MODE_RANK: Record<AgentMode | "OFF", number> = { OFF: 0, SHADOW: 1, SUGGEST: 2, AUTO: 3 };

export function normalizeAgentModeCap(value: unknown): AgentModeCap | null {
  return AGENT_MODE_CAPS.includes(value as AgentModeCap) ? (value as AgentModeCap) : null;
}

/** The configured mode, lowered to the cap; a cap never raises a mode. */
export function capAgentMode(mode: AgentMode, cap: AgentModeCap | null): AgentMode | "OFF" {
  if (cap === null) return mode;
  return MODE_RANK[cap] < MODE_RANK[mode] ? cap : mode;
}

export async function orgCeilingsFor(userId: string): Promise<OrgCeilings> {
  if (!teamsOpenTo(userId)) return NO_CEILINGS;
  const membership = await prisma.orgMembership.findUnique({
    where: { userId },
    select: { org: { select: { autoReplyDisabled: true, agentModeCap: true } } },
  });
  if (!membership) return NO_CEILINGS;
  return {
    autoReplyDisabled: membership.org.autoReplyDisabled,
    agentModeCap: normalizeAgentModeCap(membership.org.agentModeCap),
  };
}

/** The mode an agent run actually takes for this user: theirs, under the org cap. */
export async function agentModeUnderOrgCeiling(
  userId: string,
  mode: AgentMode | string,
): Promise<AgentMode | "OFF"> {
  const { agentModeCap } = await orgCeilingsFor(userId);
  return capAgentMode(normalizeAgentMode(mode), agentModeCap);
}

/** Thrown by the send floor when the user's organization has auto-reply off. */
export class AutoReplyBlockedByOrgError extends Error {
  constructor() {
    super("Auto-reply is turned off by your organization.");
    this.name = "AutoReplyBlockedByOrgError";
  }
}
