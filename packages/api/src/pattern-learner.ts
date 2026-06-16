/**
 * Pattern Learner — Analyzes user behavior and learns from feedback
 *
 * Phase 4 of Autonomous Agent roadmap:
 * 1. Temporal patterns: "user creates tasks Monday mornings", "meetings usually at 2PM"
 * 2. Rejection learning: auto-save rejected proposals as FEEDBACK memories
 * 3. Action patterns: frequently used tools, common workflows
 * 4. Confidence evolution: update memory confidence based on accuracy
 * 5. Pattern summary: formatted insights injected into agent context
 *
 * Runs periodically (every 6 hours) or on-demand after proposal feedback.
 */

import type { MemoryType } from "@prisma/client";
import { PATTERN_ANALYSIS_HOURS as CFG_PATTERN_HOURS, PATTERN_MIN_OCCURRENCES } from "./config.js";
import { db, prisma } from "./db.js";
import { runFeedbackAdaptationForAllUsers } from "./feedback-adaptor.js";
import { buildInteractionGraphsForAllUsers } from "./interaction-graph.js";
import { remember } from "./memory.js";
import { detectSkillsForAllUsers } from "./skill-recorder.js";
import { planHasFeature } from "./stripe.js";

const PATTERN_ANALYSIS_HOURS = CFG_PATTERN_HOURS;
const MIN_OCCURRENCES = PATTERN_MIN_OCCURRENCES;
const AGENT_NOTIFICATION_PREFIX = "[Klorn]";
const EVE_AGENT_NOTIFICATION_PREFIX = "[Eve]";
const LEGACY_AGENT_NOTIFICATION_PREFIX = "[EV" + "E]";

// Day labels for learned-pattern descriptions. English per the English-only UI
// policy — these strings surface in the settings "learned patterns" panel and
// in the agent's context. Index 0 = Sunday (Date.getDay()).
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ─── Types ──────────────────────────────────────────────────────────────

interface TimeSlot {
  dayOfWeek: number; // 0=Sun, 6=Sat
  hour: number; // 0-23
  count: number;
}

interface ToolPattern {
  tool: string;
  count: number;
  approvalRate: number;
  commonArgs: string[];
}

export interface LearnedPattern {
  type: "temporal" | "tool_preference" | "rejection" | "workflow";
  description: string;
  confidence: number;
  evidence: number; // how many data points support this
}

// ─── Rejection Learning ─────────────────────────────────────────────────

/**
 * When a proposal is rejected, auto-save the lesson as a FEEDBACK memory.
 * Called from the approve/reject route handler.
 */
export async function learnFromRejection(
  userId: string,
  toolName: string,
  reasoning: string | null,
  rejectionReason: string | null,
): Promise<void> {
  try {
    // Check if we already learned this lesson
    const existingMemory = await db.memory.findFirst({
      where: {
        userId,
        type: "FEEDBACK",
        key: { startsWith: `rejected_${toolName}` },
        content: { contains: toolName },
      },
    });

    // Count rejections for this tool type
    const rejectionCount = await db.pendingAction.count({
      where: {
        userId,
        toolName,
        status: "REJECTED",
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
    });

    const lesson = rejectionReason
      ? `User rejected ${toolName}: "${rejectionReason}". Agent reasoning was: "${(reasoning || "").slice(0, 100)}"`
      : `User rejected ${toolName} without reason. Agent reasoning: "${(reasoning || "").slice(0, 100)}"`;

    const key = existingMemory
      ? (existingMemory.key as string)
      : `rejected_${toolName}_${Date.now()}`;

    // Higher confidence with more rejections of same tool
    const confidence = Math.min(1.0, 0.5 + rejectionCount * 0.1);

    await remember(
      userId,
      "FEEDBACK",
      key,
      `${lesson} (${rejectionCount} total rejections for ${toolName})`,
      "pattern-learner",
    );

    // Update confidence
    await db.memory.updateMany({
      where: { userId, type: "FEEDBACK", key },
      data: { confidence },
    });

    console.log(
      `[PATTERN] Learned from rejection: ${toolName} for user ${userId} (${rejectionCount} total)`,
    );
  } catch (err) {
    console.error("[PATTERN] Failed to learn from rejection:", err);
  }
}

/**
 * When a proposal is approved, reinforce positive patterns.
 */
export async function learnFromApproval(
  userId: string,
  toolName: string,
  // JSONB after migration 20260519060000 — callers may pass a parsed
  // object or the legacy JSON string. We do not actually use the arg
  // beyond logging here, so the loose type is sufficient.
  _toolArgs: unknown,
): Promise<void> {
  try {
    // Count approvals for this tool
    const approvalCount = await db.pendingAction.count({
      where: {
        userId,
        toolName,
        status: "EXECUTED",
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
    });

    // Only save pattern after 3+ approvals of same tool
    if (approvalCount < MIN_OCCURRENCES) return;

    // Try to extract common patterns from args
    const recentApproved = await db.pendingAction.findMany({
      where: {
        userId,
        toolName,
        status: "EXECUTED",
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
      select: { toolArgs: true },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    const argsList = recentApproved
      .map((a: { toolArgs: unknown }) => {
        if (a.toolArgs == null) return null;
        if (typeof a.toolArgs !== "string") return a.toolArgs;
        try {
          return JSON.parse(a.toolArgs);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    // Find common patterns in args (simple key overlap analysis)
    const commonKeys = findCommonKeys(argsList);

    if (commonKeys.length > 0) {
      await remember(
        userId,
        "DECISION",
        `preferred_${toolName}_pattern`,
        `User frequently approves ${toolName} (${approvalCount} times in 30 days). Common patterns: ${commonKeys.join(", ")}`,
        "pattern-learner",
      );
    }
  } catch (err) {
    console.error("[PATTERN] Failed to learn from approval:", err);
  }
}

// ─── Temporal Pattern Analysis ──────────────────────────────────────────

/**
 * Analyze when the user is most active and what they do at different times.
 */
async function analyzeTemporalPatterns(userId: string): Promise<LearnedPattern[]> {
  const since = new Date(Date.now() - PATTERN_ANALYSIS_HOURS * 60 * 60 * 1000);
  const patterns: LearnedPattern[] = [];

  // Analyze agent log actions by time
  const logs = await db.agentLog.findMany({
    where: {
      userId,
      action: { in: ["auto_action", "notify", "tool_call"] },
      createdAt: { gte: since },
    },
    select: { action: true, tool: true, createdAt: true, summary: true },
    orderBy: { createdAt: "asc" },
  });

  if (logs.length < MIN_OCCURRENCES) return patterns;

  // Group by day-of-week + hour
  const timeSlots = new Map<string, TimeSlot>();
  for (const log of logs) {
    const date = new Date(log.createdAt);
    const dow = date.getDay();
    const hour = date.getHours();
    const key = `${dow}-${hour}`;
    const existing = timeSlots.get(key);
    if (existing) {
      existing.count++;
    } else {
      timeSlots.set(key, { dayOfWeek: dow, hour, count: 1 });
    }
  }

  // Find peak activity times (top 3)
  const sorted = [...timeSlots.values()].sort((a, b) => b.count - a.count);
  const peakSlots = sorted.slice(0, 3).filter((s) => s.count >= MIN_OCCURRENCES);

  if (peakSlots.length > 0) {
    const description = peakSlots
      .map((s) => `${DAY_NAMES[s.dayOfWeek]} ${s.hour}:00 (${s.count}x)`)
      .join(", ");

    patterns.push({
      type: "temporal",
      description: `User is most active at: ${description}`,
      confidence: Math.min(1.0, peakSlots[0].count / 10),
      evidence: peakSlots.reduce((sum, s) => sum + s.count, 0),
    });
  }

  // Analyze task creation patterns
  const tasks = await db.task.findMany({
    where: { userId, createdAt: { gte: since } },
    select: { createdAt: true },
  });

  if (tasks.length >= MIN_OCCURRENCES) {
    const taskDays = new Map<number, number>();
    for (const t of tasks) {
      const dow = new Date(t.createdAt).getDay();
      taskDays.set(dow, (taskDays.get(dow) || 0) + 1);
    }

    const topDay = [...taskDays.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topDay && topDay[1] >= MIN_OCCURRENCES) {
      patterns.push({
        type: "temporal",
        description: `User creates most tasks on ${DAY_NAMES[topDay[0]]} (${topDay[1]} times this week)`,
        confidence: Math.min(1.0, topDay[1] / 7),
        evidence: topDay[1],
      });
    }
  }

  return patterns;
}

// ─── Tool Usage Pattern Analysis ────────────────────────────────────────

/**
 * Analyze which tools the user prefers and their approval rates.
 */
async function analyzeToolPatterns(userId: string): Promise<LearnedPattern[]> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days
  const patterns: LearnedPattern[] = [];

  const actions = await db.pendingAction.findMany({
    where: {
      userId,
      createdAt: { gte: since },
      status: { in: ["EXECUTED", "REJECTED"] },
    },
    select: { toolName: true, status: true, toolArgs: true },
  });

  if (actions.length < MIN_OCCURRENCES) return patterns;

  // Group by tool
  const toolStats = new Map<string, { approved: number; rejected: number; args: string[] }>();
  for (const a of actions) {
    const stats = toolStats.get(a.toolName) || { approved: 0, rejected: 0, args: [] };
    if (a.status === "EXECUTED") stats.approved++;
    else stats.rejected++;
    // Normalize to a stringified form so downstream pattern-detection
    // code keeps working whether the column is TEXT (legacy) or JSONB.
    const argStr = typeof a.toolArgs === "string" ? a.toolArgs : JSON.stringify(a.toolArgs ?? {});
    stats.args.push(argStr);
    toolStats.set(a.toolName, stats);
  }

  for (const [tool, stats] of toolStats) {
    const total = stats.approved + stats.rejected;
    if (total < MIN_OCCURRENCES) continue;

    const approvalRate = Math.round((stats.approved / total) * 100);

    if (approvalRate >= 80) {
      patterns.push({
        type: "tool_preference",
        description: `User usually approves ${tool} (${approvalRate}% approval, ${total} total)`,
        confidence: Math.min(1.0, total / 10),
        evidence: total,
      });
    } else if (approvalRate <= 30) {
      patterns.push({
        type: "rejection",
        description: `User usually rejects ${tool} (${100 - approvalRate}% rejection, ${total} total) — avoid proposing`,
        confidence: Math.min(1.0, total / 10),
        evidence: total,
      });
    }
  }

  return patterns;
}

// ─── Notification Engagement Analysis ───────────────────────────────────

/**
 * Analyze which notification types the user engages with vs ignores.
 */
async function analyzeNotificationPatterns(userId: string): Promise<LearnedPattern[]> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days
  const patterns: LearnedPattern[] = [];

  const notifications = await prisma.notification.findMany({
    where: {
      userId,
      OR: [
        { title: { startsWith: AGENT_NOTIFICATION_PREFIX } },
        { title: { startsWith: EVE_AGENT_NOTIFICATION_PREFIX } },
        { title: { startsWith: LEGACY_AGENT_NOTIFICATION_PREFIX } },
      ],
      createdAt: { gte: since },
    },
    select: { type: true, isRead: true },
  });

  if (notifications.length < MIN_OCCURRENCES) return patterns;

  // Group by type
  const typeStats = new Map<string, { read: number; total: number }>();
  for (const n of notifications) {
    const stats = typeStats.get(n.type) || { read: 0, total: 0 };
    stats.total++;
    if (n.isRead) stats.read++;
    typeStats.set(n.type, stats);
  }

  for (const [type, stats] of typeStats) {
    if (stats.total < MIN_OCCURRENCES) continue;

    const readRate = Math.round((stats.read / stats.total) * 100);

    if (readRate <= 20) {
      patterns.push({
        type: "rejection",
        description: `User ignores "${type}" notifications (${readRate}% read rate, ${stats.total} sent) — reduce or stop these`,
        confidence: Math.min(1.0, stats.total / 15),
        evidence: stats.total,
      });
    } else if (readRate >= 90) {
      patterns.push({
        type: "tool_preference",
        description: `User always reads "${type}" notifications (${readRate}% read rate) — these are valuable`,
        confidence: Math.min(1.0, stats.total / 10),
        evidence: stats.total,
      });
    }
  }

  return patterns;
}

// ─── Main Pattern Analysis ──────────────────────────────────────────────

/**
 * Run full pattern analysis for a user. Returns formatted string for agent context.
 * Called from autonomous-agent.ts during each reasoning cycle.
 */
export async function analyzePatterns(userId: string): Promise<string> {
  try {
    const allPatterns = await getLearnedPatterns(userId);
    if (allPatterns.length === 0) return "";

    let result = "\n## Learned Patterns (from user behavior analysis)\n";
    result += "Use these patterns to make better decisions:\n\n";

    for (const p of allPatterns.slice(0, 8)) {
      const confidenceLabel = p.confidence >= 0.8 ? "HIGH" : p.confidence >= 0.5 ? "MEDIUM" : "LOW";
      result += `- [${confidenceLabel}] ${p.description}\n`;
    }

    return result;
  } catch (err) {
    console.error("[PATTERN] Analysis failed:", err);
    return "";
  }
}

export async function getLearnedPatterns(userId: string): Promise<LearnedPattern[]> {
  const [temporal, tools, notifications] = await Promise.all([
    analyzeTemporalPatterns(userId),
    analyzeToolPatterns(userId),
    analyzeNotificationPatterns(userId),
  ]);
  const all = [...temporal, ...tools, ...notifications].filter((p) => p.confidence >= 0.3);
  all.sort((a, b) => b.confidence - a.confidence);
  return all;
}

// ─── Periodic Pattern Persistence ───────────────────────────────────────

/**
 * Run deep analysis and persist important patterns as memories.
 * Called periodically (every 6 hours) from the scheduler.
 */
export async function persistLearnedPatterns(userId: string): Promise<void> {
  try {
    const [temporal, tools, notifications] = await Promise.all([
      analyzeTemporalPatterns(userId),
      analyzeToolPatterns(userId),
      analyzeNotificationPatterns(userId),
    ]);

    const allPatterns = [...temporal, ...tools, ...notifications];

    // Only persist high-confidence patterns
    const strongPatterns = allPatterns.filter((p) => p.confidence >= 0.6 && p.evidence >= 5);

    for (const p of strongPatterns) {
      const memoryType = p.type === "rejection" ? "FEEDBACK" : "CONTEXT";
      const key = `pattern_${p.type}_${hashPattern(p.description)}`;

      await remember(userId, memoryType, key, p.description, "pattern-learner");

      await db.memory.updateMany({
        where: { userId, type: memoryType, key },
        data: { confidence: p.confidence },
      });
    }

    if (strongPatterns.length > 0) {
      console.log(`[PATTERN] Persisted ${strongPatterns.length} patterns for user ${userId}`);
    }
  } catch (err) {
    console.error("[PATTERN] Persistence failed:", err);
  }
}

/**
 * Update confidence of existing memories based on how accurate they proved.
 * Called when agent actions succeed or fail.
 */
export async function updateConfidence(
  userId: string,
  memoryKey: string,
  memoryType: string,
  wasAccurate: boolean,
): Promise<void> {
  try {
    const memory = await db.memory.findFirst({
      where: { userId, type: memoryType as MemoryType, key: memoryKey },
    });

    if (!memory) return;

    const currentConfidence = (memory.confidence as number) || 1.0;
    const delta = wasAccurate ? 0.05 : -0.1;
    const newConfidence = Math.max(0.1, Math.min(1.0, currentConfidence + delta));

    await db.memory.update({
      where: { id: memory.id },
      data: { confidence: newConfidence, updatedAt: new Date() },
    });
  } catch {
    // Non-critical, ignore errors
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function findCommonKeys(argsList: Record<string, unknown>[]): string[] {
  if (argsList.length < 2) return [];

  const keyCounts = new Map<string, number>();
  for (const args of argsList) {
    for (const key of Object.keys(args)) {
      keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
    }
  }

  return [...keyCounts.entries()]
    .filter(([, count]) => count >= argsList.length * 0.7) // present in 70%+ of args
    .map(([key]) => key);
}

function hashPattern(description: string): string {
  // Simple hash for dedup key generation
  let hash = 0;
  for (let i = 0; i < description.length; i++) {
    const char = description.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36).slice(0, 8);
}

// ─── Scheduler ──────────────────────────────────────────────────────────

let patternIntervalId: ReturnType<typeof setInterval> | null = null;
const PATTERN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export function startPatternLearner() {
  if (patternIntervalId) return;

  console.log("[PATTERN] Pattern learner started (6h interval)");

  // Run first analysis after 5 minutes (let server warm up)
  setTimeout(
    async () => {
      await runPatternAnalysisForAllUsers();
    },
    5 * 60 * 1000,
  );

  patternIntervalId = setInterval(runPatternAnalysisForAllUsers, PATTERN_INTERVAL_MS);
}

export function stopPatternLearner() {
  if (patternIntervalId) {
    clearInterval(patternIntervalId);
    patternIntervalId = null;
    console.log("[PATTERN] Pattern learner stopped");
  }
}

async function runPatternAnalysisForAllUsers() {
  try {
    // Find users with autonomous agent enabled
    const configs = await prisma.automationConfig.findMany({
      where: { autonomousAgent: true },
      select: { userId: true },
    });

    // Filter by plan — pattern learning requires TEAM+
    const patternUserIds = configs.map((c) => c.userId);
    const patternUsers = await prisma.user.findMany({
      where: { id: { in: patternUserIds } },
      select: { id: true, plan: true },
    });
    const eligibleUserIds = new Set(
      patternUsers.filter((u) => planHasFeature(u.plan, "pattern_learning")).map((u) => u.id),
    );

    for (const { userId } of configs.filter((c) => eligibleUserIds.has(c.userId))) {
      try {
        await persistLearnedPatterns(userId);
      } catch {
        // Skip individual user failures
      }
    }

    // Attention priority decay — run every 6h tick for all users
    await amplifyStaleAttentionItems().catch((err) =>
      console.warn("[PATTERN] Priority decay failed:", err),
    );

    // Weekly jobs (Sunday only) — avoid running on every 6h tick
    if (new Date().getDay() === 0) {
      await detectSkillsForAllUsers();
      await runFeedbackAdaptationForAllUsers();
      await buildInteractionGraphsForAllUsers().catch((err) =>
        console.warn("[PATTERN] Interaction graph batch failed:", err),
      );
    }
  } catch (err) {
    console.error("[PATTERN] Batch analysis failed:", err);
  }
}

/**
 * Priority decay amplifier — prevents important items from being permanently buried.
 *
 * For every OPEN AttentionItem older than 24 hours, we increment its priority
 * by `ageInDays * DECAY_RATE`, capped at MAX_AMPLIFIED_PRIORITY. This ensures
 * items that haven't been actioned on gradually rise in the queue until they
 * get addressed.
 *
 * Runs every 6 hours via the pattern-learner batch cycle.
 */
const DECAY_RATE = 3; // priority points per day of age
const MAX_AMPLIFIED_PRIORITY = 120; // never exceed this via decay alone
const MIN_AGE_HOURS = 24; // start decaying after 24h in queue

async function amplifyStaleAttentionItems(): Promise<void> {
  const cutoff = new Date(Date.now() - MIN_AGE_HOURS * 60 * 60 * 1000);

  // Find OPEN items that have been in queue for > MIN_AGE_HOURS and haven't
  // been amplified recently (lastAmplifiedAt null or > 6h ago).
  const amplifyThreshold = new Date(Date.now() - 6 * 60 * 60 * 1000);

  const stale = await (
    prisma.attentionItem as unknown as {
      findMany: (args: unknown) => Promise<
        Array<{
          id: string;
          priority: number;
          surfacedAt: Date;
        }>
      >;
    }
  ).findMany({
    where: {
      status: "OPEN",
      surfacedAt: { lte: cutoff },
      OR: [{ lastAmplifiedAt: null }, { lastAmplifiedAt: { lte: amplifyThreshold } }],
    } as unknown,
    select: { id: true, priority: true, surfacedAt: true },
    take: 500,
  });

  if (stale.length === 0) return;

  const now = Date.now();
  const updates: Array<Promise<unknown>> = [];

  for (const item of stale) {
    const ageMs = now - item.surfacedAt.getTime();
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    const boost = Math.floor(ageDays * DECAY_RATE);
    const newPriority = Math.min(item.priority + boost, MAX_AMPLIFIED_PRIORITY);
    if (newPriority <= item.priority) continue; // already at cap or no change

    updates.push(
      (
        prisma.attentionItem as unknown as {
          update: (args: unknown) => Promise<unknown>;
        }
      )
        .update({
          where: { id: item.id },
          data: { priority: newPriority, lastAmplifiedAt: new Date() },
        })
        .catch(() => {}),
    );
  }

  await Promise.all(updates);
  if (updates.length > 0) {
    console.log(`[PATTERN] Amplified priority on ${updates.length} stale attention item(s)`);
  }
}
