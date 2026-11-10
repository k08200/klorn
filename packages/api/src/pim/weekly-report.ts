/**
 * Weekly signal report (design 2026-08-21, derived from the "weekly digest"
 * expectation in third-party coverage): every Monday, one note + one push per
 * active user with LAST WEEK'S MEASURED NUMBERS — lane inflow, how much was
 * filtered out of the way, corrections made, actions auto-handled. No LLM,
 * no estimates ("time saved" etc. is deliberately absent: we don't measure
 * it, so we don't claim it).
 *
 * Idempotent per ISO week: the Note (userId, dayKey="2026-W34") unique key
 * plus the Notification dedupeKey `weekly:<week>` (create-catch-P2002) mean a
 * scheduler restart or overlapping tick can never double-deliver.
 */

import { prisma } from "../db.js";
import { normalizeTier, TIERS, type Tier } from "../judge/tiers.js";
import { sendPushNotification } from "../notify/push.js";

export const WEEK_MS = 7 * 24 * 60 * 60_000;

/** Tiers counted as "filtered out of your way" in the headline percentage. */
const FILTERED_TIERS: readonly Tier[] = ["SILENT", "INFO"];

/** ISO-8601 week key, e.g. "2026-W34". Pure, UTC-based. */
export function isoWeekKey(date: Date): string {
  // Shift to the Thursday of this week (ISO weeks are keyed by Thursday).
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export interface WeeklySignalStats {
  total: number;
  byTier: Record<Tier, number>;
  filtered: number;
  filteredPct: number;
  corrections: number;
  autoActions: number;
}

/** Last-7-days measured stats for one user. Every number is a real count. */
export async function collectWeeklyStats(userId: string, now: Date): Promise<WeeklySignalStats> {
  const since = new Date(now.getTime() - WEEK_MS);
  const [byShownTier, corrections, autoActions] = await Promise.all([
    prisma.decisionLabel.groupBy({
      by: ["shownTier"],
      where: { userId, judgedAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.decisionLabel.count({
      where: { userId, outcome: { startsWith: "OVERRIDE:" }, outcomeAt: { gte: since } },
    }),
    prisma.agentLog.count({
      where: { userId, action: "auto_action", createdAt: { gte: since } },
    }),
  ]);

  const byTier = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<Tier, number>;
  let total = 0;
  for (const row of byShownTier) {
    const count = row._count._all;
    byTier[normalizeTier(row.shownTier)] += count;
    total += count;
  }
  const filtered = FILTERED_TIERS.reduce((sum, t) => sum + byTier[t], 0);
  const filteredPct = total > 0 ? Math.round((filtered / total) * 100) : 0;
  return { total, byTier, filtered, filteredPct, corrections, autoActions };
}

/** Note/push body. Plain measured lines — density over decoration. */
export function formatWeeklyReport(stats: WeeklySignalStats): string {
  const lanes = TIERS.filter((t) => stats.byTier[t] > 0)
    .map((t) => `${t} ${stats.byTier[t]}`)
    .join(" · ");
  const lines = [
    `${stats.total} emails triaged: ${lanes}`,
    `${stats.filtered} filtered out of your way (${stats.filteredPct}% SILENT+INFO)`,
  ];
  if (stats.corrections > 0) {
    lines.push(`${stats.corrections} correction(s) — each one trains your triage`);
  }
  if (stats.autoActions > 0) {
    lines.push(`${stats.autoActions} handled automatically`);
  }
  return lines.map((l) => `- ${l}`).join("\n");
}

/**
 * Deliver this week's report to every user who had ≥1 triaged email in the
 * window. Returns the number of users delivered to. Per-user failures are
 * logged and skipped — one user must never starve the sweep.
 */
export async function sendWeeklySignalReports(now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - WEEK_MS);
  const week = isoWeekKey(now);
  const active = await prisma.decisionLabel.groupBy({
    by: ["userId"],
    where: { judgedAt: { gte: since } },
    _count: { _all: true },
  });

  let sent = 0;
  for (const row of active) {
    const userId = row.userId;
    try {
      const stats = await collectWeeklyStats(userId, now);
      if (stats.total === 0) continue;
      const content = formatWeeklyReport(stats);

      try {
        await prisma.note.create({
          data: {
            userId,
            dayKey: week,
            title: `Weekly Signal Report — ${week}`,
            content,
            category: "report",
          },
          select: { id: true },
        });
      } catch (err) {
        if ((err as { code?: string })?.code === "P2002") continue; // already sent this week
        throw err;
      }

      let notificationId: string | null = null;
      try {
        const notification = await prisma.notification.create({
          data: {
            userId,
            type: "email",
            dedupeKey: `weekly:${week}`,
            title: "Your week in signals",
            message: content,
            link: "/inbox",
          },
          select: { id: true },
        });
        notificationId = notification.id;
      } catch (err) {
        if ((err as { code?: string })?.code !== "P2002") throw err;
      }

      // Deliberate category reuse: the weekly report is digest-class content,
      // so the daily_briefing toggle governs both — one switch for digests.
      await sendPushNotification(
        userId,
        {
          title: "Your week in signals",
          body: `${stats.total} triaged, ${stats.filtered} filtered (${stats.filteredPct}%).`,
          url: "/inbox",
          ...(notificationId ? { notificationId } : {}),
        },
        "daily_briefing",
      );
      sent++;
    } catch (err) {
      console.warn(`[WEEKLY] report failed for user ${userId}:`, err);
    }
  }
  return sent;
}
