/**
 * Background Agent — Lightweight real-time notifications
 *
 * Only handles time-critical checks that need sub-minute accuracy:
 * - Upcoming calendar events → pre-meeting notification (5 min before)
 *
 * NOTE: Task overdue/due-soon checks are handled by autonomous-agent.ts
 *       (which uses LLM reasoning for smarter, context-aware notifications)
 *       Reminders are handled by reminder-scheduler.ts
 *       Daily briefing & email classify are handled by automation-scheduler.ts
 *
 * Notifications are persisted to PostgreSQL (Notification model).
 */

import { prisma } from "./db.js";
import { getUpcomingMeetings } from "./meeting.js";
import { pushNotification } from "./websocket.js";

// In-memory cache only used to skip redundant DB queries within same process lifetime.
// Actual dedup is DB-based (survives server restarts).
const notifiedIds: Set<string> = new Set();

async function addNotification(
  userId: string,
  notif: { type: string; title: string; message: string; link?: string },
) {
  // Persist to DB
  const data: Record<string, unknown> = {
    userId,
    type: notif.type,
    title: notif.title,
    message: notif.message,
  };
  if (notif.link) data.link = notif.link;
  // eslint-disable-next-line -- link field added via db push, not yet in generated client
  const entry = await (
    prisma.notification as unknown as {
      create: (args: { data: Record<string, unknown> }) => Promise<{ id: string; createdAt: Date }>;
    }
  ).create({ data });

  // Push real-time via WebSocket
  pushNotification(userId, {
    id: entry.id,
    type: notif.type,
    title: notif.title,
    message: notif.message,
    link: notif.link,
    createdAt: entry.createdAt.toISOString(),
  });
}

export interface NotificationDTO {
  id: string;
  type: string;
  title: string;
  message: string;
  isRead: boolean;
  link: string | null;
  conversationId: string | null;
  sourceEmailId: string | null;
  pendingActionId: string | null;
  pendingActionStatus: string | null;
  createdAt: string;
}

export async function getNotifications(
  userId: string,
  options?: { unreadOnly?: boolean; limit?: number },
): Promise<NotificationDTO[]> {
  const where: { userId: string; isRead?: boolean } = { userId };
  if (options?.unreadOnly) where.isRead = false;

  const rows = await (
    prisma.notification.findMany as (args: unknown) => Promise<Array<Record<string, unknown>>>
  )({
    where,
    orderBy: { createdAt: "desc" },
    take: options?.limit || 50,
    // Include linked PendingAction so the drawer knows whether approve/reject is still actionable.
    include: { pendingAction: { select: { status: true } } },
  });

  return rows.map((r: Record<string, unknown>) => {
    const pa = r.pendingAction as { status?: string } | null | undefined;
    return {
      id: r.id as string,
      type: r.type as string,
      title: r.title as string,
      message: r.message as string,
      isRead: r.isRead as boolean,
      link: (r.link as string | null) ?? null,
      conversationId: (r.conversationId as string | null) ?? null,
      sourceEmailId: (r.sourceEmailId as string | null) ?? null,
      pendingActionId: (r.pendingActionId as string | null) ?? null,
      pendingActionStatus: pa?.status ?? null,
      createdAt: (r.createdAt as Date).toISOString(),
    };
  });
}

export async function markNotificationRead(notificationId: string): Promise<void> {
  await prisma.notification.update({
    where: { id: notificationId },
    data: { isRead: true },
  });
  // Mirror the read state onto the FOLLOWUP queue entry, if one exists.
  await prisma.attentionItem.updateMany({
    where: { source: "NOTIFICATION", sourceId: notificationId, status: "OPEN" },
    data: { status: "DISMISSED", resolvedAt: new Date() },
  });
}

export async function markAllNotificationsRead(userId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true },
  });
  await prisma.attentionItem.updateMany({
    where: { userId, source: "NOTIFICATION", status: "OPEN" },
    data: { status: "DISMISSED", resolvedAt: new Date() },
  });
}

export async function clearNotifications(userId: string): Promise<void> {
  await prisma.notification.deleteMany({ where: { userId } });
  // Drop the mirrored queue entries — without this, the queue keeps showing
  // FOLLOWUP rows pointing at notifications that no longer exist.
  await prisma.attentionItem.deleteMany({ where: { userId, source: "NOTIFICATION" } });
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: meeting check has inherent nested logic (users → meetings → dedup → notify)
async function checkUpcomingMeetings() {
  try {
    // Check all users who have Google connected AND meeting automation enabled
    const usersWithGoogle = await prisma.userToken.findMany({
      where: { provider: "google" },
      select: { userId: true },
    });

    const now = Date.now();

    for (const { userId } of usersWithGoogle) {
      // Check if user has meetingAutoJoin enabled
      const config = await prisma.automationConfig.findUnique({
        where: { userId },
      });
      if (config && !config.meetingAutoJoin) continue;

      try {
        const meetings = await getUpcomingMeetings(userId);

        for (const meeting of meetings) {
          const startTime = new Date(meeting.start).getTime();
          const minutesUntil = (startTime - now) / 60_000;

          // Notify 5 minutes before meeting
          if (minutesUntil > 0 && minutesUntil <= 5) {
            const key = `meeting:${meeting.id}`;
            if (notifiedIds.has(key)) continue;

            // DB-based dedup: check if we already notified for this meeting (last 12 hours)
            const existingNotif = await prisma.notification.findFirst({
              where: {
                userId,
                type: "meeting",
                message: { contains: meeting.id },
                createdAt: { gte: new Date(Date.now() - 12 * 60 * 60 * 1000) },
              },
            });
            if (existingNotif) {
              notifiedIds.add(key);
              continue;
            }
            notifiedIds.add(key);

            const msg = meeting.meetingLink
              ? `Join link: ${meeting.meetingLink} [${meeting.id}]`
              : `${meeting.summary} starts soon [${meeting.id}]`;

            await addNotification(userId, {
              type: "meeting",
              title: `Meeting in ${Math.ceil(minutesUntil)} min: ${meeting.summary}`,
              message: msg,
              link: meeting.meetingLink || "/briefing",
            });

            // Also send browser push with meeting link. AWAIT it: the call is
            // async (DB gate/rate-limit writes), so leaving it unawaited lets a
            // rejection escape this try/catch onto a later microtask — with no
            // unhandledRejection handler that can crash the dyno. Pass the
            // "meeting" category so a user with notifyMeeting=false isn't pushed
            // (the default "system" category bypasses that opt-out).
            try {
              const { sendPushNotification } = await import("./push.js");
              await sendPushNotification(
                userId,
                {
                  title: `Meeting in ${Math.ceil(minutesUntil)} min`,
                  body: meeting.summary,
                  url: meeting.meetingLink || "/briefing",
                },
                "meeting",
              );
            } catch (err) {
              console.warn("[BACKGROUND] meeting push failed", err);
            }

            console.log(
              `[BG] Upcoming meeting: "${meeting.summary}" in ${Math.ceil(minutesUntil)}min for user ${userId}`,
            );
          }
        }
      } catch {
        // Individual user's Google might be expired — skip
      }
    }
  } catch {
    // Meeting check is optional
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startBackgroundAgent() {
  if (intervalId) return;

  console.log("[BG] Background agent started (60s interval)");

  // Run immediately once
  checkUpcomingMeetings();

  // Then every 60 seconds — only meeting checks (task checks moved to autonomous-agent.ts)
  intervalId = setInterval(async () => {
    await checkUpcomingMeetings();
  }, 60_000);
}

export function stopBackgroundAgent() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("[BG] Background agent stopped");
  }
}
