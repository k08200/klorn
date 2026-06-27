/**
 * Autonomous agent scheduler — wraps the per-user agent (`runAgentForUser`)
 * in the global loop machinery: tick interval, per-user throttling, stale
 * pending-action expiry, idle-user gating, and lifecycle (start/stop).
 *
 * Split out of autonomous-agent.ts so the per-user reasoning brain
 * (~1300 lines) stays separate from the cron-style loop that drives it.
 * Public callers (index.ts) import startAutonomousAgent from this file.
 */

import { isUserIdleForAgent } from "./agent-idle.js";
import { type AgentMode, normalizeAgentMode } from "./agent-mode.js";
import { bulkResolveAttentionForPendingActions } from "./attention-mirror.js";
import { runAgentForUser } from "./autonomous-agent.js";
import { AGENT_CHECK_INTERVAL_MS, AGENT_IDLE_THRESHOLD_MS } from "./config.js";
import { db, prisma } from "./db.js";
import { recipientFromToolArgs, recordFeedback } from "./feedback.js";
import { openai } from "./openai.js";
import { captureError } from "./sentry.js";
import { planHasFeature } from "./stripe.js";

const CHECK_INTERVAL_MS = AGENT_CHECK_INTERVAL_MS;
const CONCURRENCY_LIMIT = 5; // Max users to run concurrently
const PENDING_ACTION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — expire faster to prevent blocking

let intervalId: ReturnType<typeof setInterval> | null = null;

// Track last run per user to respect per-user interval. Module-local so the
// schedule survives across ticks but resets on process restart, which is
// fine because the per-user agentIntervalMin is the actual policy.
const lastRunTime = new Map<string, number>();

/** Expire stale pending actions — prevents deadlock when user ignores proposals */
async function expireStalePendingActions() {
  try {
    const cutoff = new Date(Date.now() - PENDING_ACTION_TTL_MS);
    type ExpiringRow = {
      id: string;
      userId: string;
      toolName: string;
      toolArgs: string;
      conversationId: string;
    };
    const expiringRows = (await db.pendingAction.findMany({
      where: { status: "PENDING", createdAt: { lt: cutoff } },
      select: { id: true, userId: true, toolName: true, toolArgs: true, conversationId: true },
    })) as ExpiringRow[];
    const expired = await db.pendingAction.updateMany({
      where: { status: "PENDING", createdAt: { lt: cutoff } },
      data: {
        status: "REJECTED",
        result: `Auto-expired after ${PENDING_ACTION_TTL_MS / (60 * 60 * 1000)}h`,
      },
    });
    if (expired.count > 0) {
      console.log(`[AGENT] Expired ${expired.count} stale pending action(s)`);
      await bulkResolveAttentionForPendingActions(
        expiringRows.map((r: ExpiringRow) => r.id),
        "REJECTED",
      );
      // IGNORED is a distinct policy signal from REJECTED — the user didn't
      // say no, they just never showed up. Step 8.2 will weight these
      // differently when extracting "this user ignores X" rules.
      await Promise.all(
        expiringRows.map((row: ExpiringRow) =>
          recordFeedback({
            userId: row.userId,
            source: "PENDING_ACTION",
            sourceId: row.id,
            signal: "IGNORED",
            toolName: row.toolName,
            recipient: recipientFromToolArgs(row.toolArgs),
            threadId: row.conversationId,
          }),
        ),
      );
    }
  } catch (err) {
    // Best-effort cleanup that never blocks the agent loop — but a swallowed
    // failure here strands stale PENDING actions (deadlocking the loop) and
    // loses the IGNORED feedback signal, so leave a trace. console is the
    // signal when Sentry is off (captureError is then a no-op).
    console.error("[AGENT] expireStalePendingActions failed:", err);
    captureError(err, { tags: { scope: "agent.expire-pending" } });
  }
}

/** Main scheduler loop — checks all users, respects per-user interval */
async function runAutonomousAgent() {
  // Expire stale pending actions before running new cycles
  await expireStalePendingActions();

  // DB-based dedup — no in-memory pruning needed

  try {
    const configs = await prisma.automationConfig.findMany();

    // Prune lastRunTime for users no longer in configs (prevents unbounded growth)
    const activeUserIds = new Set(configs.map((c) => c.userId));
    for (const userId of lastRunTime.keys()) {
      if (!activeUserIds.has(userId)) lastRunTime.delete(userId);
    }
    if (configs.length === 0) return;

    const now = Date.now();

    // Fetch user plans for feature gating, plus the latest device.lastActiveAt
    // per user so we can skip background cycles for abandoned/idle accounts.
    const userIds = configs.map((c) => c.userId);
    const [users, latestDevices] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, plan: true },
      }),
      prisma.device.groupBy({
        by: ["userId"],
        where: { userId: { in: userIds } },
        _max: { lastActiveAt: true },
      }),
    ]);
    const userPlanMap = new Map(users.map((u) => [u.id, u.plan]));
    const lastActiveMap = new Map<string, Date | null>(
      latestDevices.map((row) => [row.userId, row._max.lastActiveAt ?? null]),
    );

    // Filter users that are due for a run
    const usersToRun: Array<{ userId: string; mode: AgentMode }> = [];
    let idleSkipped = 0;
    for (const config of configs) {
      const cfg = config as unknown as Record<string, unknown>;
      // Opt-in: run the proactive loop only when explicitly enabled. The column
      // is a non-nullable Boolean today (so this equals `=== false`), but `!==
      // true` keeps the gate correct if the field is ever absent/null — a
      // missing flag must mean OFF, matching the classify-only default.
      if (cfg.autonomousAgent !== true) continue;

      // Plan-based gating: autonomous agent requires PRO+ plan
      const userPlan = userPlanMap.get(config.userId) || "FREE";
      if (!planHasFeature(userPlan, "autonomous_agent")) {
        continue;
      }

      // Idle-user gating: don't burn shared free-tier quota on accounts that
      // haven't touched the app in `AGENT_IDLE_THRESHOLD_MS`. Mostly catches
      // abandoned signups but also gracefully handles users on vacation.
      if (isUserIdleForAgent(lastActiveMap.get(config.userId), { now })) {
        idleSkipped++;
        continue;
      }

      const intervalMs = ((cfg.agentIntervalMin as number) || 5) * 60 * 1000;
      const lastRun = lastRunTime.get(config.userId) || 0;
      if (now - lastRun < intervalMs - 30_000) continue;

      // Plan-based mode gating: AUTO mode requires TEAM+ plan
      let mode = normalizeAgentMode(cfg.agentMode);
      if (mode === "AUTO" && !planHasFeature(userPlan, "agent_mode_auto")) {
        mode = "SUGGEST"; // Downgrade to SUGGEST for PRO users
      }

      lastRunTime.set(config.userId, now);
      usersToRun.push({ userId: config.userId, mode });
    }
    if (idleSkipped > 0) {
      console.log(
        `[AGENT] Skipped ${idleSkipped} idle user(s) this tick (no activity in last ${Math.round(
          AGENT_IDLE_THRESHOLD_MS / 3600_000,
        )}h)`,
      );
    }

    // Run in parallel with concurrency limit (not sequential)
    for (let i = 0; i < usersToRun.length; i += CONCURRENCY_LIMIT) {
      const batch = usersToRun.slice(i, i + CONCURRENCY_LIMIT);
      await Promise.allSettled(
        batch.map(({ userId, mode }) =>
          runAgentForUser(userId, mode).catch((err) => {
            console.error(`[AGENT] Unhandled error for ${userId}:`, err);
            captureError(err, { tags: { scope: "agent.run", userId } });
          }),
        ),
      );
    }
  } catch (err) {
    console.error("[AGENT] Scheduler error:", err);
    captureError(err, { tags: { scope: "agent.scheduler" } });
  }
}

/** Start the autonomous agent scheduler */
export function startAutonomousAgent() {
  if (intervalId) return;

  if (!openai) {
    console.log("[AGENT] Autonomous agent disabled — no LLM configured");
    return;
  }

  console.log("[AGENT] Autonomous agent started (checking every 60s)");

  // First run after 30 seconds
  setTimeout(() => {
    runAutonomousAgent();
  }, 30_000);

  // Check every minute, respects per-user intervals
  intervalId = setInterval(runAutonomousAgent, CHECK_INTERVAL_MS);
}

/** Stop the autonomous agent */
export function stopAutonomousAgent() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("[AGENT] Autonomous agent stopped");
  }
}
