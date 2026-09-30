/**
 * Agent lane provenance — the vocabulary shared by everything that has to tell
 * an MCP agent's lane change apart from the judge's and from a human's (step
 * A2b of docs/providers/unified-platform-plan.md).
 *
 * The rule: only a human action sets `isManualOverride` and only a human action
 * stamps the decision ledger, and nothing an agent does may feed the judge's
 * learning. An agent's change is therefore recorded in its OWN columns
 * (`AttentionItem.agentTierSetAt` / `agentTierKeyId`), and:
 *
 *  - every learning read of AttentionItem spreads `NOT_AGENT_SET` into its
 *    `where`, so an agent-set row is invisible to sender priors, tier history,
 *    correction examples and calibration;
 *  - every write that replaces the tier with a judge or human decision spreads
 *    `CLEAR_AGENT_TIER`, so a tier is never left marked as the agent's after
 *    someone else decided it.
 */

/** The five live lanes. An agent may name only these: never AUTO or CALL (retired v1 values). */
export const AGENT_SETTABLE_TIERS = ["PUSH", "MEETING", "QUEUE", "INFO", "SILENT"] as const;

export type AgentSettableTier = (typeof AGENT_SETTABLE_TIERS)[number];

const AGENT_SETTABLE_SET: ReadonlySet<string> = new Set(AGENT_SETTABLE_TIERS);

export function isAgentSettableTier(value: unknown): value is AgentSettableTier {
  return typeof value === "string" && AGENT_SETTABLE_SET.has(value);
}

/**
 * Prefix of the tierReason an agent change stamps. Display text only, never a
 * trust signal. It must never equal or start with MANUAL_OVERRIDE_PREFIX
 * (tiers.ts), which a human override stamps.
 */
export const AGENT_TIER_REASON_PREFIX = "Agent change";

export function agentTierReason(tier: AgentSettableTier): string {
  return `${AGENT_TIER_REASON_PREFIX} — moved to ${tier} by a connected agent`;
}

/** `where` fragment: rows whose tier the judge or a human decided. Every learning read spreads it. */
export const NOT_AGENT_SET = { agentTierSetAt: null } as const;

/** `data` fragment: drop agent provenance. Spread into any write that replaces the tier. */
export const CLEAR_AGENT_TIER = { agentTierSetAt: null, agentTierKeyId: null } as const;
