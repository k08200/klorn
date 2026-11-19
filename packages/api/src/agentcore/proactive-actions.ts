/**
 * Proactive Actions — Rule-based autonomous behaviors that run without LLM calls.
 *
 * These are the actions that make Klorn feel like a quiet decision layer:
 * 1. Unanswered email detection → reminder + follow-up draft suggestion
 * 2. Pre-meeting briefing → push notification 1 hour before
 * 3. Overdue task alerts → push notification
 * 4. Weekly review → summary notification every Monday
 * 5. End-of-day review → evening push only when mail, commitments or tomorrow's early start need it
 * 6. Deadline countdown → D-3 warning for upcoming task deadlines
 * 7. Contact context → enrich email notifications with sender history
 * 8. Follow-up draft suggestion → suggest sending a follow-up for unanswered emails
 * 9. Back-to-back meeting warning → alert when no break between meetings
 *
 * Called from automation-scheduler.ts every 60 seconds per user.
 * All actions are idempotent (dedup via DB notification check).
 */

import type { NotificationKind, NotificationPresentation } from "@klorn/contract";
import {
  DEADLINE_WARNING_DAYS,
  EOD_HOUR,
  MEETING_PREP_MINUTES,
  pushPresentationOpenTo,
  pushQuoteOpenTo,
  UNANSWERED_THRESHOLD_HOURS,
  WEEKLY_REVIEW_DAY,
  waitDigestOpenTo,
} from "../config.js";
import { prisma } from "../db.js";
import { resolveTierReason } from "../judge/tier-reason-strings.js";
import { parseAddress } from "../mail/email-address.js";
import { clampText } from "../notify/clamp-text.js";
import { meetPushCopy } from "../notify/kind-push-copy.js";
import { inMorningWindow } from "../notify/morning-window.js";
import type { NotifCategory } from "../notify/notification-prefs.js";
import { getUserNotificationLanguage } from "../notify/notification-strings.js";
import { sendPushNotification } from "../notify/push.js";
import { meetingPresentation } from "../notify/push-presentation.js";
import { sendSms } from "../notify/sms.js";
import { dedupeCalendarEvents } from "../pim/calendar-dedupe.js";
import { countCalendarRows } from "../pim/calendar-read.js";
import { calendarSourceScope } from "../pim/calendar-scope.js";
import { captureDbFailure, logDbFailure } from "../report-db-failure.js";
import { isUniqueViolation } from "../slack/unique-violation.js";
import {
  isLocalTimeWithin,
  localDayOfWeek,
  localDayUtcRange,
  localMinuteOfDay,
  normalizeTimeZone,
} from "../time-zone.js";
import { pushNotification } from "../websocket.js";
import {
  composeEveningReview,
  eveningReviewHasContent,
  gatherEveningReviewInput,
} from "./evening-review.js";
import { leftToStartRing, meetingStartRingCovers, ringsAtStart } from "./meeting-start-ring.js";
import {
  contactContextLabel,
  followUpContent,
  replyWaitContent,
  type WaitingMail,
} from "./reply-wait-content.js";

/** The user's configured IANA timezone (defaults to the product default). */
async function getUserTimeZone(userId: string): Promise<string> {
  const config = await prisma.automationConfig.findUnique({
    where: { userId },
    select: { timezone: true },
  });
  return normalizeTimeZone(config?.timezone);
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** The oldest mail the unanswered reminder (flag off) still lists. */
const UNANSWERED_MAX_AGE_DAYS = 7;
/** The follow-up suggestion: older than this, up to FOLLOW_UP_MAX_AGE_DAYS. */
const FOLLOW_UP_MIN_AGE_HOURS = 72;
const FOLLOW_UP_MAX_AGE_DAYS = 14;
/**
 * Rows read per reminder before one-per-thread folding: the title counts what
 * waits, so the read is not cut to the lines shown.
 */
const REPLY_WAIT_SCAN = 100;
/** Follow-up lines that get a contact lookup (the ones listed). */
const FOLLOW_UP_LISTED = 3;
/** Both reminder types: the merged one dedupes against either, so a flip mid-day never sends twice. */
const REPLY_WAIT_TYPES = ["email_followup", "followup"];
/**
 * The heads-up's "starts in" figure is floored to this step: a meeting the
 * 5-minute window first sees 60–65 minutes out reads "in 1 hr", not a figure
 * that jitters with the tick ("in 1 hr 4 min").
 */
const HEADS_UP_STEP_MINUTES = 5;
/** Bell-row dedupe key of a meeting heads-up: one per calendar row and start time. */
const MEETING_PREP_KEY_PREFIX = "meeting-prep:";
/** The push body cap (the bell row keeps the whole message). */
const PUSH_BODY_MAX = 200;

/**
 * Most important first, deterministically: URGENT before NORMAL before LOW
 * (EmailPriority's declaration order, which Postgres sorts enums by), then the
 * judge's reply confidence, then the mail that has waited longest; the id
 * breaks every remaining tie.
 */
const REPLY_WAIT_ORDER = [
  { priority: "asc" as const },
  { needsReplyConfidence: "desc" as const },
  { receivedAt: "asc" as const },
  { id: "asc" as const },
];

/**
 * Bulk mail stays out. `category NOT IN (...)` alone is NULL for a mail with
 * no category, which drops it: the null branch keeps unclassified mail in.
 */
const NOT_BULK = [{ category: null }, { category: { notIn: ["automated", "newsletter"] } }];

const WAITING_SELECT = {
  id: true,
  from: true,
  subject: true,
  receivedAt: true,
  threadId: true,
} as const;

/** One mail per thread, the first in order: a back-and-forth is one thing to answer. */
function oneMailPerThread<T extends { id: string; threadId: string | null }>(
  rows: readonly T[],
): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = row.threadId ?? `id:${row.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The single reminder's reason: its item's short reason, resolved for the reader. */
async function withReason(
  userId: string,
  mails: WaitingMail[],
  language: string,
): Promise<WaitingMail[]> {
  if (mails.length !== 1) return mails;
  try {
    const [item] = await prisma.attentionItem.findMany({
      where: { userId, source: "EMAIL", sourceId: { in: [mails[0].id] } },
      select: { sourceId: true, tierReason: true },
      take: 1,
    });
    const reason = item ? resolveTierReason(item.tierReason, language) : null;
    return [{ ...mails[0], reason }];
  } catch (err) {
    // The reason is a detail: the reminder goes out without it.
    logDbFailure("[PROACTIVE] wait reason read failed", err, { ids: { userId } });
    return mails;
  }
}

async function sentReplyWaitToday(userId: string, tz: string, types: string[]): Promise<boolean> {
  const todayStart = localDayUtcRange(new Date(), tz).gte;
  const existing = await prisma.notification.findFirst({
    where: { userId, type: { in: types }, createdAt: { gte: todayStart } },
  });
  return existing !== null;
}

async function notifyReplyWait(userId: string, rows: WaitingMail[]): Promise<void> {
  const language = await getUserNotificationLanguage(userId);
  const content = replyWaitContent(await withReason(userId, rows, language), language, new Date());
  if (!content) return;
  await notify(userId, "email_followup", content.title, content.message, "/briefing", {
    presentation: content.presentation,
  });
}

/**
 * Mail the user read and still owes a reply. Flag off: 48h to 7 days old, on
 * the first tick of the user's local day (as before). NOTIFY_WAIT_DIGEST open
 * to the user: the merged reminder (checkReplyWait) instead.
 */
async function checkUnansweredEmails(userId: string, tz: string): Promise<void> {
  if (waitDigestOpenTo(userId)) return checkReplyWait(userId, tz);
  // Dedupe before the (ordered, so sorted) read: same outcome, one cheap read a tick.
  if (await sentReplyWaitToday(userId, tz, ["email_followup"])) return;
  const now = Date.now();
  const rows = await prisma.emailMessage.findMany({
    where: {
      userId,
      isRead: true,
      needsReply: true,
      receivedAt: {
        lte: new Date(now - UNANSWERED_THRESHOLD_HOURS * HOUR_MS),
        gte: new Date(now - UNANSWERED_MAX_AGE_DAYS * DAY_MS),
      },
    },
    select: WAITING_SELECT,
    orderBy: REPLY_WAIT_ORDER,
    take: REPLY_WAIT_SCAN,
  });
  const mails = oneMailPerThread(rows);
  if (mails.length === 0) return;
  await notifyReplyWait(userId, mails);
}

/**
 * The merged reminder (NOTIFY_WAIT_DIGEST): one "wait" notification for every
 * mail that still needs the user's reply, UNANSWERED_THRESHOLD_HOURS to
 * FOLLOW_UP_MAX_AGE_DAYS old, bulk mail out, at any priority (needsReply is
 * the signal). Sent once per local day inside the morning window
 * (notify/morning-window.ts).
 */
async function checkReplyWait(userId: string, tz: string): Promise<void> {
  const now = new Date();
  if (!(await inMorningWindow(userId, tz, now))) return;
  if (await sentReplyWaitToday(userId, tz, REPLY_WAIT_TYPES)) return;
  const rows = await prisma.emailMessage.findMany({
    where: {
      userId,
      isRead: true,
      needsReply: true,
      receivedAt: {
        lte: new Date(now.getTime() - UNANSWERED_THRESHOLD_HOURS * HOUR_MS),
        gte: new Date(now.getTime() - FOLLOW_UP_MAX_AGE_DAYS * DAY_MS),
      },
      OR: NOT_BULK,
    },
    select: WAITING_SELECT,
    orderBy: REPLY_WAIT_ORDER,
    take: REPLY_WAIT_SCAN,
  });
  const mails = oneMailPerThread(rows);
  if (mails.length === 0) return;
  await notifyReplyWait(userId, mails);
}

/**
 * A heads-up MEETING_PREP_MINUTES before a meeting, once per meeting (NT0
 * item 11: one meeting, one notification). A meeting the start ring
 * (background.ts) will announce — and a linked-calendar copy of it — is left
 * to it (meeting-start-ring.ts); an invite present in the primary and a linked
 * calendar (two rows, C2) counts once; and the bell row's
 * dedupe key (the event row and its start) makes the write the dedupe, so
 * overlapping ticks cannot both ring and two meetings that share a title
 * prefix no longer hide each other.
 */
async function checkUpcomingMeetings(userId: string, tz: string): Promise<void> {
  const now = new Date();
  const soon = new Date(now.getTime() + MEETING_PREP_MINUTES * 60 * 1000);
  const justAfter = new Date(now.getTime() + (MEETING_PREP_MINUTES + 5) * 60 * 1000);

  // Find meetings starting in ~60 minutes (5 min window; the dedupe key keeps it to one ring)
  const rows = await prisma.calendarEvent.findMany({
    where: {
      userId,
      startTime: { gte: soon, lte: justAfter },
      ...calendarSourceScope(),
    },
    select: {
      id: true,
      title: true,
      startTime: true,
      location: true,
      meetingLink: true,
      description: true,
      provider: true,
      externalId: true,
      sourceAccountId: true,
      attendeeCount: true,
    },
    orderBy: [{ startTime: "asc" }, { id: "asc" }],
  });
  const events = dedupeCalendarEvents(rows);
  if (events.length === 0) return;
  const covers = events.some(ringsAtStart) && (await meetingStartRingCovers(userId, justAfter));
  const leftOut = leftToStartRing(events, covers);
  // The join link is meeting content: on Apple's / Google's push only under NOTIFY_PUSH_QUOTE.
  const linkInPush = pushQuoteOpenTo(userId);
  // NT0 meet copy for the device push (the bell row keeps its text).
  const language = pushPresentationOpenTo(userId)
    ? await getUserNotificationLanguage(userId)
    : null;

  for (const event of events) {
    if (leftOut.has(event)) continue;
    const time = event.startTime.toLocaleTimeString("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
    });
    const location = event.location ? ` @ ${event.location}` : "";
    const link = event.meetingLink ? `\nJoin: ${event.meetingLink}` : "";

    const message = `${event.title} starts at ${time}${location}${link}`;
    const presentation = meetingPresentation(event.meetingLink, event.attendeeCount);
    const nt = language
      ? meetPushCopy({
          eventTitle: event.title,
          startsInMinutes: headsUpMinutes(event.startTime, now),
          joinUrl: presentation.joinUrl,
          attendeeCount: event.attendeeCount,
          language,
        })
      : null;
    const pushBody = linkInPush ? message : `${event.title} starts at ${time}${location}`;

    const rang = await notify(
      userId,
      "calendar",
      `Meeting in 1 hour: ${event.title.slice(0, 30)}`,
      message,
      "/briefing",
      {
        pushTitle: nt?.title,
        pushBody: nt?.body ?? pushBody,
        dedupeKey: `${MEETING_PREP_KEY_PREFIX}${event.id}:${event.startTime.getTime()}`,
        presentation,
      },
    );
    if (!rang) continue;

    // Admin-only SMS escalation for time-sensitive meeting alerts. Gated
    // inside sendSms (admin + phone + daily cap). Best-effort: never throws.
    sendSms(userId, `Urgent: ${event.title} starting at ${time}`).catch((err) => {
      logDbFailure("[PROACTIVE] Meeting SMS failed", err, { ids: { userId } });
      captureDbFailure("[PROACTIVE] Meeting SMS failed", err, {
        tags: { scope: "proactive.sms", userId },
      });
    });
  }
}

/** Minutes until a heads-up's meeting, floored to HEADS_UP_STEP_MINUTES. */
function headsUpMinutes(start: Date, now: Date): number {
  const minutes = (start.getTime() - now.getTime()) / MINUTE_MS;
  return Math.floor(minutes / HEADS_UP_STEP_MINUTES) * HEADS_UP_STEP_MINUTES;
}

/**
 * Whether a once-a-day task reminder (overdue, deadline) may go out now. Flag
 * off: on any tick — the day's dedupe makes it the first tick of the local
 * day, as before. NOTIFY_WAIT_DIGEST open to the user: inside the morning
 * window, like the reply-wait reminder, so it no longer rings just after local
 * midnight.
 */
async function dailyTaskReminderDue(userId: string, tz: string, now: Date): Promise<boolean> {
  if (!waitDigestOpenTo(userId)) return true;
  return inMorningWindow(userId, tz, now);
}

/** Alert on tasks that are past their due date */
async function checkOverdueTasks(userId: string, tz: string): Promise<void> {
  const now = new Date();
  if (!(await dailyTaskReminderDue(userId, tz, now))) return;

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
  const todayStart = localDayUtcRange(new Date(), tz).gte;
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
async function checkWeeklyReview(userId: string, tz: string): Promise<void> {
  const now = new Date();
  // Fire at 9am in the USER's timezone, not the server's UTC hour.
  if (localDayOfWeek(now, tz) !== WEEKLY_REVIEW_DAY) return;
  if (!isLocalTimeWithin(now, tz, 9)) return;

  // Dedup: check if we already sent a weekly review this week
  const weekStart = localDayUtcRange(new Date(), tz).gte;
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
    // An invite in the primary and a linked calendar is two rows (C2): counted once.
    countCalendarRows({ userId, when: { startTime: { gte: lastWeek, lte: now } } }),
  ]);

  const message = `Last week: ${completedTasks} tasks completed, ${emailCount} emails processed, ${meetingCount} meetings attended.`;

  await notify(userId, "review", "Weekly Review", message, "/briefing");
}

// ─── End-of-day review (EOD_HOUR, user-local) ──────────────────────────

/**
 * Evening review at EOD_HOUR in the user's timezone — sent only when something
 * is still open (evening-review.ts). An empty evening sends nothing; the dedupe
 * below still holds it to one review per local day.
 */
async function checkEndOfDayReview(userId: string, tz: string): Promise<void> {
  const now = new Date();
  if (!isLocalTimeWithin(now, tz, EOD_HOUR)) return;

  const todayStart = localDayUtcRange(now, tz).gte;
  const existing = await prisma.notification.findFirst({
    where: { userId, type: "eod_review", createdAt: { gte: todayStart } },
  });
  if (existing) return;

  const input = await gatherEveningReviewInput(userId, tz, now);
  if (!eveningReviewHasContent(input, tz)) return;
  const review = composeEveningReview(input, await getUserNotificationLanguage(userId), tz);
  if (!review) return;

  await notify(userId, "eod_review", review.title, review.message, "/briefing", {
    pushBody: review.pushBody,
  });
}

// ─── NEW: Deadline countdown (D-3) ─────────────────────────────────────

/** Warn about tasks with deadlines approaching in 3 days */
async function checkDeadlineCountdown(userId: string, tz: string): Promise<void> {
  const now = new Date();
  if (!(await dailyTaskReminderDue(userId, tz, now))) return;
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
  const todayStart = localDayUtcRange(new Date(), tz).gte;
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

/**
 * Enrich unanswered email notifications with contact history. The sender is
 * matched on the whole address: the From header is the sender's to write, so a
 * part of it (`ceo@` of ceo@evil.com, or an empty one) must not pick a contact.
 */
export async function getContactContext(userId: string, fromEmail: string): Promise<string> {
  const email = parseAddress(fromEmail);
  const contact = await prisma.contact.findFirst({
    where: { userId, email: { equals: email.trim(), mode: "insensitive" } },
    select: { name: true, company: true, role: true, tags: true },
  });
  return contact ? contactContextLabel(contact) : "";
}

// ─── NEW: Follow-up draft suggestion ───────────────────────────────────

/**
 * Mail that still needs a reply after FOLLOW_UP_MIN_AGE_HOURS: suggest a
 * follow-up. Skipped while NOTIFY_WAIT_DIGEST is open to the user: the merged
 * reminder covers this mail.
 */
async function checkFollowUpSuggestions(userId: string, tz: string): Promise<void> {
  if (waitDigestOpenTo(userId)) return;
  const now = Date.now();
  const rows = await prisma.emailMessage.findMany({
    where: {
      userId,
      isRead: true,
      needsReply: true,
      priority: { in: ["URGENT", "NORMAL"] },
      receivedAt: {
        lte: new Date(now - FOLLOW_UP_MIN_AGE_HOURS * HOUR_MS),
        gte: new Date(now - FOLLOW_UP_MAX_AGE_DAYS * DAY_MS),
      },
      OR: NOT_BULK,
    },
    select: WAITING_SELECT,
    orderBy: REPLY_WAIT_ORDER,
    take: REPLY_WAIT_SCAN,
  });
  const stale = oneMailPerThread(rows);
  if (stale.length === 0) return;
  if (await sentReplyWaitToday(userId, tz, ["followup"])) return;

  const withContext = await Promise.all(
    stale.map(async (e, i) => ({
      from: e.from,
      subject: e.subject,
      context: i < FOLLOW_UP_LISTED ? await getContactContext(userId, e.from) : "",
    })),
  );
  const language = await getUserNotificationLanguage(userId);
  const { title, message } = followUpContent(
    withContext,
    language,
    Math.floor(FOLLOW_UP_MIN_AGE_HOURS / 24),
  );
  await notify(userId, "followup", title, message, "/chat");
}

// ─── NEW: Back-to-back meeting warning ─────────────────────────────────

/** Detect consecutive meetings with no break and warn */
async function checkBackToBackMeetings(userId: string, tz: string): Promise<void> {
  const now = new Date();

  // Only check once in the morning (8-9am window) in the USER's timezone.
  const localHour = Math.floor(localMinuteOfDay(now, tz) / 60);
  if (localHour < 8 || localHour > 9) return;

  // User-local day boundaries (not server-UTC) so "rest of today's meetings"
  // and the daily dedup match the user's calendar day.
  const { gte: todayStart, lt: tomorrowStart } = localDayUtcRange(now, tz);
  const todayEnd = new Date(tomorrowStart.getTime() - 1);

  // Dedup
  const existing = await prisma.notification.findFirst({
    where: { userId, type: "schedule_warning", createdAt: { gte: todayStart } },
  });
  if (existing) return;

  const rows = await prisma.calendarEvent.findMany({
    where: { userId, startTime: { gte: now, lte: todayEnd }, ...calendarSourceScope() },
    // The identity fields let an invite present in the primary and a linked
    // calendar (two rows, C2) count once: a duplicate would read as a meeting
    // that starts before the previous one ends and raise a false warning.
    select: {
      title: true,
      startTime: true,
      endTime: true,
      provider: true,
      externalId: true,
      sourceAccountId: true,
    },
    orderBy: { startTime: "asc" },
  });
  const events = dedupeCalendarEvents(rows);

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

interface NotifyOptions {
  /** The device push's title when it should differ from the bell row's (NT0 copy). */
  pushTitle?: string;
  /** The device push's text when it should differ from the bell row's message. */
  pushBody?: string;
  /** NT0 structured fields; the type's kind (kindForType) when absent. */
  presentation?: NotificationPresentation;
  /**
   * The bell row's unique key: a second write under it fails on the
   * (userId, dedupeKey) unique, and nothing rings — so two overlapping ticks
   * cannot both notify.
   */
  dedupeKey?: string;
}

/** Create DB notification + WebSocket push + browser push. False when the dedupe key was taken. */
async function notify(
  userId: string,
  type: string,
  title: string,
  message: string,
  url: string,
  opts: NotifyOptions = {},
): Promise<boolean> {
  const notification = await createBellRow(userId, type, title, message, url, opts.dedupeKey);
  if (!notification) return false;
  const kind = kindForType(type);
  const presentation = opts.presentation ?? (kind ? { kind } : undefined);

  pushNotification(userId, {
    id: notification.id,
    type,
    title,
    message,
    link: url,
    createdAt: notification.createdAt.toISOString(),
    ...(presentation ?? {}),
  });

  // Unawaited (best-effort) but guarded — an unhandled rejection from the push
  // internals would otherwise crash the single dyno.
  sendPushNotification(
    userId,
    {
      title: opts.pushTitle ?? title,
      body: clampText(opts.pushBody ?? message, PUSH_BODY_MAX),
      url,
      presentation,
    },
    categoryForType(type),
    // Heuristic-decided: ambient even for a "meeting" category (a back-to-back
    // warning is not a meeting starting), so it cannot use up the interrupt
    // room real meeting alerts and urgent mail need (push-bucket.ts).
    { bucket: "ambient" },
  ).catch((err) => {
    logDbFailure("[PROACTIVE] push failed", err, { ids: { userId } });
    captureDbFailure("[PROACTIVE] push failed", err, {
      tags: { scope: "proactive.push", userId },
    });
  });
  return true;
}

async function createBellRow(
  userId: string,
  type: string,
  title: string,
  message: string,
  url: string,
  dedupeKey: string | undefined,
): Promise<{ id: string; createdAt: Date } | null> {
  try {
    return await prisma.notification.create({
      data: { userId, type, title, message, link: url, ...(dedupeKey ? { dedupeKey } : {}) },
    });
  } catch (err) {
    if (dedupeKey && isUniqueViolation(err)) return null;
    throw err;
  }
}

/**
 * The NT0 kind of a proactive notification (contract NotificationKind). The
 * reply-wait reminders name theirs; a meeting prep is a meeting; the rest are
 * rule-based heads-ups, read like the briefing (passive).
 */
function kindForType(type: string): NotificationKind | undefined {
  switch (type) {
    case "calendar":
      return "meet";
    case "followup":
      return "digest";
    case "review":
    case "eod_review":
    case "task":
    case "deadline":
    case "schedule_warning":
      return "brief";
    default:
      return undefined;
  }
}

/** Preferences, quiet hours and label only; the push rings ambient regardless. */
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
  // Each check is independent: one failing must not sink the others, and a
  // rejected check must leave a signal. allSettled never rejects, so an outer
  // try/catch can't see inner failures — inspect each settled result and
  // surface it (console for when Sentry is off, Sentry for when it's on), as facts.
  // Resolve the user's timezone once per tick and thread it into every check,
  // so each check fires/queries against the user's local day, not the server's
  // UTC day — and we don't issue one automationConfig lookup per check.
  const tz = await getUserTimeZone(userId);
  const checks: ReadonlyArray<readonly [string, Promise<unknown>]> = [
    ["unanswered", checkUnansweredEmails(userId, tz)],
    ["meetings", checkUpcomingMeetings(userId, tz)],
    ["overdue", checkOverdueTasks(userId, tz)],
    ["weekly", checkWeeklyReview(userId, tz)],
    ["eod", checkEndOfDayReview(userId, tz)],
    ["deadline", checkDeadlineCountdown(userId, tz)],
    ["followup", checkFollowUpSuggestions(userId, tz)],
    ["backToBack", checkBackToBackMeetings(userId, tz)],
  ];
  const results = await Promise.allSettled(checks.map(([, p]) => p));
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      const label = checks[i][0];
      logDbFailure("[PROACTIVE] check failed", r.reason, { ids: { check: label, userId } });
      captureDbFailure("[PROACTIVE] check failed", r.reason, {
        tags: { scope: `proactive.${label}`, userId },
      });
    }
  });
}
