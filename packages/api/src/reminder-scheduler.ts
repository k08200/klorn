/**
 * Reminder Scheduler — Checks for due reminders and delivers notifications
 *
 * Runs on a 30-second interval:
 * 1. Finds PENDING reminders where remindAt <= now
 * 2. Creates Notification records in DB
 * 3. Pushes real-time notifications via WebSocket
 * 4. Updates reminder status to SENT
 */

import { prisma } from "./db.js";
import { sendPushNotification } from "./push.js";
import { captureError } from "./sentry.js";
import { pushNotification } from "./websocket.js";

let intervalId: ReturnType<typeof setInterval> | null = null;

const CHECK_INTERVAL_MS = 30_000; // 30 seconds
const MAX_DIRECT_TIMER_MS = 5 * 60_000;

type ReminderRecord = {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  remindAt: Date;
};

async function deliverReminder(reminder: ReminderRecord): Promise<boolean> {
  const msg = reminder.description || `Reminder: ${reminder.title}`;

  const updated = await prisma.reminder.updateMany({
    where: {
      id: reminder.id,
      status: "PENDING",
      remindAt: { lte: new Date() },
    },
    data: { status: "SENT" },
  });
  if (updated.count === 0) return false;

  // We already claimed the reminder (PENDING -> SENT) above. If creating the
  // notification fails now, the reminder would be marked delivered with nothing
  // actually delivered — permanent loss. Revert to PENDING so the next tick
  // retries (a duplicate delivery is strictly better than a lost reminder).
  let notification: Awaited<ReturnType<typeof prisma.notification.create>>;
  try {
    notification = await prisma.notification.create({
      data: {
        userId: reminder.userId,
        type: "reminder",
        title: reminder.title,
        message: msg,
      },
    });
  } catch (err) {
    await prisma.reminder
      .updateMany({ where: { id: reminder.id }, data: { status: "PENDING" } })
      .catch(() => {});
    console.error(
      `[REMINDER] notification create failed for ${reminder.id}, reverted to PENDING:`,
      err,
    );
    captureError(err, { tags: { scope: "reminder.deliver" }, extra: { reminderId: reminder.id } });
    return false;
  }

  // Push real-time notification via WebSocket
  pushNotification(reminder.userId, {
    id: notification.id,
    type: "reminder",
    title: reminder.title,
    message: msg,
    createdAt: notification.createdAt.toISOString(),
  });

  // Send browser push notification
  sendPushNotification(reminder.userId, {
    title: reminder.title,
    body: msg,
    url: "/chat",
    notificationId: notification.id,
  }).catch((err) => {
    console.error(`[REMINDER] Push delivery failed for ${reminder.id}:`, err);
    captureError(err, {
      tags: { scope: "reminder.push", userId: reminder.userId },
      extra: { reminderId: reminder.id },
    });
  });

  console.log(`[REMINDER] Delivered: "${reminder.title}" to user ${reminder.userId}`);
  return true;
}

export async function deliverDueReminderById(reminderId: string): Promise<boolean> {
  const reminder = await prisma.reminder.findFirst({
    where: {
      id: reminderId,
      status: "PENDING",
      remindAt: { lte: new Date() },
    },
  });
  if (!reminder) return false;

  return deliverReminder(reminder);
}

export function scheduleReminderDeliveryCheck(reminderId: string, remindAt: Date): boolean {
  const delayMs = remindAt.getTime() - Date.now();
  if (delayMs < 0 || delayMs > MAX_DIRECT_TIMER_MS) return false;

  const timer = setTimeout(() => {
    deliverDueReminderById(reminderId).catch((err) => {
      console.error(`[REMINDER] Direct delivery check failed for ${reminderId}:`, err);
      captureError(err, { tags: { scope: "reminder.direct-delivery", reminderId } });
    });
  }, delayMs + 500);
  timer.unref?.();
  return true;
}

export async function deliverDueReminders(userId?: string): Promise<{
  found: number;
  delivered: number;
}> {
  const now = new Date();

  const dueReminders = await prisma.reminder.findMany({
    where: {
      ...(userId ? { userId } : {}),
      status: "PENDING",
      remindAt: { lte: now },
    },
  });

  if (dueReminders.length === 0) return { found: 0, delivered: 0 };

  console.log(`[REMINDER] Found ${dueReminders.length} due reminder(s)`);

  let delivered = 0;
  for (const reminder of dueReminders) {
    if (await deliverReminder(reminder)) delivered++;
  }

  return { found: dueReminders.length, delivered };
}

async function checkDueReminders() {
  try {
    await deliverDueReminders();
  } catch (err) {
    console.error("[REMINDER] Scheduler error:", err);
  }
}

/** Start the reminder scheduler */
export function startReminderScheduler() {
  if (intervalId) return; // already running

  console.log("[REMINDER] Scheduler started (checking every 30s)");

  // Run immediately on start
  checkDueReminders();

  // Then check periodically
  intervalId = setInterval(checkDueReminders, CHECK_INTERVAL_MS);
}

/** Stop the reminder scheduler */
export function stopReminderScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("[REMINDER] Scheduler stopped");
  }
}
