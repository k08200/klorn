/**
 * Automation Scheduler — Executes user-configured automations
 *
 * Handles:
 * - Daily Briefing: generates and delivers at user's configured briefingTime
 * - Email Auto-Classify: periodically classifies inbox emails
 * - Calendar Auto-Sync: syncs Google Calendar every 15 minutes
 *
 * Runs every 60 seconds, checks all users with active automation configs.
 */

import { drainActionOutbox } from "./action-outbox.js";
import { findOpenEmailAttentionItemId } from "./attention-override.js";
import { sendAutoReplyViaFloor } from "./auto-reply-send.js";
import { createDailyBriefingDelivery } from "./briefing.js";
import {
  MULTI_INBOX_SYNC_ENABLED,
  SCHEDULER_CALENDAR_SYNC_INTERVAL_MS,
  SCHEDULER_CHECK_INTERVAL_MS,
  SCHEDULER_EMAIL_SYNC_INTERVAL_MS,
  SCHEDULER_RECONCILE_INTERVAL_MS,
  SCHEDULER_WATCH_RENEWAL_INTERVAL_MS,
} from "./config.js";
import { prisma } from "./db.js";
import { withDbRetry } from "./db-retry.js";
import { syncRecentCandidateIntakes } from "./email-candidate-intake.js";
import {
  backfillEmailAttentionItems,
  checkAutoReplyRules,
  generateSmartReply,
  reconcileEmails,
  reconcileLinkedInboxes,
  summarizeUnsummarizedEmails,
  syncEmails,
} from "./email-sync.js";
import { getAuthedClient, getLinkedInboxClients, renewExpiringGmailWatches } from "./gmail.js";
import { parseGoogleDateTime } from "./google-calendar-time.js";
import { formatUrgentEmailBody, senderName } from "./notification-format.js";
import { escalateUnackedPush } from "./phone-escalation.js";
import { runProactiveActions } from "./proactive-actions.js";
import { sendPushNotification } from "./push.js";
import { recordSchedulerTick, registerScheduler } from "./scheduler-heartbeat.js";
import { captureError } from "./sentry.js";
import { sendSms } from "./sms.js";
import { isEntitled, planHasFeature } from "./stripe.js";
import {
  localDateKey,
  localDayUtcRange,
  localMinuteOfDay,
  normalizeTimeZone,
} from "./time-zone.js";
import { buildUrgentDedupMessage, parseNotifiedGmailIds } from "./urgent-dedup.js";
import { pushNotification } from "./websocket.js";
import { withTimeout } from "./with-timeout.js";

let intervalId: ReturnType<typeof setInterval> | null = null;
// Self-overlap guard: true while a tick is mid-flight. The pg advisory lock is
// session-level and re-entrant on the same pooled connection, so it does NOT
// stop the scheduler from overlapping ITSELF when a tick runs longer than the
// interval — this boolean does. (dbHeartbeat + tryAcquireSchedulerLock both
// swallow their own errors, so this is always cleared on the paths below.)
let schedulerInFlight = false;

const CHECK_INTERVAL_MS = SCHEDULER_CHECK_INTERVAL_MS;
const WATCH_RENEWAL_INTERVAL_MS = SCHEDULER_WATCH_RENEWAL_INTERVAL_MS;

// Wall-clock bound on ONE user's per-tick work (calendar/email sync, reconcile,
// etc.). The scheduler processes users serially and awaits per-user work that
// calls Gmail via googleapis with no request timeout — a single hung call
// (network partition / Google-side stall) would otherwise stall the ENTIRE tick
// until an OS-level TCP timeout, starving every later user (fleet-wide outage
// from one bad account). Bounding each user isolates that hang so the loop moves
// on. Kept well under the 60s tick interval so a timed-out user can't overrun
// into the next tick. See withTimeout: this unblocks the loop but does not
// cancel the underlying hung call (AbortController into googleapis is a
// follow-up).
const PER_USER_AUTOMATION_TIMEOUT_MS = 30_000;
const DB_HEARTBEAT_ENABLED = process.env.DB_HEARTBEAT_ENABLED === "true";
const PROACTIVE_ACTIONS_ENABLED = process.env.PROACTIVE_ACTIONS_ENABLED === "true";
const PHONE_ESCALATION_ENABLED = process.env.PHONE_ESCALATION_ENABLED === "true";

// Stable 32-bit hash used as Postgres advisory lock key. Same int across
// every worker that imports this module — distributed mutual exclusion.
const SCHEDULER_LOCK_KEY = 0x4a47_454d; // "JIGE" + "M" reduced; arbitrary stable int

/**
 * Postgres session advisory lock. Try-and-skip if another worker holds it.
 * `pg_try_advisory_lock` returns true if acquired, false otherwise.
 * Release with `pg_advisory_unlock` at the end of the tick.
 *
 * Caveat (session lock + connection pool): the lock is held by the specific
 * pooled connection that ran `pg_try_advisory_lock`. If a later
 * `pg_advisory_unlock` happens to run on a DIFFERENT pooled connection it
 * returns false and the lock leaks until that connection is recycled (Postgres
 * frees session locks when the connection closes). Prod runs a single dyno, so
 * the lock is effectively a no-op safety net there and a leak only ever costs a
 * skipped tick (now logged below, never silent). A fully leak-proof design needs
 * a dedicated single connection or a row-based lease; deferred until N>1 dynos
 * make it worth the redesign risk.
 */
async function tryAcquireSchedulerLock(): Promise<boolean> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ locked: boolean }[]>(
      `SELECT pg_try_advisory_lock($1) AS locked`,
      SCHEDULER_LOCK_KEY,
    );
    return rows[0]?.locked === true;
  } catch (err) {
    console.warn("[AUTOMATION] advisory lock acquire failed:", err);
    return false;
  }
}

async function releaseSchedulerLock(): Promise<void> {
  try {
    // `pg_advisory_unlock` returns false (NOT an error) when this connection
    // does not hold the lock — the pooling caveat above. Surface it instead of
    // swallowing it, so a leaked lock is visible rather than a silent stall.
    const rows = await prisma.$queryRawUnsafe<{ unlocked: boolean }[]>(
      `SELECT pg_advisory_unlock($1) AS unlocked`,
      SCHEDULER_LOCK_KEY,
    );
    if (rows[0]?.unlocked !== true) {
      console.warn(
        "[AUTOMATION] advisory lock release returned false — lock was held on a different pooled connection and will self-heal on connection recycle",
      );
    }
  } catch (err) {
    console.warn("[AUTOMATION] advisory lock release failed:", err);
  }
}

// In-memory cache to skip redundant DB queries within same process lifetime.
// Actual dedup is DB-based (survives server restarts).
const briefingSentToday = new Map<string, string>(); // userId -> date string
let lastWatchRenewalAt = 0;
// UTC date ("YYYY-MM-DD") of the last OpenRouter catalog check. In-memory is
// fine — a restart re-running the check the same day is harmless (read-only).
let lastCatalogCheckDate = "";
// UTC date of the last calibration snapshot run. Same trade-off: the daily
// job upserts on (userId, dayKey), so a restart re-running it is idempotent.
let lastCalibrationSnapshotDate = "";
// UTC date of the last run of the weekly (Sunday) jobs. runAutomations() ticks
// every 60s, so a bare `getDay() === 0` guard fires these ~1440 times every
// Sunday; these in-memory date gates make them fire once (mirrors the catalog /
// calibration gates above).
let lastVoiceProfileDate = "";
let lastSenderTraitDate = "";
let lastLearnedRuleDate = "";

/** DB-based check: did we already send a briefing notification today? */
export async function hasBriefingBeenSentToday(userId: string, timeZone: string): Promise<boolean> {
  const today = localDayUtcRange(new Date(), timeZone);
  const existing = await prisma.notification.findFirst({
    where: {
      userId,
      type: "briefing",
      createdAt: { gte: today.gte, lt: today.lt },
    },
  });
  return !!existing;
}

/**
 * Per-user gate: "has at least INTERVAL_MIN minutes passed since the last
 * sync for this user?" The previous `minute % 15 === 0` check silently
 * skipped a whole 15-minute window whenever the 60-second tick landed on
 * minute :01 instead of :00 (server restart, busy loop, DB pause), so
 * brand-new emails could sit unsynced for 15–29 minutes. Tracking
 * per-user timestamps removes that class of misses.
 */
const lastEmailSyncAt = new Map<string, number>();
function isEmailSyncDue(userId: string): boolean {
  const last = lastEmailSyncAt.get(userId);
  if (!last) return true;
  return Date.now() - last >= SCHEDULER_EMAIL_SYNC_INTERVAL_MS;
}

const lastReconcileAt = new Map<string, number>();
function isReconcileDue(userId: string): boolean {
  const last = lastReconcileAt.get(userId);
  if (!last) return true;
  return Date.now() - last >= SCHEDULER_RECONCILE_INTERVAL_MS;
}

const lastCalendarSyncAt = new Map<string, number>();
function isCalendarSyncDue(userId: string): boolean {
  const last = lastCalendarSyncAt.get(userId);
  if (!last) return true;
  return Date.now() - last >= SCHEDULER_CALENDAR_SYNC_INTERVAL_MS;
}

async function notifyCandidateEmails(userId: string): Promise<void> {
  const candidateEmails = await prisma.emailMessage.findMany({
    where: {
      userId,
      syncedAt: { gte: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      attachments: {
        some: {
          OR: [
            { category: { in: ["resume", "profile", "portfolio", "audition"] } },
            { filename: { contains: "resume", mode: "insensitive" } },
            { filename: { contains: "cv", mode: "insensitive" } },
            { filename: { contains: "profile", mode: "insensitive" } },
            { filename: { contains: "portfolio", mode: "insensitive" } },
            { filename: { contains: "audition", mode: "insensitive" } },
            { filename: { contains: "casting", mode: "insensitive" } },
            { filename: { contains: "showreel", mode: "insensitive" } },
            { filename: { contains: "reel", mode: "insensitive" } },
            { filename: { contains: "headshot", mode: "insensitive" } },
            { filename: { contains: "comp card", mode: "insensitive" } },
            { filename: { contains: "comp-card", mode: "insensitive" } },
            { filename: { contains: "self tape", mode: "insensitive" } },
            { filename: { contains: "self-tape", mode: "insensitive" } },
            { filename: { contains: "actor", mode: "insensitive" } },
            { filename: { contains: "model", mode: "insensitive" } },
            { filename: { contains: "이력서" } },
            { filename: { contains: "프로필" } },
            { filename: { contains: "오디션" } },
            { filename: { contains: "캐스팅" } },
            { filename: { contains: "포트폴리오" } },
            { filename: { contains: "배우" } },
            { filename: { contains: "모델" } },
            { filename: { contains: "지원서" } },
            { filename: { contains: "상반신" } },
            { filename: { contains: "전신" } },
          ],
        },
      },
    },
    orderBy: { receivedAt: "desc" },
    take: 5,
    select: {
      id: true,
      from: true,
      subject: true,
      summary: true,
      attachments: { select: { id: true }, take: 3 },
    },
  });

  // Batch the dedup lookup: one query for all candidate emails instead of a
  // findFirst per email (N+1). The per-email create/push below stay in the loop
  // because they are genuine per-item side effects, not a foldable query.
  const notifiedRows = await prisma.notification.findMany({
    where: {
      userId,
      type: "email",
      OR: [{ title: "Candidate materials received" }, { title: "후보자 자료 도착" }],
      sourceEmailId: { in: candidateEmails.map((e) => e.id) },
    },
    select: { sourceEmailId: true },
  });
  // sourceEmailId is nullable in the schema; drop nulls so the dedup Set is
  // Set<string> and a future null row can't silently weaken the membership test.
  const alreadyNotified = new Set(
    notifiedRows.flatMap((n) => (n.sourceEmailId ? [n.sourceEmailId] : [])),
  );

  for (const email of candidateEmails) {
    if (alreadyNotified.has(email.id)) continue;

    const message = `${senderName(email.from)} · ${email.summary || email.subject}`;
    const notification = await prisma.notification.create({
      data: {
        userId,
        type: "email",
        title: "Candidate materials received",
        message,
        link: `/email/${email.id}`,
        sourceEmailId: email.id,
      },
      select: { id: true, createdAt: true },
    });
    pushNotification(userId, {
      id: notification.id,
      type: "email",
      title: "Candidate materials received",
      message,
      link: `/email/${email.id}`,
      createdAt: notification.createdAt.toISOString(),
    });
    sendPushNotification(
      userId,
      {
        title: "Candidate materials received",
        body: message,
        url: `/email/${email.id}`,
        notificationId: notification.id,
      },
      "email_candidate",
    ).catch((err) => {
      console.warn(`[AUTOMATION] Candidate email push failed for ${userId}:`, err);
      captureError(err, { tags: { scope: "automation.candidate-push", userId } });
    });
  }
}

/**
 * True if the scheduled briefing time has arrived or recently passed. Using
 * a small grace window prevents missed briefings when the 60-second tick
 * slips (server under load, restart, DB round-trip, etc.). We still rely on
 * DB-based dedup to avoid double-sending within the same day.
 */
export function isBriefingDue(
  briefingTime: string | null | undefined,
  timeZone: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!briefingTime) return false;
  const match = /^(\d{2}):(\d{2})$/.exec(briefingTime);
  if (!match) return false;
  const targetHour = Number(match[1]);
  const targetMinute = Number(match[2]);

  const targetMinutes = targetHour * 60 + targetMinute;
  const currentMinutes = localMinuteOfDay(now, normalizeTimeZone(timeZone));
  const delta = currentMinutes - targetMinutes;

  // Fire if we're within 60 minutes after the target. Don't fire early.
  // DB dedup (hasBriefingBeenSentToday) prevents double-sends within the window.
  return delta >= 0 && delta <= 60;
}

/**
 * Optional DB heartbeat. Keep this off on free serverless Postgres tiers:
 * Neon's free compute budget assumes scale-to-zero, and a 60s heartbeat is
 * effectively always-on. Paid deployments can enable it with
 * DB_HEARTBEAT_ENABLED=true when login latency matters more than idle cost.
 */
async function dbHeartbeat(): Promise<void> {
  if (!DB_HEARTBEAT_ENABLED) return;

  try {
    await withDbRetry(() => prisma.$queryRaw`SELECT 1`, {
      label: "scheduler.heartbeat",
      maxAttempts: 3,
    });
  } catch (err) {
    // Don't crash the scheduler on a stuck DB — the next tick will try again.
    console.warn("[AUTOMATION] DB heartbeat failed (will retry next tick):", err);
  }
}

// Title used both to create and to dedup the free-tier limit nudge, so the two
// stay in lockstep (a title drift would break the once-a-day guard).
const FREE_LIMIT_NUDGE_TITLE = "Daily free limit reached";
const FREE_LIMIT_NUDGE_MESSAGE =
  "You've reached today's free limit. Upgrade to Pro for unlimited classification and auto-handling.";

function startOfUtcDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * When a FREE user's classify cycle is stopped by the daily cost cap, drop one
 * in-app nudge per UTC day pointing at the upgrade path. No-op for entitled
 * users (paid/trial/admin) and — because isEntitled is always true then — a
 * no-op while the paywall is off. Best-effort: a failure here must never break
 * the tick, so it's caught and logged rather than propagated.
 */
export async function maybeNudgeFreeDailyLimit(
  userId: string,
  plan: string,
  role: string | undefined,
): Promise<void> {
  if (isEntitled(plan, role)) return;
  try {
    const existing = await prisma.notification.findFirst({
      where: {
        userId,
        type: "reminder",
        title: FREE_LIMIT_NUDGE_TITLE,
        createdAt: { gte: startOfUtcDay() },
      },
      select: { id: true },
    });
    if (existing) return;

    const notification = await prisma.notification.create({
      data: {
        userId,
        type: "reminder",
        title: FREE_LIMIT_NUDGE_TITLE,
        message: FREE_LIMIT_NUDGE_MESSAGE,
        link: "/settings",
      },
    });
    pushNotification(userId, {
      id: notification.id,
      type: "reminder",
      title: FREE_LIMIT_NUDGE_TITLE,
      message: FREE_LIMIT_NUDGE_MESSAGE,
      link: "/settings",
      createdAt: notification.createdAt.toISOString(),
    });
  } catch (err) {
    // The nudge is best-effort UX — never let it break the classify tick or
    // spam retries. Log a signal (console + captureError) instead of swallowing.
    console.warn(`[AUTOMATION] free-limit nudge failed for ${userId}:`, err);
    captureError(err, { tags: { scope: "automation.free-limit-nudge", userId } });
  }
}

/**
 * Detect the Prisma unique-violation used as an atomic at-most-once gate. Matches
 * the create-catch-P2002 idiom in briefing.ts / routes/webhook.ts: on P2002 the
 * create lost the race to a concurrent tick, so the loser skips its push.
 */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === "P2002";
}

/**
 * "Google disconnected" calendar alert — WINNER-ONLY and atomic, at most once per
 * user per local day. A `(userId, dedupeKey)` unique on Notification
 * (dedupeKey = "calendar-disconnect:<dayKey>") replaces the previous
 * findFirst-then-create (TOCTOU) so concurrent ticks can't double-create the alert
 * or double-push. The create is the gate: the P2002 loser returns null WITHOUT
 * pushing.
 */
export async function ensureCalendarDisconnectNotification(
  userId: string,
  dayKey: string,
): Promise<{ id: string; createdAt: Date } | null> {
  let notification: { id: string; createdAt: Date };
  try {
    notification = await prisma.notification.create({
      data: {
        userId,
        type: "calendar",
        dedupeKey: `calendar-disconnect:${dayKey}`,
        title: "Google disconnected",
        message: "Calendar sync stopped. Reconnect your Google account in settings.",
        link: "/settings",
      },
      select: { id: true, createdAt: true },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return null; // already alerted today → no re-push
    throw err;
  }

  pushNotification(userId, {
    id: notification.id,
    type: "calendar",
    title: "Google disconnected",
    message: "Reconnect your Google account in settings.",
    link: "/settings",
  });
  return notification;
}

/**
 * "Auto-reply sent" alert — WINNER-ONLY and atomic, at most once per replied
 * message. A `(userId, dedupeKey)` unique (dedupeKey = "auto-reply:<gmailId>")
 * replaces the findFirst-then-create (TOCTOU) so concurrent ticks can't
 * double-create/double-push the same auto-reply alert. The reply SEND itself is
 * unchanged and stays at the call site; only the alert dedup moves here.
 */
export async function ensureAutoReplyNotification(
  userId: string,
  gmailId: string,
  toAddr: string,
  ruleName: string,
): Promise<{ id: string; createdAt: Date } | null> {
  let notification: { id: string; createdAt: Date };
  try {
    notification = await prisma.notification.create({
      data: {
        userId,
        type: "email",
        dedupeKey: `auto-reply:${gmailId}`,
        title: "Auto-reply sent",
        message: `Auto-replied to ${toAddr} (rule: "${ruleName}") [${gmailId}]`,
      },
      select: { id: true, createdAt: true },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return null; // already alerted for this email
    throw err;
  }

  pushNotification(userId, {
    id: notification.id,
    type: "email",
    title: "Auto-reply sent",
    message: `Auto-replied to ${toAddr}`,
    createdAt: notification.createdAt.toISOString(),
  });
  return notification;
}

/**
 * Urgent-email bell notification — WINNER-ONLY and atomic. The read-based
 * notifiedGmailIds filter (parseNotifiedGmailIds) still does the primary
 * per-message dedup; this closes the residual concurrent-tick race on a single
 * batch via a `(userId, dedupeKey)` unique (dedupeKey = "urgent:<leadGmailId>").
 * `dbMessage` KEEPS the trailing `[id1,id2,…]` marker so every notified id is
 * recorded for the next tick's read-back — the accumulation logic is preserved.
 * The winner returns its notification so the CALLER runs the follow-on web-push /
 * SMS side-effects; a P2002 loser returns null and the caller skips them.
 */
export async function ensureUrgentEmailNotification(
  userId: string,
  leadGmailId: string,
  dbMessage: string,
  userBody: string,
): Promise<{ id: string; createdAt: Date } | null> {
  let notification: { id: string; createdAt: Date };
  try {
    notification = await prisma.notification.create({
      data: {
        userId,
        type: "email",
        dedupeKey: `urgent:${leadGmailId}`,
        title: "Urgent email",
        message: dbMessage,
      },
      select: { id: true, createdAt: true },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return null; // another tick already notified this batch
    throw err;
  }

  pushNotification(userId, {
    id: notification.id,
    type: "email",
    title: "Urgent email",
    message: userBody,
    createdAt: notification.createdAt.toISOString(),
  });
  return notification;
}

async function runAutomations() {
  recordSchedulerTick("automation");
  // Skip if this process is still running the previous tick (see schedulerInFlight).
  if (schedulerInFlight) return;
  schedulerInFlight = true;

  await dbHeartbeat();

  // Cross-worker mutual exclusion. If another container holds the lock,
  // skip this tick entirely — prevents duplicate briefings, sync, and pushes
  // when multiple Render dynos run in parallel.
  const acquired = await tryAcquireSchedulerLock();
  if (!acquired) {
    schedulerInFlight = false;
    return;
  }

  try {
    // Drain the action-execution outbox first: retry transient failures from
    // the inline approve fast-path and reclaim rows orphaned by a crash.
    // Cheap (one indexed query for due rows) and runs under the scheduler
    // lock, so no duplicate execution across dynos. A no-op when empty.
    // Awaited so the drain finishes INSIDE the scheduler lock — otherwise a
    // fire-and-forget drain can outlive the lock and run concurrently with the
    // next tick's drain, double-executing approved actions.
    try {
      const { completed, retried, dead, reclaimed } = await drainActionOutbox();
      if (completed + retried + dead + reclaimed > 0) {
        console.log(
          `[OUTBOX] drain: ${completed} completed, ${retried} retried, ${dead} dead, ${reclaimed} reclaimed`,
        );
      }
    } catch (err) {
      // Escalate: a systemic outbox failure must not look like a routine
      // advisory-lock false-release. Contained so the rest of the tick runs.
      console.error("[OUTBOX] drain errored:", err);
      captureError(err, { tags: { scope: "automation.outbox-drain" } });
    }

    // Gmail watch renewal runs once per hour regardless of configs.
    // It is a no-op when GMAIL_PUBSUB_TOPIC is unset or no watches are due.
    if (Date.now() - lastWatchRenewalAt >= WATCH_RENEWAL_INTERVAL_MS) {
      lastWatchRenewalAt = Date.now();
      renewExpiringGmailWatches()
        .then(({ renewed, failed }) => {
          if (renewed + failed > 0) {
            console.log(`[GMAIL-WATCH] Renewal: ${renewed} renewed, ${failed} failed`);
          }
        })
        .catch((err) => {
          console.warn("[GMAIL-WATCH] Renewal sweep errored:", err);
          captureError(err, { tags: { scope: "automation.gmail-watch-renewal" } });
        });
    }

    const BATCH_SIZE = 100;
    let cursor: string | undefined;
    // Every active userId seen across ALL batches this run. Used after the loop
    // to prune the per-user dedup Maps so they don't grow unbounded with users
    // who were later deleted/disabled (accumulate-then-prune, never per-batch —
    // a per-batch prune would evict users paginated into other batches).
    const activeUserIds = new Set<string>();

    for (;;) {
      const configs = await prisma.automationConfig.findMany({
        where: {
          OR: [
            { dailyBriefing: true },
            { emailAutoClassify: true },
            { autonomousAgent: true },
            { phoneEscalationEnabled: true },
            // A user who enabled ONLY proactive actions still needs a tick.
            { proactiveActions: true },
          ],
        },
        take: BATCH_SIZE,
        skip: cursor ? 1 : 0,
        cursor: cursor ? { userId: cursor } : undefined,
        orderBy: { userId: "asc" },
      });
      if (configs.length === 0) break;

      // Fetch user plans for feature gating
      const configUserIds = configs.map((c) => c.userId);
      for (const id of configUserIds) activeUserIds.add(id);
      const automationUsers = await prisma.user.findMany({
        where: { id: { in: configUserIds } },
        select: { id: true, plan: true, role: true },
      });
      // Keep role alongside plan so planHasFeature's ADMIN bypass works here too
      // — without it, an ADMIN on a FREE plan would have background jobs
      // silently suppressed once the paywall locks FREE.
      const automationPlanMap = new Map(
        automationUsers.map((u) => [u.id, { plan: u.plan, role: u.role }]),
      );

      // Pre-fetch which users have a Google token. Abandoned signups never
      // OAuth-connect, so trying to sync Gmail/Calendar for them throws
      // "Gmail not connected" on every tick — wasted DB+OAuth lookups and
      // log noise. One query per batch beats N per-user roundtrips.
      const googleTokens = await prisma.userToken.findMany({
        where: { userId: { in: configUserIds }, provider: "google" },
        select: { userId: true },
      });
      const googleConnectedUserIds = new Set(googleTokens.map((t) => t.userId));

      const ctx: UserCycleContext = { automationPlanMap, googleConnectedUserIds };

      for (const config of configs) {
        // Bound each user's per-tick work by wall-clock time. One hung Gmail
        // call (no request timeout in googleapis) would otherwise block every
        // later user in this serial loop until an OS-level TCP timeout — a
        // fleet-wide stall from a single bad account. On timeout/throw we log a
        // signal (console + Sentry) and CONTINUE to the next user. The NORMAL
        // fast path is unchanged: runUserCycle resolves well under the bound.
        // runUserCycle already isolates each sub-step (briefing/calendar/email)
        // in its own try/catch, so this wrapper only catches a top-level hang or
        // an unexpected escape — never double-logs a benign per-step error.
        try {
          await withTimeout(
            runUserCycle(config, ctx),
            PER_USER_AUTOMATION_TIMEOUT_MS,
            config.userId,
          );
        } catch (err) {
          console.warn(
            `[scheduler] user cycle skipped (timeout or error) for ${config.userId}:`,
            err instanceof Error ? err.message : String(err),
          );
          captureError(err, {
            tags: { scope: "scheduler.user-cycle" },
            extra: { userId: config.userId },
          });
        }
      }
      if (configs.length < BATCH_SIZE) break;
      cursor = configs[configs.length - 1].userId;
    }

    // Reclaim per-user dedup Map entries for users no longer in any automation
    // config (deleted/disabled). Pruned once against the full active set so a
    // user paginated into another batch is never wrongly evicted.
    for (const map of [briefingSentToday, lastEmailSyncAt, lastReconcileAt, lastCalendarSyncAt]) {
      for (const userId of map.keys()) {
        if (!activeUserIds.has(userId)) map.delete(userId);
      }
    }

    // Gate the once-per-day / once-per-week jobs below so they fire once, not on
    // every 60s tick. In-memory is fine: a restart re-running an idempotent job
    // the same day is harmless.
    const todayUtc = new Date().toISOString().slice(0, 10);
    const isSunday = new Date().getDay() === 0;

    // --- Weekly: Voice Profile Extraction (Sunday only) ---
    // Runs once per week for all users with Google connected. Each user is
    // skipped automatically if their profile was updated within the last 7 days.
    if (isSunday && lastVoiceProfileDate !== todayUtc) {
      lastVoiceProfileDate = todayUtc;
      import("./voice-profile-extractor.js")
        .then(({ extractVoiceProfilesForAllUsers }) => extractVoiceProfilesForAllUsers())
        .catch((err) => {
          console.error("[AUTOMATION] Voice profile extraction failed:", err);
          captureError(err, { tags: { scope: "automation.voice-profile" } });
        });
    }

    // --- Weekly: Sender Trait Extraction (Sunday only) ---
    // Off-hot-path per-user extraction of relationship/recurring_intent facts
    // (consumed by the judge only behind the SENDER_TRAITS_IN_JUDGE flag).
    if (isSunday && lastSenderTraitDate !== todayUtc) {
      lastSenderTraitDate = todayUtc;
      import("./sender-trait-extractor.js")
        .then(({ extractSenderTraitsForAllUsers }) => extractSenderTraitsForAllUsers())
        .catch((err) => {
          console.error("[AUTOMATION] Sender trait extraction failed:", err);
          captureError(err, { tags: { scope: "automation.sender-traits" } });
        });
    }

    // --- Weekly: Learned-rule recompute (Sunday only) ---
    // Mine each user's repeated manual overrides into generalising rules
    // (learned-rule-store.ts). Rules are written OPEN (advisory) — the
    // classifier reads only APPLIED rules, so this never changes classification.
    if (isSunday && lastLearnedRuleDate !== todayUtc) {
      lastLearnedRuleDate = todayUtc;
      import("./learned-rule-store.js")
        .then(({ recomputeLearnedRulesForAllUsers }) => recomputeLearnedRulesForAllUsers())
        .catch((err) => {
          console.error("[AUTOMATION] Learned-rule recompute failed:", err);
          captureError(err, { tags: { scope: "automation.learned-rules" } });
        });
    }

    // --- Daily: OpenRouter catalog check ---
    // Proactively verify every model the fallback chain depends on still
    // exists upstream, so a retired/renamed :free SKU surfaces as a named
    // alert instead of mystery 404s in the agent logs.
    if (lastCatalogCheckDate !== todayUtc) {
      lastCatalogCheckDate = todayUtc;
      import("./openrouter-catalog-check.js")
        .then(({ runOpenRouterCatalogCheck }) => runOpenRouterCatalogCheck())
        .catch((err) => {
          console.warn("[AUTOMATION] Catalog check failed:", err);
          captureError(err, { tags: { scope: "automation.catalog-check" } });
        });
    }

    // --- Daily: calibration snapshot ---
    // Persists per-user classification-quality KPIs (override rate, judge
    // source mix incl. keyword-fallback demotion, drift) as one
    // CalibrationSnapshot row per UTC day, so /api/admin/calibration can
    // trend the product KPI instead of waiting for a manual CLI run.
    if (lastCalibrationSnapshotDate !== todayUtc) {
      lastCalibrationSnapshotDate = todayUtc;
      import("./calibration-snapshot.js")
        .then(({ runDailyCalibrationSnapshots }) => runDailyCalibrationSnapshots())
        .catch((err) => {
          console.warn("[AUTOMATION] Calibration snapshot failed:", err);
          captureError(err, { tags: { scope: "automation.calibration-snapshot" } });
        });
      // --- Daily: ontology write-side proposals ---
      // Turn the same override ledger into advisory threshold-change proposals
      // (the read/write ontology's write side). Best-effort: never throws, never
      // mutates the classifier — proposals are applied by a human via a code PR.
      import("./ontology-proposals-store.js")
        .then(({ recomputeOntologyProposalsSafe }) => recomputeOntologyProposalsSafe())
        .catch((err) => {
          console.warn("[AUTOMATION] Ontology proposal recompute failed:", err);
          captureError(err, { tags: { scope: "automation.ontology-proposals" } });
        });

      // --- Daily: judge-health heartbeat ---
      // computeHealth() alone can't tell "no drift" from "the tripwire's feed
      // died" — both leave its rolling window frozen and reading as healthy.
      // This is the canary of the canary (#742): alarms if NO judge decision
      // has been recorded fleet-wide (per dyno) within the max-silence window.
      import("./judge-health.js")
        .then(({ runJudgeHeartbeatCheck }) => runJudgeHeartbeatCheck())
        .catch((err) => {
          console.warn("[AUTOMATION] Judge heartbeat check failed:", err);
          captureError(err, { tags: { scope: "automation.judge-heartbeat" } });
        });
    }

    // --- Every tick: Resurrect snoozed AttentionItems whose snooze has expired ---
    await resurrectSnoozedItems().catch((err) => {
      console.warn("[AUTOMATION] Snooze resurrection failed:", err);
      captureError(err, { tags: { scope: "automation.snooze-resurrection" } });
    });
  } catch (err) {
    console.error("[AUTOMATION] Scheduler error:", err);
    captureError(err, { tags: { scope: "automation.scheduler" } });
  } finally {
    await releaseSchedulerLock();
    schedulerInFlight = false;
  }
}

// The plan/role value cached per user for feature gating. Element type of the
// `prisma.user.findMany({ select: { plan, role } })` result so `role` stays the
// Prisma `UserRole` enum (planHasFeature's ADMIN bypass) rather than a widened
// `string | null` — matching the inline map this cycle was extracted from.
type PlanRole = Pick<Awaited<ReturnType<typeof prisma.user.findMany>>[number], "plan" | "role">;

/**
 * Per-batch locals a user cycle closes over. Bundled so `runUserCycle` can be
 * extracted from the loop without changing behavior: `automationPlanMap` gates
 * features by plan/role, `googleConnectedUserIds` pre-filters users who never
 * OAuth-connected Google.
 */
interface UserCycleContext {
  automationPlanMap: Map<string, PlanRole>;
  googleConnectedUserIds: Set<string>;
}

/**
 * Runs ONE user's per-tick automation work (briefing, calendar sync, email
 * sync + classify + auto-reply, reconcile, urgent notify, proactive, phone
 * escalation) — the exact body that previously lived inline in the
 * `for (const config of configs)` loop, extracted verbatim so it can be bounded
 * by {@link withTimeout}. Each sub-step keeps its own try/catch; a hang or an
 * unexpected escape is isolated by the caller's timeout wrapper.
 */
async function runUserCycle(
  config: Awaited<ReturnType<typeof prisma.automationConfig.findMany>>[number],
  ctx: UserCycleContext,
): Promise<void> {
  const { automationPlanMap, googleConnectedUserIds } = ctx;
  const configUserEntry = automationPlanMap.get(config.userId);
  const configUserPlan = configUserEntry?.plan || "FREE";
  const configUserRole = configUserEntry?.role;
  const timeZone = normalizeTimeZone((config as unknown as { timezone?: string }).timezone);
  const today = localDateKey(new Date(), timeZone);

  // --- Daily Briefing ---
  if (
    config.dailyBriefing &&
    briefingSentToday.get(config.userId) !== today &&
    planHasFeature(configUserPlan, "daily_briefing", configUserRole)
  ) {
    if (isBriefingDue(config.briefingTime, timeZone)) {
      // DB-based dedup: check if briefing was already sent today (survives restarts)
      const alreadySent = await hasBriefingBeenSentToday(config.userId, timeZone);
      // Skip ONLY the briefing send when already-sent or cost-capped,
      // then fall through to the rest of this user's tick (calendar +
      // email sync). These branches used to `continue`, skipping the whole
      // tick for the user — one stale cycle after a restart cleared the
      // in-memory map.
      if (alreadySent) {
        briefingSentToday.set(config.userId, today);
      } else {
        try {
          console.log(`[AUTOMATION] Generating daily briefing for ${config.userId}`);
          await createDailyBriefingDelivery(config.userId);
          briefingSentToday.set(config.userId, today);
          console.log(`[AUTOMATION] Briefing delivered to ${config.userId}`);
        } catch (err) {
          const errName = err instanceof Error ? err.name : "";
          // Daily cost-cap hits are expected back-pressure, not bugs.
          if (errName === "DailyCostCapExceededError") {
            console.log(`[AUTOMATION] Briefing skipped for ${config.userId} — daily cost cap`);
            briefingSentToday.set(config.userId, today);
          } else {
            console.error(`[AUTOMATION] Briefing failed for ${config.userId}:`, err);
            captureError(err, {
              tags: { scope: "automation.briefing", userId: config.userId },
              extra: { briefingTime: config.briefingTime, timeZone },
            });
          }
        }
      }
    }
  }

  // --- Calendar Auto-Sync (every 15 minutes) ---
  if (isCalendarSyncDue(config.userId) && googleConnectedUserIds.has(config.userId)) {
    lastCalendarSyncAt.set(config.userId, Date.now());
    try {
      const auth = await getAuthedClient(config.userId);
      if (auth) {
        const { google } = await import("googleapis");
        const calendar = google.calendar({ version: "v3", auth });
        const now = new Date();
        const later = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        const userRow = (await prisma.user.findUnique({
          where: { id: config.userId },
        })) as { timezone?: string | null } | null;
        const userTimezone = normalizeTimeZone(userRow?.timezone);

        const response = await calendar.events.list({
          calendarId: "primary",
          timeMin: now.toISOString(),
          timeMax: later.toISOString(),
          singleEvents: true,
          orderBy: "startTime",
          maxResults: 100,
          // See note in routes/calendar.ts /sync — pass timeZone so
          // Google canonicalizes the response, and the defensive
          // parseGoogleDateTime below handles any stray naive strings.
          timeZone: userTimezone,
        });

        for (const item of response.data.items || []) {
          const googleId = item.id || "";
          if (!googleId) continue;
          const startTime = item.start?.dateTime || item.start?.date || "";
          const endTime = item.end?.dateTime || item.end?.date || "";
          if (!startTime || !endTime) continue;

          let meetingLink: string | null = null;
          if (item.conferenceData?.entryPoints) {
            const video = item.conferenceData.entryPoints.find((e) => e.entryPointType === "video");
            if (video) meetingLink = video.uri || null;
          }
          if (!meetingLink && item.hangoutLink) meetingLink = item.hangoutLink;

          const isTimed = Boolean(item.start?.dateTime);
          const parsedStart = isTimed
            ? parseGoogleDateTime(startTime, item.start?.timeZone ?? null, userTimezone)
            : new Date(startTime);
          const parsedEnd = isTimed
            ? parseGoogleDateTime(endTime, item.end?.timeZone ?? null, userTimezone)
            : new Date(endTime);
          await prisma.calendarEvent.upsert({
            where: { userId_googleId: { userId: config.userId, googleId } },
            create: {
              userId: config.userId,
              title: item.summary || "Untitled",
              description: item.description || null,
              startTime: parsedStart,
              endTime: parsedEnd,
              location: item.location || null,
              meetingLink,
              allDay: !isTimed,
              googleId,
            },
            update: {
              title: item.summary || "Untitled",
              description: item.description || null,
              startTime: parsedStart,
              endTime: parsedEnd,
              location: item.location || null,
              meetingLink,
              allDay: !isTimed,
            },
          });
        }
      }
    } catch (err) {
      const gaxiosErr = err as {
        response?: { status?: number; data?: { error?: { message?: string } } };
        message?: string;
      };
      const status = gaxiosErr.response?.status;
      console.error(
        `[AUTOMATION] Calendar sync failed for ${config.userId} (HTTP ${status}):`,
        gaxiosErr.response?.data?.error?.message || gaxiosErr.message || err,
      );

      // 401/403 = token invalid — notify user to reconnect. Atomic + winner-only
      // (dedupeKey = "calendar-disconnect:<dayKey>") so concurrent ticks can't
      // double-alert; at most once per user per local day.
      if (status === 401 || status === 403) {
        await ensureCalendarDisconnectNotification(config.userId, today);
      }
    }
  }

  // --- Email Sync + AI Classify (requires PRO+ for classify, TEAM+ for auto-reply) ---
  // emailAutoClassify now defaults to true in schema — we still honor an
  // explicit opt-out, but for the vast majority of users sync runs on
  // its own interval without any config step.
  if (
    config.emailAutoClassify &&
    planHasFeature(configUserPlan, "email_auto_classify", configUserRole) &&
    googleConnectedUserIds.has(config.userId)
  ) {
    if (isEmailSyncDue(config.userId)) {
      lastEmailSyncAt.set(config.userId, Date.now());
      try {
        // Sync from Gmail → DB
        const syncResult = await syncEmails(config.userId, 20);

        // AI summarize new emails — floor 10 so a zero-new tick still drains
        // the backlog (same #725 floor the interactive routes already have;
        // this background path was the one left gated on newCount > 0).
        await summarizeUnsummarizedEmails(config.userId, Math.max(syncResult.newCount, 10));
        await syncRecentCandidateIntakes(config.userId, Math.max(syncResult.newCount, 10));
        await notifyCandidateEmails(config.userId);

        // Multi-account (Pro): also sync each LINKED secondary inbox via
        // its own OAuth client so the firewall classifies its mail too.
        // Flag-gated (default off) so this path stays dark in production
        // until verified against real accounts — it can never touch the
        // primary sync above. Per-account isolation: one bad linked inbox
        // (revoked token, quota) is logged and skipped, never aborting the
        // others or the tick. The per-user daily cost cap covers all
        // inboxes, so on a cap hit we stop the rest of the fan-out.
        if (
          MULTI_INBOX_SYNC_ENABLED &&
          planHasFeature(configUserPlan, "multi_account", configUserRole)
        ) {
          // The lookup itself is wrapped so a DB blip degrades to "skip the
          // fan-out this tick" — never escaping to the outer catch and
          // silently skipping the primary account's backfill/auto-reply/
          // reconcile below.
          let linkedInboxes: Awaited<ReturnType<typeof getLinkedInboxClients>> = [];
          try {
            linkedInboxes = await getLinkedInboxClients(config.userId);
          } catch (err) {
            console.warn(
              `[AUTOMATION] Linked-inbox lookup failed for ${config.userId} — skipping fan-out this tick:`,
              err,
            );
            captureError(err, {
              tags: { scope: "automation.linked-inbox-lookup", userId: config.userId },
            });
          }
          for (const inbox of linkedInboxes) {
            try {
              const linkedResult = await syncEmails(config.userId, 20, undefined, {
                id: inbox.id,
                email: inbox.email,
                client: inbox.client,
              });
              if (linkedResult.newCount > 0) {
                await summarizeUnsummarizedEmails(config.userId, linkedResult.newCount);
              }
              // Stamp the last successful sync so the UI's "Synced Xm ago" is real
              // (the column had a reader but no writer — it showed "Not yet synced"
              // forever even while syncing). Runs on every successful tick, incl.
              // 0-new, so it reflects the last CHECK, not just the last new mail.
              await prisma.linkedInboxAccount.updateMany({
                where: { id: inbox.id, userId: config.userId },
                data: { lastSyncedAt: new Date() },
              });
            } catch (err) {
              const errName = err instanceof Error ? err.name : "";
              if (errName === "DailyCostCapExceededError") {
                console.log(
                  `[AUTOMATION] Linked-inbox sync stopped for ${config.userId} — daily cost cap`,
                );
                break;
              }
              if (err instanceof Error && err.message === "Gmail not connected") {
                console.warn(
                  `[AUTOMATION] Linked inbox ${inbox.email} not connected (revoked?) for ${config.userId}`,
                );
                continue;
              }
              console.warn(
                `[AUTOMATION] Linked-inbox sync failed for ${config.userId} / ${inbox.email}:`,
                err,
              );
              captureError(err, {
                tags: { scope: "automation.linked-inbox-sync", userId: config.userId },
                extra: { linkedInboxAccountId: inbox.id },
              });
            }
          }
        }

        // Backfill: re-judge recently-synced emails that never got an
        // AttentionItem (the inline judge is fire-and-forget; a transient
        // failure or a dyno killed mid-flight strands the email out of
        // the firewall). Runs every sync cycle regardless of newCount so
        // mail that arrived while the instance slept gets tiered on wake.
        // Bounded per call; no-op once caught up.
        const backfilled = await backfillEmailAttentionItems(config.userId);
        if (backfilled > 0) {
          console.log(
            `[EMAIL-BACKFILL] re-judged ${backfilled} stranded email(s) for ${config.userId}`,
          );
        }

        // LOW-priority mail is a quarantine signal, not a destructive
        // action. Keep the local/Gmail records intact so the user can audit
        // EVE's classification and approve any cleanup later.

        // Auto-reply: check rules for newly synced emails (dedup by gmailId)
        // Requires TEAM+ plan for auto-reply
        if (
          syncResult.newCount > 0 &&
          planHasFeature(configUserPlan, "email_auto_reply", configUserRole)
        ) {
          // PRIMARY-account rows only. sendAutoReplyViaFloor below always
          // sends from the primary Gmail client, so auto-replying to a
          // linked-inbox email would come from the WRONG address (the
          // sender emailed the linked account, not the primary). Until
          // per-account send routing exists, auto-reply is primary-only;
          // this also keeps `take: newCount` from mixing in linked rows
          // once MULTI_INBOX_SYNC_ENABLED is on.
          const newEmails = await prisma.emailMessage.findMany({
            where: { userId: config.userId, linkedInboxAccountId: null },
            orderBy: { syncedAt: "desc" },
            take: syncResult.newCount,
          });
          for (const email of newEmails) {
            try {
              // Skip if we already sent an auto-reply notification for this email
              const alreadyReplied = await prisma.notification.findFirst({
                where: {
                  userId: config.userId,
                  type: "email",
                  title: "Auto-reply sent",
                  message: { contains: email.gmailId },
                },
              });
              if (alreadyReplied) continue;

              const matched = await checkAutoReplyRules(config.userId, email);
              if (
                matched &&
                (matched.actionType === "AUTO_REPLY" || matched.actionType === "DRAFT_REPLY")
              ) {
                const replyBody = await generateSmartReply(
                  matched.actionValue,
                  {
                    from: email.from,
                    subject: email.subject,
                    body: email.body || "",
                  },
                  config.userId,
                );
                if (matched.actionType === "AUTO_REPLY") {
                  const emailMatch = email.from.match(/<([^>]+)>/) || [null, email.from];
                  const toAddr = emailMatch[1] || email.from;
                  // Route the autonomous send through the deterministic
                  // floor (mint receipt → executeToolCall re-verifies the
                  // payloadHash) instead of calling gmail.sendEmail
                  // directly, so every send stays on the single gated,
                  // audited path (W1).
                  await sendAutoReplyViaFloor(
                    config.userId,
                    toAddr,
                    `Re: ${email.subject}`,
                    replyBody,
                  );
                  // Atomic + winner-only alert (dedupeKey = "auto-reply:<gmailId>"):
                  // the findFirst pre-filter above is a cheap best-effort skip, but
                  // the create is the real gate — a concurrent tick loses on P2002
                  // and neither re-creates the alert nor re-pushes.
                  await ensureAutoReplyNotification(
                    config.userId,
                    email.gmailId,
                    toAddr,
                    matched.ruleName,
                  );
                }
              }
            } catch (err) {
              // Auto-reply touches an outbound send — a silent failure
              // here means a configured rule fired nothing with no trace,
              // and the next tick silently retries. console first:
              // captureError is a no-op without a Sentry DSN.
              console.warn(
                `[AUTOMATION] auto-reply failed for ${email.gmailId} (user ${config.userId})`,
                err,
              );
              captureError(err, {
                tags: { scope: "automation.auto-reply" },
                extra: { userId: config.userId, gmailId: email.gmailId },
              });
            }
          }
        }

        // Reconcile DB with Gmail (remove deleted/archived emails).
        // Runs at most once every 30 minutes per user, independent of
        // wall-clock minute so a slipped tick doesn't skip the window.
        if (isReconcileDue(config.userId)) {
          lastReconcileAt.set(config.userId, Date.now());
          try {
            await reconcileEmails(config.userId);
          } catch (err) {
            console.error(`[AUTOMATION] Reconcile failed for ${config.userId}:`, err);
            captureError(err, {
              tags: { scope: "automation.reconcile", userId: config.userId },
            });
          }
          // Reconcile linked secondary inboxes too (each against its own
          // client). Gated + isolated from the primary reconcile so a
          // linked failure never masks a primary success. Off unless the
          // flag is on, matching the sync fan-out above.
          if (MULTI_INBOX_SYNC_ENABLED) {
            try {
              await reconcileLinkedInboxes(config.userId);
            } catch (err) {
              console.error(
                `[AUTOMATION] Linked-inbox reconcile failed for ${config.userId}:`,
                err,
              );
              captureError(err, {
                tags: { scope: "automation.reconcile.linked", userId: config.userId },
              });
            }
          }
        }

        // Check for urgent unread emails — notify only for NEW urgent emails
        // Only check truly new emails (synced in last hour) to avoid re-notifying old unread emails
        const urgentEmails = await prisma.emailMessage.findMany({
          where: {
            userId: config.userId,
            priority: "URGENT",
            isRead: false,
            syncedAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
          },
          orderBy: { receivedAt: "desc" },
          select: { id: true, gmailId: true, subject: true, from: true, summary: true },
        });

        if (urgentEmails.length > 0) {
          // Check which urgent emails we already notified about (by gmailId in message, last 7 days)
          const recentUrgentNotifs = await prisma.notification.findMany({
            where: {
              userId: config.userId,
              type: "email",
              OR: [{ title: "Urgent email" }, { title: "긴급 이메일" }],
              createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
            },
            select: { message: true },
          });
          const notifiedGmailIds = parseNotifiedGmailIds(recentUrgentNotifs.map((n) => n.message));

          // Only notify for urgent emails we haven't notified about yet
          const newUrgent = urgentEmails.filter((e) => !notifiedGmailIds.has(e.gmailId));

          if (newUrgent.length > 0) {
            // User-visible body: who + what, no internal IDs.
            // DB message keeps a trailing [id1,id2,…] marker for EVERY
            // notified email so the dedup read above records all of them
            // (not just the first) and they aren't re-notified next tick.
            const userBody = formatUrgentEmailBody(newUrgent);
            const dbMessage = buildUrgentDedupMessage(
              userBody,
              newUrgent.map((e) => e.gmailId),
            );

            // Atomic + winner-only (dedupeKey = "urgent:<leadGmailId>"): the
            // read-based notifiedGmailIds filter above is the primary per-message
            // dedup; this closes the residual concurrent-tick race on one batch so
            // the bell + web-push + SMS fire at most once. A P2002 loser returns
            // null and we skip ALL follow-on side-effects below.
            const notification = await ensureUrgentEmailNotification(
              config.userId,
              newUrgent[0].gmailId,
              dbMessage,
              userBody,
            );

            // WINNER-ONLY: a concurrent tick lost the create (null) and must NOT
            // re-fire the web-push / SMS side-effects for the same batch.
            if (notification) {
              // Best-effort AttentionItem lookup for the lead urgent email
              // (source=EMAIL, sourceId=EmailMessage.id, set by poc-judge).
              // Lets the Telegram channel attach tier-override buttons;
              // null just means the message ships without them.
              const attentionItemId = await findOpenEmailAttentionItemId(
                config.userId,
                newUrgent[0].id,
              );

              sendPushNotification(
                config.userId,
                {
                  title: "Urgent mail",
                  body: userBody,
                  url: "/briefing",
                  attentionItemId: attentionItemId ?? undefined,
                },
                "email_urgent",
                // Unawaited (don't block the tick) but guarded: an
                // unhandled rejection from the push internals would
                // otherwise crash the single dyno. Matches the candidate
                // push path above.
              ).catch((err) => {
                console.warn(`[AUTOMATION] Urgent email push failed for ${config.userId}:`, err);
                captureError(err, {
                  tags: { scope: "automation.urgent-push", userId: config.userId },
                });
              });

              // Admin-only SMS escalation. Gated inside sendSms (admin +
              // phone + daily cap). Best-effort: never throws, never
              // blocks the scheduler. Body covers the first urgent email;
              // if many landed at once the user still gets the bell + push
              // for the rest via the existing notification record.
              const lead = newUrgent[0];
              const smsBody = `Urgent: ${lead.subject || "(no subject)"} — from ${senderName(lead.from)}`;
              sendSms(config.userId, smsBody).catch((err) => {
                console.warn(`[AUTOMATION] Urgent email SMS failed for ${config.userId}:`, err);
                captureError(err, {
                  tags: { scope: "automation.urgent-sms", userId: config.userId },
                });
              });
            }
          }
        }
      } catch (err) {
        const errName = err instanceof Error ? err.name : "";
        // "Gmail not connected" is an expected state: the pre-filter
        // catches it before we even try, but a token can be revoked
        // mid-tick (race). Warn without Sentry to avoid noise.
        if (err instanceof Error && err.message === "Gmail not connected") {
          console.warn(`[AUTOMATION] Email sync skipped for ${config.userId}: Gmail not connected`);
        } else if (errName === "DailyCostCapExceededError") {
          // Expected back-pressure, not an outage — don't Sentry-spam it
          // (mirrors the briefing handler above). For a FREE user this is
          // their daily limit; nudge them toward Pro at most once a day.
          console.log(`[AUTOMATION] Classify skipped for ${config.userId} — daily cost cap`);
          // .catch() isolates the blast radius to this one user: the helper
          // already self-catches, but if its own catch ever threw the await
          // would abort the rest of this tick's users. Belt and suspenders.
          await maybeNudgeFreeDailyLimit(config.userId, configUserPlan, configUserRole).catch(
            (nudgeErr) => {
              console.warn(
                `[AUTOMATION] free-limit nudge threw unexpectedly for ${config.userId}:`,
                nudgeErr,
              );
            },
          );
        } else {
          // Token expired, rate-limited, or network flake — log +
          // capture so "Eve stopped reading email" doesn't become an
          // invisible outage. Returns early so the next tick still tries.
          console.error(`[AUTOMATION] Email sync failed for ${config.userId}:`, err);
          captureError(err, {
            tags: { scope: "automation.email-sync", userId: config.userId },
          });
        }
      }
    }
  }

  // --- Proactive Actions (rule-based, no LLM cost) ---
  // Enabled either via global env flag (PROACTIVE_ACTIONS_ENABLED=true for all users)
  // or the per-user AutomationConfig.proactiveActions toggle.
  const perUserProactive = config.proactiveActions === true;
  if (PROACTIVE_ACTIONS_ENABLED || perUserProactive) {
    runProactiveActions(config.userId).catch((err) => {
      console.error(`[PROACTIVE] Failed for ${config.userId}:`, err);
      captureError(err, {
        tags: { scope: "automation.proactive", userId: config.userId },
      });
    });
  }

  // --- Phone escalation v0 (opt-in delivery channel for PUSH, not a tier) ---
  // Doubly gated: global PHONE_ESCALATION_ENABLED flag AND the per-user
  // AutomationConfig.phoneEscalationEnabled opt-in. All hard rails
  // (1-call-per-notification, daily cap, cooldown, quiet hours) live
  // inside escalateUnackedPush/placeEscalationCall. Best-effort: never
  // blocks or crashes the tick.
  const phoneOptIn = (config as unknown as Record<string, unknown>).phoneEscalationEnabled === true;
  if (PHONE_ESCALATION_ENABLED && phoneOptIn) {
    escalateUnackedPush(config.userId).catch((err) => {
      console.warn(`[PHONE] Escalation sweep failed for ${config.userId}:`, err);
      captureError(err, {
        tags: { scope: "automation.phone-escalation", userId: config.userId },
      });
    });
  }
}

/**
 * Finds AttentionItems that were snoozed and whose snoozeUntil has passed,
 * then sets them back to OPEN so they resurface in the inbox.
 */
async function resurrectSnoozedItems(): Promise<void> {
  const now = new Date();
  await (
    prisma.attentionItem as unknown as {
      updateMany: (args: unknown) => Promise<{ count: number }>;
    }
  ).updateMany({
    where: {
      status: "SNOOZED",
      snoozedUntil: { lte: now },
    } as unknown,
    data: { status: "OPEN", snoozedUntil: null },
  });
}

/** Start the automation scheduler */
export function startAutomationScheduler() {
  if (intervalId) return;

  console.log(
    `[AUTOMATION] Scheduler started (checking every 60s, dbHeartbeat=${DB_HEARTBEAT_ENABLED ? "on" : "off"}, proactive=${PROACTIVE_ACTIONS_ENABLED ? "on" : "off"})`,
  );
  registerScheduler("automation", CHECK_INTERVAL_MS);

  // Run once on start
  runAutomations();

  // Then check every minute
  intervalId = setInterval(runAutomations, CHECK_INTERVAL_MS);
}

/** Stop the automation scheduler */
export function stopAutomationScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("[AUTOMATION] Scheduler stopped");
  }
}
