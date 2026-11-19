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

import type {
  DesktopAlertKind,
  NotificationCenterFields,
  NotificationPresentation,
  NotificationRow,
} from "@klorn/contract";
import { HIDDEN_CLAIM_TYPE, REPLY_CLAIM_ROWS } from "./agentcore/auto-reply-ledger-keys.js";
import { pushPresentationOpenTo } from "./config.js";
import { prisma } from "./db.js";
import { escapeLikePattern } from "./db-like.js";
import { INTERRUPT_SLOT_ROOT } from "./judge/v3/interrupt-budget.js";
import { desktopAlertTag } from "./notify/desktop-alert.js";
import { meetPushCopy, type PushCopy } from "./notify/kind-push-copy.js";
import { getUserNotificationLanguage } from "./notify/notification-strings.js";
import { meetingPresentation } from "./notify/push-presentation.js";
import { NOTIFIED_LOOKBACK_MS } from "./notify/urgent-dedup.js";
import { isCalendarRowVisible } from "./pim/calendar-scope.js";
import { getUpcomingMeetings } from "./pim/meeting.js";
import { captureDbFailure, logDbFailure } from "./report-db-failure.js";
import { recordSchedulerTick, registerScheduler } from "./scheduler-heartbeat.js";
import { pushNotification } from "./websocket.js";
import { newWork } from "./work-context.js";

// In-memory cache only used to skip redundant DB queries within same process lifetime.
// Actual dedup is DB-based (survives server restarts).
const notifiedIds: Set<string> = new Set();
// Cap the in-memory dedup cache so it can't grow unbounded on a long-lived
// dyno. The DB findFirst (12h window) is the real dedup, so clearing this only
// costs a few extra queries until it refills.
const MAX_NOTIFIED_IDS = 1000;
// Self-overlap guard: skip a tick if the previous one is still running, so a
// slow tick on its own setInterval never runs the body twice.
let meetingCheckInFlight = false;

async function addNotification(
  userId: string,
  notif: {
    type: string;
    title: string;
    message: string;
    link?: string;
    alert?: DesktopAlertKind;
    /** NT0 structured fields for the live frame (first-party: carried as given). */
    presentation?: NotificationPresentation;
  },
): Promise<{ id: string }> {
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
    ...(notif.alert ? { alert: notif.alert } : {}),
    ...(notif.presentation ?? {}),
  });
  return { id: entry.id };
}

/** A bell row as stored: @klorn/contract NotificationRow without the notification center fields. */
export type NotificationDTO = Omit<NotificationRow, keyof NotificationCenterFields>;

export async function getNotifications(
  userId: string,
  options?: { unreadOnly?: boolean; limit?: number },
): Promise<NotificationDTO[]> {
  // Hidden claims (in-flight or cleared unattended-reply locks) and rows the
  // user cleared are not bell entries.
  const where: {
    userId: string;
    type: { not: string };
    clearedAt: null;
    isRead?: boolean;
  } = {
    userId,
    type: { not: HIDDEN_CLAIM_TYPE },
    clearedAt: null,
  };
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

/**
 * Mark one of the user's bell rows read; false when there is no such row. The
 * write itself is scoped: another user's row, a missing one, a hidden claim and
 * a row cleared from the bell match nothing, the same rows the bell never shows.
 * One conditional statement, so a "Clear all" that deletes or hides the row
 * while this runs ends as "not found", never as an update of a row that is gone
 * (Prisma P2025, a 500).
 */
export async function markNotificationRead(
  userId: string,
  notificationId: string,
): Promise<boolean> {
  const { count } = await prisma.notification.updateMany({
    where: { id: notificationId, userId, type: { not: HIDDEN_CLAIM_TYPE }, clearedAt: null },
    data: { isRead: true },
  });
  if (count === 0) return false;
  // Mirror the read state onto the FOLLOWUP queue entry, if one exists.
  await prisma.attentionItem.updateMany({
    where: { userId, source: "NOTIFICATION", sourceId: notificationId, status: "OPEN" },
    data: { status: "DISMISSED", resolvedAt: new Date() },
  });
  return true;
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

/** Bell rows that clearing hides instead of deleting: reply locks and interrupt slots. */
const KEPT_NOTIFICATION_ROWS = {
  OR: [...REPLY_CLAIM_ROWS.OR, { dedupeKey: { startsWith: INTERRUPT_SLOT_ROOT } }],
};

/**
 * "Clear all": empty the bell. A UI action only, so it never makes anything ring
 * again. The "already notified?" reads look back over bell rows (urgent mail by
 * its marker, the day's briefing by its dedupeKey, proactive nudges by type and
 * day, a meeting alert by its event), so a row still inside that look-back is
 * hidden, not deleted: read, with clearedAt set, and kept as it was otherwise.
 * Deleting those rows made the urgent sweep ring the same unread mail again on
 * every channel (2026-11-14). Older rows no read looks at are deleted, and the
 * log-retention sweep deletes cleared rows after 30 days.
 */
export async function clearNotifications(userId: string): Promise<void> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - NOTIFIED_LOOKBACK_MS);
  // Unattended-reply claims (`auto-reply:` / legacy `auto-mode-reply:`) are
  // at-most-once LOCKS: deleting one lets a still-OPEN failed item be
  // re-drafted and re-sent. They are hidden instead (read + hidden type) at
  // any age, so the bell is visually cleared and the lock stays.
  // Interrupt-budget slots (`interrupt:<day>:<n>`, attention engine v3) are
  // kept the same way: deleting one would hand the day's spent budget back.
  // The explicit `dedupeKey: null` branch matters: SQL `NOT (col LIKE ..)` is
  // NULL, not true, for a NULL column, so ordinary rows would otherwise survive.
  const ordinaryRows = { OR: [{ dedupeKey: null }, { NOT: KEPT_NOTIFICATION_ROWS.OR }] };
  await prisma.notification.deleteMany({
    where: { userId, ...ordinaryRows, createdAt: { lt: cutoff } },
  });
  await prisma.notification.updateMany({
    // Up to the click: a row written while this runs is not one the user saw.
    where: { userId, ...ordinaryRows, createdAt: { gte: cutoff, lte: now }, clearedAt: null },
    data: { clearedAt: now, isRead: true },
  });
  await prisma.notification.updateMany({
    where: { userId, ...KEPT_NOTIFICATION_ROWS, type: { not: HIDDEN_CLAIM_TYPE } },
    data: { type: HIDDEN_CLAIM_TYPE, isRead: true },
  });
  // Drop the mirrored queue entries — without this, the queue keeps showing
  // FOLLOWUP rows pointing at notifications the bell no longer shows.
  await prisma.attentionItem.deleteMany({ where: { userId, source: "NOTIFICATION" } });
}

/** Where a meeting push opens when its event has no page to open. */
const CALENDAR_PATH = "/calendar";

/**
 * Where the meeting-starting-soon push opens: the event's own page, which
 * shows its join link. Never the join link itself: the service worker opens
 * app paths only (sw.js appPath; an https url fell back to /chat), and the
 * link comes from an invite anyone can send. The page is the user's own synced
 * row for this Google event id; without one (not synced yet), or when the
 * lookup fails, the push still rings and opens the calendar.
 */
async function meetingPushPath(userId: string, googleEventId: string): Promise<string> {
  if (!googleEventId) return CALENDAR_PATH;
  try {
    const row = await prisma.calendarEvent.findUnique({
      where: { userId_googleId: { userId, googleId: googleEventId } },
      select: { id: true, sourceAccountId: true, provider: true },
    });
    // A row the event page would refuse (calendar-scope.ts) opens the calendar.
    if (!row || !isCalendarRowVisible(row)) return CALENDAR_PATH;
    return `${CALENDAR_PATH}/${encodeURIComponent(row.id)}`;
  } catch (err) {
    logDbFailure("[BACKGROUND] meeting event lookup failed", err, { ids: { userId } });
    return CALENDAR_PATH;
  }
}

/**
 * The start ring's device push text. NOTIFY_PUSH_PRESENTATION open to the
 * user: the NT0 meet copy (title = the event, body = "3분 후 · Google Meet ·
 * 3명"), in their language. Otherwise exactly what it always was.
 */
async function meetingStartCopy(
  userId: string,
  meeting: { summary: string; attendeeCount?: number | null },
  minutesUntil: number,
  presentation: { joinUrl?: string },
): Promise<PushCopy> {
  if (!pushPresentationOpenTo(userId)) {
    return { title: `Meeting in ${Math.ceil(minutesUntil)} min`, body: meeting.summary };
  }
  return meetPushCopy({
    eventTitle: meeting.summary,
    startsInMinutes: minutesUntil,
    joinUrl: presentation.joinUrl,
    attendeeCount: meeting.attendeeCount,
    language: await getUserNotificationLanguage(userId),
  });
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: meeting check has inherent nested logic (users → meetings → dedup → notify)
async function checkUpcomingMeetings() {
  if (meetingCheckInFlight) return;
  meetingCheckInFlight = true;
  if (notifiedIds.size > MAX_NOTIFIED_IDS) notifiedIds.clear();
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
        // A failed live read falls back to the stored rows (pim/meeting.ts): the
        // T-60 heads-up left these meetings to this ring, so a Google outage
        // across the 5-minute window must not cost them their only alert.
        const meetings = await getUpcomingMeetings(userId, { storedOnFailure: true });

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
                message: { contains: escapeLikePattern(meeting.id) },
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

            // NT0 meet: the join link and how many people are invited, never who.
            const presentation = meetingPresentation(meeting.meetingLink, meeting.attendeeCount);
            // The bell row keeps the join link: the web bell validates it and
            // opens it outside the app (lib/notification-target.ts).
            const bellRow = await addNotification(userId, {
              type: "meeting",
              title: `Meeting in ${Math.ceil(minutesUntil)} min: ${meeting.summary}`,
              message: msg,
              link: meeting.meetingLink || "/briefing",
              // Meeting starting soon → OS banner in the desktop shell, under
              // the same "meeting" gate as the web push below.
              ...(await desktopAlertTag(userId, "meeting")),
              presentation,
            });

            // Also send the device push, which opens the event's page. AWAIT
            // it: the call is async (DB gate/rate-limit writes), so leaving it
            // unawaited lets a rejection escape this try/catch onto a later
            // microtask — with no unhandledRejection handler that can crash
            // the dyno. Pass the "meeting" category so a user with
            // notifyMeeting=false isn't pushed (the default "system" category
            // bypasses that opt-out).
            try {
              const { sendPushNotification } = await import("./notify/push.js");
              const copy = await meetingStartCopy(userId, meeting, minutesUntil, presentation);
              await sendPushNotification(
                userId,
                {
                  title: copy.title,
                  body: copy.body,
                  url: await meetingPushPath(userId, meeting.id),
                  // Web push tags its OS notification with the bell row, as
                  // an open tab does, so the meeting shows once.
                  bellNotificationId: bellRow.id,
                  presentation,
                },
                "meeting",
                // A meeting starting: an interrupt caller (push-bucket.ts).
                { bucket: "interrupt" },
              );
            } catch (err) {
              // A web-push error can quote the payload (the meeting title).
              logDbFailure("[BACKGROUND] meeting push failed", err, { ids: { userId } });
            }

            // Id, not title: an invite's title can quote a mail subject.
            console.log(
              `[BG] Upcoming meeting ${meeting.id} in ${Math.ceil(minutesUntil)}min for user ${userId}`,
            );
          }
        }
      } catch (err) {
        // A single user's check can fail (expired Google token, transient DB
        // error) — skip that user, but never silently: a systemic failure
        // (DB down, every token bad) must still surface a signal.
        logDbFailure("[BACKGROUND] meeting check failed for user", err, { ids: { userId } });
        captureDbFailure("[BACKGROUND] meeting check failed for user", err, {
          tags: { scope: "background.meeting-check-user" },
        });
      }
    }
  } catch (err) {
    // The whole sweep is best-effort, but a throw here aborted it for everyone
    // — surface it rather than hiding the outage.
    logDbFailure("[BACKGROUND] meeting check sweep failed", err);
    captureDbFailure("[BACKGROUND] meeting check sweep failed", err, {
      tags: { scope: "background.meeting-check" },
    });
  } finally {
    meetingCheckInFlight = false;
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startBackgroundAgent() {
  if (intervalId) return;

  console.log("[BG] Background agent started (60s interval)");
  registerScheduler("background-agent", 60_000);

  // Run immediately once
  newWork(checkUpcomingMeetings)();

  // Then every 60 seconds — only meeting checks (task checks moved to autonomous-agent.ts)
  intervalId = setInterval(
    newWork(async () => {
      recordSchedulerTick("background-agent");
      await checkUpcomingMeetings();
    }),
    60_000,
  );
}

export function stopBackgroundAgent() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("[BG] Background agent stopped");
  }
}
