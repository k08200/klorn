/**
 * Notification Preferences — per-user opt-out by category + quiet hours.
 *
 * Gates push.ts notifications consistently across every call site. Falls
 * open when config is missing (default: notify). Quiet-window math lives
 * in quiet-hours.ts; this module only loads config and combines the checks.
 */

import { prisma } from "../db.js";
import { normalizeTimeZone } from "../time-zone.js";
import { isWithinQuietHours } from "./quiet-hours.js";

export type NotifCategory =
  | "email_urgent"
  | "email_candidate"
  | "meeting"
  | "task_due"
  | "agent_proposal"
  | "daily_briefing"
  // GitHub firewall PUSH the judge already adjudicated. Not user-filterable
  // (no GitHub-specific pref), but authoredSurface() maps it to "firewall" so
  // it bypasses the inbound-mail noise heuristic, matching email_urgent.
  | "github_urgent"
  | "system";

interface NotifPrefs {
  notifyEmailUrgent: boolean;
  notifyEmailCandidate: boolean;
  notifyMeeting: boolean;
  notifyTaskDue: boolean;
  notifyAgentProposal: boolean;
  notifyDailyBriefing: boolean;
  timezone: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
}

function categoryEnabled(prefs: NotifPrefs, category: NotifCategory): boolean {
  switch (category) {
    case "email_urgent":
      return prefs.notifyEmailUrgent;
    case "email_candidate":
      return prefs.notifyEmailCandidate;
    case "meeting":
      return prefs.notifyMeeting;
    case "task_due":
      return prefs.notifyTaskDue;
    case "agent_proposal":
      return prefs.notifyAgentProposal;
    case "daily_briefing":
      return prefs.notifyDailyBriefing;
    case "github_urgent":
      return true; // Judge-adjudicated GitHub PUSH is not category-filterable
    case "system":
      return true; // System notifications are not category-filterable
  }
}

/** Why a notification was blocked — doubles as the PushDeliveryLog skipReason. */
export type NotificationGateReason = "user_preferences" | "quiet_hours";

export type NotificationGateResult =
  | { allowed: true }
  | { allowed: false; reason: NotificationGateReason };

/**
 * Decide whether a notification may be pushed for a user + category.
 * Distinguishes "category opted out" from "inside quiet hours" so push.ts
 * can record an honest skipReason for each.
 */
export async function evaluateNotificationGate(
  userId: string,
  category: NotifCategory,
  now: Date = new Date(),
): Promise<NotificationGateResult> {
  const config = await prisma.automationConfig.findUnique({ where: { userId } });
  if (!config) return { allowed: true }; // default: notify

  const prefs: NotifPrefs = {
    notifyEmailUrgent:
      (config as unknown as { notifyEmailUrgent?: boolean }).notifyEmailUrgent ?? true,
    notifyEmailCandidate:
      (config as unknown as { notifyEmailCandidate?: boolean }).notifyEmailCandidate ?? true,
    notifyMeeting: (config as unknown as { notifyMeeting?: boolean }).notifyMeeting ?? true,
    notifyTaskDue: (config as unknown as { notifyTaskDue?: boolean }).notifyTaskDue ?? true,
    notifyAgentProposal:
      (config as unknown as { notifyAgentProposal?: boolean }).notifyAgentProposal ?? true,
    notifyDailyBriefing:
      (config as unknown as { notifyDailyBriefing?: boolean }).notifyDailyBriefing ?? true,
    timezone: normalizeTimeZone((config as unknown as { timezone?: string | null }).timezone),
    quietHoursStart:
      (config as unknown as { quietHoursStart?: string | null }).quietHoursStart ?? null,
    quietHoursEnd: (config as unknown as { quietHoursEnd?: string | null }).quietHoursEnd ?? null,
  };

  if (!categoryEnabled(prefs, category)) {
    return { allowed: false, reason: "user_preferences" };
  }
  if (isWithinQuietHours(now, prefs, prefs.timezone)) {
    return { allowed: false, reason: "quiet_hours" };
  }
  return { allowed: true };
}

/**
 * Quiet-hours check alone, by userId — no category dimension. For loud
 * channels invoked directly from scheduler code (SMS escalation via
 * sendSms) that bypass evaluateNotificationGate. Defense in depth: a
 * direct caller must never ring a sleeping phone. Falls open like the
 * gate above — missing config means not quiet.
 */
export async function isUserInQuietHours(userId: string, now: Date = new Date()): Promise<boolean> {
  const config = await prisma.automationConfig.findUnique({ where: { userId } });
  if (!config) return false;

  const raw = config as unknown as {
    timezone?: string | null;
    quietHoursStart?: string | null;
    quietHoursEnd?: string | null;
  };
  return isWithinQuietHours(
    now,
    {
      quietHoursStart: raw.quietHoursStart ?? null,
      quietHoursEnd: raw.quietHoursEnd ?? null,
    },
    normalizeTimeZone(raw.timezone),
  );
}
