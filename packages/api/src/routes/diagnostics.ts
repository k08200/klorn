/**
 * POC diagnostic endpoints — self-service "why didn't X fire?" checks
 * for founder dogfood.
 *
 * GET /api/diagnostics/briefing
 *   Returns everything needed to diagnose why a daily briefing did or
 *   didn't show up at the configured time:
 *     - User's automationConfig (dailyBriefing flag, briefingTime,
 *       timezone, notifyDailyBriefing preference, quiet hours)
 *     - Whether VAPID push keys are configured server-side
 *     - Count + freshness of the user's push subscriptions
 *     - Latest 5 briefing-type Notifications stored in DB this week
 *     - Latest 5 PushDeliveryLog entries for daily_briefing category
 *     - Server's view of "is briefing due right now?" given the user's config
 *   Read-only, returns JSON, only the requesting user's own data.
 */

import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { isBriefingDue } from "../automation-scheduler.js";
import { prisma } from "../db.js";

interface BriefingDiagnosticsResponse {
  now: { utc: string; userLocal: string; timezone: string };
  automationConfig: {
    found: boolean;
    dailyBriefing?: boolean;
    briefingTime?: string | null;
    timezone?: string | null;
    notifyDailyBriefing?: boolean;
    quietHoursStart?: string | null;
    quietHoursEnd?: string | null;
  };
  pushEnv: {
    vapidPublicKeyConfigured: boolean;
    vapidPrivateKeyConfigured: boolean;
  };
  pushSubscriptions: {
    count: number;
    latestCreatedAt: string | null;
  };
  recentBriefingNotifications: Array<{
    id: string;
    title: string;
    createdAt: string;
  }>;
  recentBriefingPushAttempts: Array<{
    id: string;
    status: string;
    reason: string | null;
    createdAt: string;
    clickedAt: string | null;
  }>;
  serverThinksBriefingIsDueNow: boolean;
  likelyCulprit: string;
}

export async function diagnosticsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/briefing", async (request): Promise<BriefingDiagnosticsResponse> => {
    const userId = getUserId(request);
    const now = new Date();

    const config = await prisma.automationConfig.findUnique({
      where: { userId },
      select: {
        dailyBriefing: true,
        briefingTime: true,
        timezone: true,
      },
    });
    // notifyDailyBriefing and quiet hours are read via raw cast — migration is
    // recent and the generated client may not expose them as strict typed
    // fields in every environment. Stays defensive.
    const configRaw = config as
      | (typeof config & {
          notifyDailyBriefing?: boolean;
          quietHoursStart?: string | null;
          quietHoursEnd?: string | null;
        })
      | null;

    const subscriptions = await prisma.pushSubscription.findMany({
      where: { userId },
      select: { id: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const briefingNotifications = await prisma.notification.findMany({
      where: { userId, type: "briefing", createdAt: { gte: sevenDaysAgo } },
      select: { id: true, title: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 5,
    });

    const pushAttempts = await prisma.pushDeliveryLog.findMany({
      where: { userId, category: "daily_briefing", createdAt: { gte: sevenDaysAgo } },
      select: { id: true, status: true, skipReason: true, createdAt: true, clickedAt: true },
      orderBy: { createdAt: "desc" },
      take: 5,
    });

    const timezone = config?.timezone || "Asia/Seoul";
    const userLocalFmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    const isDueNow = isBriefingDue(config?.briefingTime, timezone, now);

    // Best-effort culprit narrative — looks at the diagnostic chain in the
    // same order the scheduler does so the suggested fix matches the
    // earliest failing gate.
    const culprit = pickCulprit({
      hasConfig: !!config,
      dailyBriefing: config?.dailyBriefing ?? false,
      notifyDailyBriefing: configRaw?.notifyDailyBriefing ?? true,
      hasVapidPublic: !!process.env.VAPID_PUBLIC_KEY,
      hasVapidPrivate: !!process.env.VAPID_PRIVATE_KEY,
      subscriptionCount: subscriptions.length,
      isDueNow,
      latestPushStatus: pushAttempts[0]?.status ?? null,
      latestPushReason: pushAttempts[0]?.skipReason ?? null,
      briefingNotifThisWeek: briefingNotifications.length,
    });

    return {
      now: {
        utc: now.toISOString(),
        userLocal: userLocalFmt.format(now),
        timezone,
      },
      automationConfig: {
        found: !!config,
        dailyBriefing: config?.dailyBriefing,
        briefingTime: config?.briefingTime ?? null,
        timezone: config?.timezone ?? null,
        notifyDailyBriefing: configRaw?.notifyDailyBriefing,
        quietHoursStart: configRaw?.quietHoursStart ?? null,
        quietHoursEnd: configRaw?.quietHoursEnd ?? null,
      },
      pushEnv: {
        vapidPublicKeyConfigured: !!process.env.VAPID_PUBLIC_KEY,
        vapidPrivateKeyConfigured: !!process.env.VAPID_PRIVATE_KEY,
      },
      pushSubscriptions: {
        count: subscriptions.length,
        latestCreatedAt: subscriptions[0]?.createdAt.toISOString() ?? null,
      },
      recentBriefingNotifications: briefingNotifications.map((n) => ({
        id: n.id,
        title: n.title,
        createdAt: n.createdAt.toISOString(),
      })),
      recentBriefingPushAttempts: pushAttempts.map((p) => ({
        id: p.id,
        status: p.status,
        reason: p.skipReason,
        createdAt: p.createdAt.toISOString(),
        clickedAt: p.clickedAt?.toISOString() ?? null,
      })),
      serverThinksBriefingIsDueNow: isDueNow,
      likelyCulprit: culprit,
    };
  });
}

function pickCulprit(s: {
  hasConfig: boolean;
  dailyBriefing: boolean;
  notifyDailyBriefing: boolean;
  hasVapidPublic: boolean;
  hasVapidPrivate: boolean;
  subscriptionCount: number;
  isDueNow: boolean;
  latestPushStatus: string | null;
  latestPushReason: string | null;
  briefingNotifThisWeek: number;
}): string {
  if (!s.hasConfig) {
    return "No automationConfig row for this user. Trigger any /settings save once to create it, then retry.";
  }
  if (!s.dailyBriefing) {
    return "Daily briefing is OFF in automationConfig.dailyBriefing. Turn it on in /settings → Signal rhythm.";
  }
  if (!s.notifyDailyBriefing) {
    return "Daily briefing is enabled but the notifyDailyBriefing preference is OFF — briefing gets generated but no push is sent.";
  }
  if (!s.hasVapidPublic || !s.hasVapidPrivate) {
    return "Server VAPID keys are missing — push delivery is silently skipped. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY env vars in Render.";
  }
  if (s.subscriptionCount === 0) {
    return "User has zero PushSubscription rows. The browser hasn't subscribed. Visit /settings → Notifications and tap Enable push notifications, accept the browser prompt, then retry.";
  }
  if (s.latestPushStatus === "SKIPPED") {
    return `Latest push attempt was SKIPPED (reason: ${s.latestPushReason ?? "unknown"}). Likely quiet hours or notification pref.`;
  }
  if (s.latestPushStatus === "FAILED") {
    return `Latest push attempt FAILED (reason: ${s.latestPushReason ?? "unknown"}). Subscription may be expired — re-enable push in /settings → Notifications.`;
  }
  if (s.briefingNotifThisWeek === 0) {
    return "No briefing Notification row created this week — scheduler may not be running. Check Render logs for '[AUTOMATION] Scheduler started' and '[AUTOMATION] Generating daily briefing'.";
  }
  if (!s.isDueNow && s.latestPushStatus === null) {
    return "No diagnostic-ready data yet. Wait for the next scheduled briefing time, then re-check. If it still fails after the target time, share this JSON.";
  }
  return "Configuration looks healthy. Briefings should fire on schedule — check Render logs for [AUTOMATION] / [PUSH] entries around your briefing time.";
}
