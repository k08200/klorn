/**
 * Proactive Actions — Rule-based autonomous behaviors that run without LLM calls.
 *
 * These are the actions that make Klorn feel like a quiet decision layer:
 * 1. Unanswered email detection → reminder + follow-up draft suggestion
 * 2. Pre-meeting briefing → push notification 1 hour before
 * 3. Overdue task alerts → push notification
 * 4. Weekly review → summary notification every Monday
 * 5. End-of-day review → evening summary of what was done + tomorrow's priorities
 * 6. Deadline countdown → D-3 warning for upcoming task deadlines
 * 7. Contact context → enrich email notifications with sender history
 * 8. Follow-up draft suggestion → suggest sending a follow-up for unanswered emails
 * 9. Back-to-back meeting warning → alert when no break between meetings
 *
 * Called from automation-scheduler.ts every 60 seconds per user.
 * All actions are idempotent (dedup via DB notification check).
 */

import {
  DEADLINE_WARNING_DAYS,
  EOD_HOUR,
  MEETING_PREP_MINUTES,
  UNANSWERED_THRESHOLD_HOURS,
  WEEKLY_REVIEW_DAY,
} from "./config.js";
import { prisma } from "./db.js";
import { senderName } from "./notification-format.js";
import type { NotifCategory } from "./notification-prefs.js";
import { sendPushNotification } from "./push.js";
import { pushNotification } from "./websocket.js";

/** Check for emails that haven't been replied to in 48 hours */
async function checkUnansweredEmails(userId: string): Promise<void> {
  const threshold = new Date(Date.now() - UNANSWERED_THRESHOLD_HOURS * 60 * 60 * 1000);

  const unanswered = await prisma.emailMessage.findMany({
    where: {
      userId,
      isRead: true,
      needsReply: true,
      receivedAt: { lte: threshold, gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    },
    select: { id: true, from: true, subject: true, receivedAt: true },
    take: 5,
  });

  if (unanswered.length === 0) return;

  // Dedup: check if we already notified about unanswered emails today
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const existing = await prisma.notification.findFirst({
    where: {
      userId,
      type: "email_followup",
      createdAt: { gte: todayStart },
    },
  });
  if (existing) return;

  const emailList = unanswered
    .map((e) => `• ${senderName(e.from)} — "${truncate(e.subject || "Untitled", 40)}"`)
    .join("\n");

  const top = unanswered[0];
  const title = `${unanswered.length} reply pending`;
  const message = `Oldest thread: ${senderName(top.from)} — "${truncate(top.subject || "Untitled", 40)}"\n\n${emailList}`;

  await notify(userId, "email_followup", title, message, "/briefing");
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Send a notification 1 hour before meetings with a mini-brief */
async function checkUpcomingMeetings(userId: string): Promise<void> {
  const now = new Date();
  const soon = new Date(now.getTime() + MEETING_PREP_MINUTES * 60 * 1000);
  const justAfter = new Date(now.getTime() + (MEETING_PREP_MINUTES + 5) * 60 * 1000);

  // Find meetings starting in ~60 minutes (5 min window to avoid duplicates)
  const upcoming = await prisma.calendarEvent.findMany({
    where: {
      userId,
      startTime: { gte: soon, lte: justAfter },
    },
    select: {
      id: true,
      title: true,
      startTime: true,
      location: true,
      meetingLink: true,
      description: true,
    },
  });

  for (const event of upcoming) {
    // Dedup: check if we already sent a prep notification for this event
    const existing = await prisma.notification.findFirst({
      where: {
        userId,
        type: "calendar",
        title: { contains: event.title.slice(0, 20) },
        createdAt: { gte: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      },
    });
    if (existing) continue;

    const time = event.startTime.toLocaleTimeString("en-US", {
      timeZone: "Asia/Seoul",
      hour: "2-digit",
      minute: "2-digit",
    });
    const location = event.location ? ` @ ${event.location}` : "";
    const link = event.meetingLink ? `\nJoin: ${event.meetingLink}` : "";

    const message = `${event.title} starts at ${time}${location}${link}`;

    await notify(
      userId,
      "calendar",
      `Meeting in 1 hour: ${event.title.slice(0, 30)}`,
      message,
      "/briefing",
    );
  }
}

/** Alert on tasks that are past their due date */
async function checkOverdueTasks(userId: string): Promise<void> {
  const now = new Date();

  const overdue = await prisma.task.findMany({
    where: {
      userId,
      status: { not: "DONE" },
      dueDate: { lt: now },
    },
    select: { id: true, title: true, dueDate: true, priority: true },
    take: 5,
  });

  if (overdue.length === 0) return;

  // Dedup: check if we already notified about overdue tasks today
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const existing = await prisma.notification.findFirst({
    where: {
      userId,
      type: "task",
      title: { contains: "overdue" },
      createdAt: { gte: todayStart },
    },
  });
  if (existing) return;

  const taskList = overdue
    .map((t) => {
      const due = t.dueDate ? t.dueDate.toLocaleDateString("en-US") : "";
      return `- ${t.title} (due: ${due})`;
    })
    .join("\n");

  const message = `${overdue.length} task(s) past deadline:\n${taskList}`;

  await notify(userId, "task", `${overdue.length} overdue task(s)`, message, "/briefing");
}

/** Weekly review summary every Monday morning */
async function checkWeeklyReview(userId: string): Promise<void> {
  const now = new Date();
  if (now.getDay() !== WEEKLY_REVIEW_DAY) return;
  if (now.getHours() !== 9 || now.getMinutes() > 5) return;

  // Dedup: check if we already sent a weekly review this week
  const weekStart = new Date();
  weekStart.setHours(0, 0, 0, 0);
  const existing = await prisma.notification.findFirst({
    where: {
      userId,
      type: "review",
      createdAt: { gte: weekStart },
    },
  });
  if (existing) return;

  const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [completedTasks, emailCount, meetingCount] = await Promise.all([
    prisma.task.count({
      where: { userId, status: "DONE", updatedAt: { gte: lastWeek } },
    }),
    prisma.emailMessage.count({
      where: { userId, receivedAt: { gte: lastWeek } },
    }),
    prisma.calendarEvent.count({
      where: { userId, startTime: { gte: lastWeek, lte: now } },
    }),
  ]);

  const message = `Last week: ${completedTasks} tasks completed, ${emailCount} emails processed, ${meetingCount} meetings attended.`;

  await notify(userId, "review", "Weekly Review", message, "/briefing");
}

// ─── NEW: End-of-day review (6pm) ──────────────────────────────────────

/** Evening summary: what was done today + what's coming tomorrow */
async function checkEndOfDayReview(userId: string): Promise<void> {
  const now = new Date();
  if (now.getHours() !== EOD_HOUR || now.getMinutes() > 5) return;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  // Dedup
  const existing = await prisma.notification.findFirst({
    where: { userId, type: "eod_review", createdAt: { gte: todayStart } },
  });
  if (existing) return;

  const tomorrow = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowEnd = new Date(tomorrow.getTime() + 24 * 60 * 60 * 1000);

  const [completedToday, tomorrowTasks, tomorrowMeetings] = await Promise.all([
    prisma.task.count({
      where: { userId, status: "DONE", updatedAt: { gte: todayStart } },
    }),
    prisma.task.findMany({
      where: { userId, status: { not: "DONE" }, dueDate: { gte: tomorrow, lt: tomorrowEnd } },
      select: { title: true },
      take: 5,
    }),
    prisma.calendarEvent.findMany({
      where: { userId, startTime: { gte: tomorrow, lt: tomorrowEnd } },
      select: { title: true, startTime: true },
      orderBy: { startTime: "asc" },
      take: 5,
    }),
  ]);

  const parts: string[] = [`Today: ${completedToday} task(s) completed.`];

  if (tomorrowTasks.length > 0) {
    parts.push(`Tomorrow's tasks: ${tomorrowTasks.map((t) => t.title).join(", ")}`);
  }
  if (tomorrowMeetings.length > 0) {
    const meetingList = tomorrowMeetings.map((m) => {
      const time = m.startTime.toLocaleTimeString("en-US", {
        timeZone: "Asia/Seoul",
        hour: "2-digit",
        minute: "2-digit",
      });
      return `${time} ${m.title}`;
    });
    parts.push(`Tomorrow's meetings: ${meetingList.join(", ")}`);
  }
  if (tomorrowTasks.length === 0 && tomorrowMeetings.length === 0) {
    parts.push("Tomorrow looks clear.");
  }

  await notify(userId, "eod_review", "End of Day Summary", parts.join("\n"), "/briefing");
}

// ─── NEW: Deadline countdown (D-3) ─────────────────────────────────────

/** Warn about tasks with deadlines approaching in 3 days */
async function checkDeadlineCountdown(userId: string): Promise<void> {
  const now = new Date();
  const warningDate = new Date(now.getTime() + DEADLINE_WARNING_DAYS * 24 * 60 * 60 * 1000);

  const approaching = await prisma.task.findMany({
    where: {
      userId,
      status: { not: "DONE" },
      dueDate: { gt: now, lte: warningDate },
    },
    select: { id: true, title: true, dueDate: true },
    take: 5,
  });

  if (approaching.length === 0) return;

  // Dedup
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const existing = await prisma.notification.findFirst({
    where: { userId, type: "deadline", createdAt: { gte: todayStart } },
  });
  if (existing) return;

  const taskList = approaching
    .map((t) => {
      const days = Math.ceil(
        ((t.dueDate as Date).getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
      );
      return `- ${t.title} (D-${days})`;
    })
    .join("\n");

  await notify(
    userId,
    "deadline",
    `${approaching.length} deadline(s) approaching`,
    `These tasks are due within ${DEADLINE_WARNING_DAYS} days:\n${taskList}`,
    "/briefing",
  );
}

// ─── NEW: Contact context on emails ────────────────────────────────────

/** Enrich unanswered email notifications with contact history */
async function getContactContext(userId: string, fromEmail: string): Promise<string> {
  const email = fromEmail.match(/<([^>]+)>/)?.[1] || fromEmail.trim().toLowerCase();
  const contact = await prisma.contact.findFirst({
    where: { userId, email: { contains: email.split("@")[0], mode: "insensitive" } },
    select: { name: true, company: true, role: true, tags: true },
  });
  if (!contact) return "";
  const parts: string[] = [];
  if (contact.company) parts.push(contact.company);
  if (contact.role) parts.push(contact.role);
  if (contact.tags) parts.push(contact.tags);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

// ─── NEW: Follow-up draft suggestion ───────────────────────────────────

/** For 48h+ unanswered emails, suggest sending a follow-up */
async function checkFollowUpSuggestions(userId: string): Promise<void> {
  const threshold = new Date(Date.now() - 72 * 60 * 60 * 1000); // 72 hours (older than 48h check)

  const stale = await prisma.emailMessage.findMany({
    where: {
      userId,
      isRead: true,
      priority: { in: ["URGENT", "NORMAL"] },
      receivedAt: { lte: threshold, gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
      category: { notIn: ["automated", "newsletter"] },
    },
    select: { from: true, subject: true },
    take: 3,
  });

  if (stale.length === 0) return;

  // Dedup
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const existing = await prisma.notification.findFirst({
    where: { userId, type: "followup", createdAt: { gte: todayStart } },
  });
  if (existing) return;

  const suggestions = await Promise.all(
    stale.map(async (e) => {
      const from = e.from.replace(/[<>]/g, "").trim().slice(0, 25);
      const ctx = await getContactContext(userId, e.from);
      return `- ${from}${ctx}: "${(e.subject || "No subject").slice(0, 35)}"`;
    }),
  );

  await notify(
    userId,
    "followup",
    `${stale.length} email(s) may need a follow-up`,
    `These emails haven't been replied to in 3+ days. Want Klorn to draft a follow-up?\n${suggestions.join("\n")}`,
    "/chat",
  );
}

// ─── NEW: Back-to-back meeting warning ─────────────────────────────────

/** Detect consecutive meetings with no break and warn */
async function checkBackToBackMeetings(userId: string): Promise<void> {
  const now = new Date();
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);

  // Only check once in the morning (8-9am window)
  if (now.getHours() < 8 || now.getHours() > 9) return;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  // Dedup
  const existing = await prisma.notification.findFirst({
    where: { userId, type: "schedule_warning", createdAt: { gte: todayStart } },
  });
  if (existing) return;

  const events = await prisma.calendarEvent.findMany({
    where: { userId, startTime: { gte: now, lte: todayEnd } },
    select: { title: true, startTime: true, endTime: true },
    orderBy: { startTime: "asc" },
  });

  if (events.length < 2) return;

  // Find back-to-back (gap < 15 minutes)
  let backToBackCount = 0;
  for (let i = 0; i < events.length - 1; i++) {
    const gap = events[i + 1].startTime.getTime() - events[i].endTime.getTime();
    if (gap < 15 * 60 * 1000) backToBackCount++;
  }

  if (backToBackCount === 0) return;

  await notify(
    userId,
    "schedule_warning",
    `${backToBackCount} back-to-back meeting(s) today`,
    `You have ${events.length} meetings today with ${backToBackCount} gap(s) under 15 minutes. Consider blocking focus time.`,
    "/briefing",
  );
}

/** Create DB notification + WebSocket push + browser push */
async function notify(
  userId: string,
  type: string,
  title: string,
  message: string,
  url: string,
): Promise<void> {
  const notification = await prisma.notification.create({
    data: { userId, type, title, message, link: url },
  });

  pushNotification(userId, {
    id: notification.id,
    type,
    title,
    message,
    link: url,
    createdAt: notification.createdAt.toISOString(),
  });

  sendPushNotification(userId, { title, body: message.slice(0, 200), url }, categoryForType(type));
}

function categoryForType(type: string): NotifCategory {
  switch (type) {
    case "calendar":
    case "schedule_warning":
      return "meeting";
    case "task":
    case "deadline":
      return "task_due";
    case "email_followup":
    case "followup":
      return "agent_proposal";
    case "review":
    case "eod_review":
      return "daily_briefing";
    default:
      return "system";
  }
}

/**
 * Run all proactive actions for a user.
 * Called from automation-scheduler.ts every 60 seconds.
 */
export async function runProactiveActions(userId: string): Promise<void> {
  try {
    await Promise.allSettled([
      checkUnansweredEmails(userId),
      checkUpcomingMeetings(userId),
      checkOverdueTasks(userId),
      checkWeeklyReview(userId),
      checkEndOfDayReview(userId),
      checkDeadlineCountdown(userId),
      checkFollowUpSuggestions(userId),
      checkBackToBackMeetings(userId),
    ]);
  } catch (err) {
    console.error(`[PROACTIVE] Error for ${userId}:`, err);
  }
}
