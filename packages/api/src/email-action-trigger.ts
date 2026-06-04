/**
 * Immediate agent trigger when an incoming email lands in an actionable tier
 * (PUSH or QUEUE). Bypasses the 5-minute autonomous-agent-scheduler cron so
 * a meeting request the user just received turns into a PendingAction in
 * seconds, not minutes.
 *
 * Debounced per user to keep LLM cost bounded: at most one agent run per
 * user inside DEBOUNCE_MS, no matter how many actionable emails arrive in
 * that window. The agent itself walks the recent-emails context, so a single
 * run handles every recently arrived email together.
 *
 * SHADOW mode is still honored — the agent runs in whatever mode the user
 * configured. SHADOW callers create PendingActions silently (no notification)
 * but they still appear in the decision queue, which is the desired behavior.
 */

import { normalizeAgentMode } from "./agent-mode.js";
import { runAgentForUser } from "./autonomous-agent.js";
import { prisma } from "./db.js";
import type { PocTier } from "./poc-judge.js";

const DEBOUNCE_MS = 60_000;
const ACTIONABLE_TIERS: ReadonlySet<PocTier> = new Set<PocTier>(["PUSH", "QUEUE"]);

const lastTriggerAt = new Map<string, number>();

export function scheduleAgentForActionableEmail(userId: string, tier: PocTier): void {
  if (!ACTIONABLE_TIERS.has(tier)) return;

  const now = Date.now();
  const previous = lastTriggerAt.get(userId);
  if (previous !== undefined && now - previous < DEBOUNCE_MS) return;
  lastTriggerAt.set(userId, now);

  setImmediate(() => {
    runAgentForActionableEmail(userId).catch((err) => {
      console.warn(`[AGENT] Immediate trigger failed for ${userId}:`, err);
    });
  });
}

async function runAgentForActionableEmail(userId: string): Promise<void> {
  const config = (await prisma.automationConfig.findUnique({
    where: { userId },
    select: { agentMode: true, autonomousAgent: true },
  })) as { agentMode?: string; autonomousAgent?: boolean } | null;

  if (config && config.autonomousAgent === false) return;

  const mode = normalizeAgentMode(config?.agentMode);
  await runAgentForUser(userId, mode);
}

/** Test-only: clear in-memory debounce state between cases. */
export function __resetEmailActionTriggerState(): void {
  lastTriggerAt.clear();
}
