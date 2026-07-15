import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { prisma } from "../db.js";
import { snapshotUserProviderCooldowns } from "../llm/model-fallback.js";
import { getBriefingStatus } from "../pim/briefing-status.js";

type CheckStatus = "ok" | "warning" | "error";

interface ReadinessCheck {
  key: string;
  label: string;
  status: CheckStatus;
  message: string;
  detail?: Record<string, unknown>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface ReadinessData {
  db: { connected: boolean };
  devices: number;
  pushSubscriptions: number;
  recentPushDeliveries: Array<{ status: string; receivedAt: Date | null; clickedAt: Date | null }>;
  hasVapid: boolean;
  googleToken: { refreshToken: string | null; gmailWatchExpiresAt: Date | null } | null;
  automationConfig: {
    dailyBriefing: boolean;
    briefingTime: string;
    timezone: string;
    reminderAutoCheck: boolean;
    emailAutoClassify: boolean;
    autonomousAgent: boolean;
    agentMode: string;
  } | null;
  overdueReminders: number;
  pendingReminders: number;
  nextReminder: { id: string; title: string; remindAt: Date } | null;
  recentReminderNotifications: Array<{ id: string; title: string; createdAt: Date }>;
  recentEmails: number;
  todayEvents: number;
  briefing: Awaited<ReturnType<typeof getBriefingStatus>>;
  aiProviders: ReturnType<typeof snapshotUserProviderCooldowns>;
  now: Date;
}

export function opsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/readiness", async (request) => {
    const userId = getUserId(request);
    const now = new Date();
    const data = await collectReadinessData(userId, now);
    const checks = buildChecks(data);

    return {
      status: overallStatus(checks),
      generatedAt: now.toISOString(),
      system: {
        commit:
          process.env.RENDER_GIT_COMMIT ||
          process.env.GIT_COMMIT_SHA ||
          process.env.VERCEL_GIT_COMMIT_SHA ||
          null,
        uptime: Math.floor(process.uptime()),
        environment: process.env.NODE_ENV ?? "development",
        apiUrl: process.env.RENDER_EXTERNAL_URL ?? null,
      },
      checks,
    };
  });
}

async function collectReadinessData(userId: string, now: Date): Promise<ReadinessData> {
  const since = new Date(now.getTime() - DAY_MS);
  const [
    db,
    devices,
    pushSubscriptions,
    recentPushDeliveries,
    googleToken,
    automationConfig,
    overdueReminders,
    pendingReminders,
    nextReminder,
    recentReminderNotifications,
    recentEmails,
    todayEvents,
    briefing,
  ] = await Promise.all([
    checkDatabase(),
    prisma.device.count({ where: { userId } }),
    prisma.pushSubscription.count({ where: { userId } }),
    prisma.pushDeliveryLog.findMany({
      where: { userId, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.userToken.findUnique({ where: { userId_provider: { userId, provider: "google" } } }),
    prisma.automationConfig.findUnique({ where: { userId } }),
    prisma.reminder.count({
      where: { userId, status: "PENDING", remindAt: { lte: now } },
    }),
    prisma.reminder.count({ where: { userId, status: "PENDING" } }),
    prisma.reminder.findFirst({
      where: { userId, status: "PENDING", remindAt: { gt: now } },
      orderBy: { remindAt: "asc" },
    }),
    prisma.notification.findMany({
      where: { userId, type: "reminder", createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    prisma.emailMessage.count({ where: { userId } }),
    prisma.calendarEvent.count({ where: { userId, startTime: { gte: startOfDay(now) } } }),
    getBriefingStatus(userId, { now }),
  ]);

  return {
    db,
    devices,
    pushSubscriptions,
    recentPushDeliveries,
    hasVapid: Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
    googleToken,
    automationConfig,
    overdueReminders,
    pendingReminders,
    nextReminder,
    recentReminderNotifications,
    recentEmails,
    todayEvents,
    briefing,
    aiProviders: snapshotUserProviderCooldowns(userId),
    now,
  };
}

function buildChecks(data: ReadinessData): ReadinessCheck[] {
  return [
    databaseCheck(data),
    deviceCheck(data),
    pushCheck(data),
    googleCheck(data),
    aiProviderCheck(data),
    automationCheck(data),
    reminderCheck(data),
    briefingCheck(data),
    syncedDataCheck(data),
  ];
}

function databaseCheck(data: ReadinessData): ReadinessCheck {
  return {
    key: "db",
    label: "Database",
    status: data.db.connected ? "ok" : "error",
    message: data.db.connected ? "Connected" : "Unreachable",
  };
}

function deviceCheck(data: ReadinessData): ReadinessCheck {
  return {
    key: "devices",
    label: "Signed-in devices",
    status: data.devices > 0 ? "ok" : "warning",
    message:
      data.devices > 0
        ? `${data.devices} active device${data.devices === 1 ? "" : "s"}`
        : "No devices",
    detail: { count: data.devices },
  };
}

function pushCheck(data: ReadinessData): ReadinessCheck {
  return {
    key: "push",
    label: "Push notifications",
    status: !data.hasVapid ? "error" : data.pushSubscriptions > 0 ? "ok" : "warning",
    message: pushMessage(data),
    detail: {
      subscriptions: data.pushSubscriptions,
      ...summarizePushDeliveries(data.recentPushDeliveries),
    },
  };
}

function pushMessage(data: ReadinessData): string {
  if (!data.hasVapid) return "VAPID keys missing";
  if (data.pushSubscriptions === 0) return "No push subscriptions";
  return `${data.pushSubscriptions} subscription${data.pushSubscriptions === 1 ? "" : "s"} registered`;
}

function googleCheck(data: ReadinessData): ReadinessCheck {
  const gmailWatchExpiresAt = data.googleToken?.gmailWatchExpiresAt ?? null;
  const gmailPushEnabled = Boolean(gmailWatchExpiresAt && gmailWatchExpiresAt > data.now);
  const hasGoogleRefresh = Boolean(data.googleToken?.refreshToken);
  return {
    key: "google",
    label: "Google account",
    status: hasGoogleRefresh ? "ok" : "warning",
    message: hasGoogleRefresh ? "Connected" : "Not connected",
    detail: {
      gmailPushConfigured: Boolean(process.env.GMAIL_PUBSUB_TOPIC),
      gmailPushEnabled,
      gmailPushExpiresAt: gmailWatchExpiresAt?.toISOString() ?? null,
    },
  };
}

function aiProviderCheck(data: ReadinessData): ReadinessCheck {
  // Treat AI as healthy if at least one provider key (env or user) is usable.
  // If every provider is in cooldown the dashboard must say so plainly so
  // "Overall OK" stops lying while chat and briefing silently fall back.
  const total = data.aiProviders.providers.length;
  const downCount = data.aiProviders.unavailable.length;
  const allDown = downCount > 0 && downCount === total;
  const someDown = downCount > 0 && downCount < total;

  const nextRetry = data.aiProviders.unavailable
    .map((info) => info.keyLimitedUntil?.getTime() ?? info.creditRetryAt?.getTime() ?? null)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b)[0];

  return {
    key: "aiProvider",
    label: "AI provider",
    status: allDown ? "error" : someDown ? "warning" : "ok",
    message: allDown
      ? "All AI providers are in cooldown — chat and briefing fall back to rule-based view"
      : someDown
        ? `${downCount}/${total} providers in cooldown — fallback active`
        : "All providers available",
    detail: {
      providers: data.aiProviders.providers.map((info) => ({
        quotaKey: info.quotaKey,
        keyLimitedUntil: info.keyLimitedUntil?.toISOString() ?? null,
        creditRetryAt: info.creditRetryAt?.toISOString() ?? null,
      })),
      unavailableCount: downCount,
      nextRetryAt: nextRetry ? new Date(nextRetry).toISOString() : null,
    },
  };
}

function automationCheck(data: ReadinessData): ReadinessCheck {
  return {
    key: "automations",
    label: "Automation config",
    status: data.automationConfig ? "ok" : "warning",
    message: data.automationConfig ? "Configured" : "Missing config",
    detail: data.automationConfig
      ? {
          dailyBriefing: data.automationConfig.dailyBriefing,
          briefingTime: data.automationConfig.briefingTime,
          timezone: data.automationConfig.timezone,
          reminderAutoCheck: data.automationConfig.reminderAutoCheck,
          emailAutoClassify: data.automationConfig.emailAutoClassify,
          autonomousAgent: data.automationConfig.autonomousAgent,
          agentMode: data.automationConfig.agentMode,
        }
      : undefined,
  };
}

function reminderCheck(data: ReadinessData): ReadinessCheck {
  return {
    key: "reminders",
    label: "Reminders",
    status: data.overdueReminders > 0 ? "warning" : "ok",
    message:
      data.overdueReminders > 0
        ? `${data.overdueReminders} due reminder${data.overdueReminders === 1 ? "" : "s"} pending`
        : "No overdue reminders",
    detail: {
      pending: data.pendingReminders,
      overdue: data.overdueReminders,
      nextReminder: data.nextReminder
        ? {
            id: data.nextReminder.id,
            title: data.nextReminder.title,
            remindAt: data.nextReminder.remindAt.toISOString(),
          }
        : null,
      recentNotifications: data.recentReminderNotifications.map((n) => ({
        id: n.id,
        title: n.title,
        createdAt: n.createdAt.toISOString(),
      })),
    },
  };
}

function briefingCheck(data: ReadinessData): ReadinessCheck {
  return {
    key: "briefing",
    label: "Daily briefing",
    status: data.briefing.automation.enabled ? "ok" : "warning",
    message: briefingMessage(data),
    detail: {
      generated: data.briefing.generated,
      briefingTime: data.briefing.automation.briefingTime,
      timezone: data.briefing.automation.timezone,
      push: data.briefing.push,
    },
  };
}

function briefingMessage(data: ReadinessData): string {
  if (data.briefing.generated) return `Generated today (${data.briefing.push.state})`;
  if (data.briefing.automation.enabled) {
    return `Enabled for ${data.briefing.automation.briefingTime ?? "unknown time"}`;
  }
  return "Disabled";
}

function syncedDataCheck(data: ReadinessData): ReadinessCheck {
  return {
    key: "data",
    label: "Synced data",
    status: data.recentEmails > 0 || data.todayEvents > 0 ? "ok" : "warning",
    message:
      data.recentEmails > 0 || data.todayEvents > 0
        ? `${data.recentEmails} emails, ${data.todayEvents} upcoming calendar events`
        : "No synced email or calendar data yet",
    detail: { emails: data.recentEmails, upcomingCalendarEvents: data.todayEvents },
  };
}

async function checkDatabase(): Promise<{ connected: boolean }> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { connected: true };
  } catch (err) {
    // Log the driver error server-side (it can embed the DB host:port / pooler
    // name) — never return it to the client: /ops/readiness is requireAuth, not
    // admin, so any logged-in user can call it.
    console.error("[OPS] readiness DB check failed:", err instanceof Error ? err.message : err);
    return { connected: false };
  }
}

function summarizePushDeliveries(
  deliveries: Array<{
    status: string;
    receivedAt: Date | null;
    clickedAt: Date | null;
  }>,
) {
  return {
    recent: deliveries.length,
    accepted: deliveries.filter((d) => d.status === "ACCEPTED").length,
    failed: deliveries.filter((d) => d.status === "FAILED").length,
    skipped: deliveries.filter((d) => d.status === "SKIPPED").length,
    received: deliveries.filter((d) => d.receivedAt).length,
    clicked: deliveries.filter((d) => d.clickedAt).length,
  };
}

function overallStatus(checks: ReadinessCheck[]): CheckStatus {
  if (checks.some((check) => check.status === "error")) return "error";
  if (checks.some((check) => check.status === "warning")) return "warning";
  return "ok";
}

function startOfDay(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}
