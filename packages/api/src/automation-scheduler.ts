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

import { createDailyBriefingDelivery } from "./briefing.js";
import { prisma } from "./db.js";
import { withDbRetry } from "./db-retry.js";
import {
  checkAutoReplyRules,
  generateSmartReply,
  reconcileEmails,
  summarizeUnsummarizedEmails,
  syncEmails,
} from "./email-sync.js";
import { getAuthedClient, renewExpiringGmailWatches, sendEmail } from "./gmail.js";
import { formatUrgentEmailBody } from "./notification-format.js";
import { runProactiveActions } from "./proactive-actions.js";
import { sendPushNotification } from "./push.js";
import { captureError } from "./sentry.js";
import { planHasFeature } from "./stripe.js";
import {
  localDateKey,
  localDayUtcRange,
  localMinuteOfDay,
  normalizeTimeZone,
} from "./time-zone.js";
import { pushNotification } from "./websocket.js";

let intervalId: ReturnType<typeof setInterval> | null = null;

const CHECK_INTERVAL_MS = 60_000; // 1 minute
const WATCH_RENEWAL_INTERVAL_MS = 60 * 60 * 1000; // hourly check for expiring Gmail watches
const DB_HEARTBEAT_ENABLED = process.env.DB_HEARTBEAT_ENABLED === "true";
const PROACTIVE_ACTIONS_ENABLED = process.env.PROACTIVE_ACTIONS_ENABLED === "true";

// In-memory cache to skip redundant DB queries within same process lifetime.
// Actual dedup is DB-based (survives server restarts).
const briefingSentToday = new Map<string, string>(); // userId -> date string
let lastWatchRenewalAt = 0;

/** DB-based check: did we already send a briefing notification today? */
async function hasBriefingBeenSentToday(userId: string, timeZone: string): Promise<boolean> {
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
const EMAIL_SYNC_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
function isEmailSyncDue(userId: string): boolean {
  const last = lastEmailSyncAt.get(userId);
  if (!last) return true;
  return Date.now() - last >= EMAIL_SYNC_INTERVAL_MS;
}

const lastReconcileAt = new Map<string, number>();
const RECONCILE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
function isReconcileDue(userId: string): boolean {
  const last = lastReconcileAt.get(userId);
  if (!last) return true;
  return Date.now() - last >= RECONCILE_INTERVAL_MS;
}

const lastCalendarSyncAt = new Map<string, number>();
const CALENDAR_SYNC_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
function isCalendarSyncDue(userId: string): boolean {
  const last = lastCalendarSyncAt.get(userId);
  if (!last) return true;
  return Date.now() - last >= CALENDAR_SYNC_INTERVAL_MS;
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

async function runAutomations() {
  await dbHeartbeat();
  try {
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
        });
    }

    const configs = await prisma.automationConfig.findMany();
    if (configs.length === 0) return;

    // Fetch user plans for feature gating
    const configUserIds = configs.map((c) => c.userId);
    const automationUsers = await prisma.user.findMany({
      where: { id: { in: configUserIds } },
      select: { id: true, plan: true },
    });
    const automationPlanMap = new Map(automationUsers.map((u) => [u.id, u.plan]));

    for (const config of configs) {
      const configUserPlan = automationPlanMap.get(config.userId) || "FREE";
      const timeZone = normalizeTimeZone((config as unknown as { timezone?: string }).timezone);
      const today = localDateKey(new Date(), timeZone);

      // --- Daily Briefing ---
      if (
        config.dailyBriefing &&
        briefingSentToday.get(config.userId) !== today &&
        planHasFeature(configUserPlan, "daily_briefing")
      ) {
        if (isBriefingDue(config.briefingTime, timeZone)) {
          // DB-based dedup: check if briefing was already sent today (survives restarts)
          const alreadySent = await hasBriefingBeenSentToday(config.userId, timeZone);
          if (alreadySent) {
            briefingSentToday.set(config.userId, today);
            continue;
          }
          try {
            console.log(`[AUTOMATION] Generating daily briefing for ${config.userId}`);
            await createDailyBriefingDelivery(config.userId);
            briefingSentToday.set(config.userId, today);
            console.log(`[AUTOMATION] Briefing delivered to ${config.userId}`);
          } catch (err) {
            console.error(`[AUTOMATION] Briefing failed for ${config.userId}:`, err);
            captureError(err, {
              tags: { scope: "automation.briefing", userId: config.userId },
              extra: { briefingTime: config.briefingTime, timeZone },
            });
          }
        }
      }

      // --- Calendar Auto-Sync (every 15 minutes) ---
      if (isCalendarSyncDue(config.userId)) {
        lastCalendarSyncAt.set(config.userId, Date.now());
        try {
          const auth = await getAuthedClient(config.userId);
          if (auth) {
            const { google } = await import("googleapis");
            const calendar = google.calendar({ version: "v3", auth });
            const now = new Date();
            const later = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

            const response = await calendar.events.list({
              calendarId: "primary",
              timeMin: now.toISOString(),
              timeMax: later.toISOString(),
              singleEvents: true,
              orderBy: "startTime",
              maxResults: 100,
            });

            for (const item of response.data.items || []) {
              const googleId = item.id || "";
              if (!googleId) continue;
              const startTime = item.start?.dateTime || item.start?.date || "";
              const endTime = item.end?.dateTime || item.end?.date || "";
              if (!startTime || !endTime) continue;

              let meetingLink: string | null = null;
              if (item.conferenceData?.entryPoints) {
                const video = item.conferenceData.entryPoints.find(
                  (e) => e.entryPointType === "video",
                );
                if (video) meetingLink = video.uri || null;
              }
              if (!meetingLink && item.hangoutLink) meetingLink = item.hangoutLink;

              await prisma.calendarEvent.upsert({
                where: { googleId },
                create: {
                  userId: config.userId,
                  title: item.summary || "Untitled",
                  description: item.description || null,
                  startTime: new Date(startTime),
                  endTime: new Date(endTime),
                  location: item.location || null,
                  meetingLink,
                  allDay: !item.start?.dateTime,
                  googleId,
                },
                update: {
                  title: item.summary || "Untitled",
                  description: item.description || null,
                  startTime: new Date(startTime),
                  endTime: new Date(endTime),
                  location: item.location || null,
                  meetingLink,
                  allDay: !item.start?.dateTime,
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

          // 401/403 = token invalid — notify user to reconnect
          if (status === 401 || status === 403) {
            const existingAlert = await prisma.notification.findFirst({
              where: {
                userId: config.userId,
                type: "calendar",
                title: { contains: "Google 연결 끊김" },
                createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
              },
            });
            if (!existingAlert) {
              await prisma.notification.create({
                data: {
                  userId: config.userId,
                  type: "calendar",
                  title: "Google 연결 끊김",
                  message:
                    "Google 캘린더 동기화가 중단되었습니다. 설정에서 Google 계정을 다시 연결해주세요.",
                  link: "/settings",
                },
              });
              pushNotification(config.userId, {
                id: crypto.randomUUID(),
                type: "calendar",
                title: "Google 연결 끊김",
                message: "설정에서 Google 계정을 다시 연결해주세요.",
                link: "/settings",
              });
            }
          }
        }
      }

      // --- Email Sync + AI Classify (requires PRO+ for classify, TEAM+ for auto-reply) ---
      // emailAutoClassify now defaults to true in schema — we still honor an
      // explicit opt-out, but for the vast majority of users sync runs on
      // its own interval without any config step.
      if (config.emailAutoClassify && planHasFeature(configUserPlan, "email_auto_classify")) {
        if (isEmailSyncDue(config.userId)) {
          lastEmailSyncAt.set(config.userId, Date.now());
          try {
            // Sync from Gmail → DB
            const syncResult = await syncEmails(config.userId, 20);

            // AI summarize new emails
            if (syncResult.newCount > 0) {
              await summarizeUnsummarizedEmails(config.userId, syncResult.newCount);
            }

            // LOW-priority mail is a quarantine signal, not a destructive
            // action. Keep the local/Gmail records intact so the user can audit
            // EVE's classification and approve any cleanup later.

            // Auto-reply: check rules for newly synced emails (dedup by gmailId)
            // Requires TEAM+ plan for auto-reply
            if (syncResult.newCount > 0 && planHasFeature(configUserPlan, "email_auto_reply")) {
              const newEmails = await prisma.emailMessage.findMany({
                where: { userId: config.userId },
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
                    const replyBody = await generateSmartReply(matched.actionValue, {
                      from: email.from,
                      subject: email.subject,
                      body: email.body || "",
                    });
                    if (matched.actionType === "AUTO_REPLY") {
                      const emailMatch = email.from.match(/<([^>]+)>/) || [null, email.from];
                      const toAddr = emailMatch[1] || email.from;
                      await sendEmail(config.userId, toAddr, `Re: ${email.subject}`, replyBody);
                      const notification = await prisma.notification.create({
                        data: {
                          userId: config.userId,
                          type: "email",
                          title: "Auto-reply sent",
                          message: `Auto-replied to ${toAddr} (rule: "${matched.ruleName}") [${email.gmailId}]`,
                        },
                      });
                      pushNotification(config.userId, {
                        id: notification.id,
                        type: "email",
                        title: "Auto-reply sent",
                        message: `Auto-replied to ${toAddr}`,
                        createdAt: notification.createdAt.toISOString(),
                      });
                    }
                  }
                } catch {
                  // Auto-reply failed — non-critical
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
                  title: "긴급 이메일",
                  createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
                },
                select: { message: true },
              });
              const notifiedGmailIds = new Set(
                recentUrgentNotifs
                  .map((n) => {
                    const match = n.message.match(/\[([^\]]+)\]$/);
                    return match ? match[1] : null;
                  })
                  .filter(Boolean),
              );

              // Only notify for urgent emails we haven't notified about yet
              const newUrgent = urgentEmails.filter((e) => !notifiedGmailIds.has(e.gmailId));

              if (newUrgent.length > 0) {
                // User-visible body: who + what, no internal IDs.
                // DB message keeps the [gmailId] suffix because the dedup
                // regex above (notifiedGmailIds) reads it back from message.
                const userBody = formatUrgentEmailBody(newUrgent);
                const dbMessage = `${userBody} [${newUrgent[0].gmailId}]`;

                const notification = await prisma.notification.create({
                  data: {
                    userId: config.userId,
                    type: "email",
                    title: "긴급 이메일",
                    message: dbMessage,
                  },
                });

                pushNotification(config.userId, {
                  id: notification.id,
                  type: "email",
                  title: "긴급 이메일",
                  message: userBody,
                  createdAt: notification.createdAt.toISOString(),
                });

                sendPushNotification(
                  config.userId,
                  {
                    title: "긴급 메일",
                    body: userBody,
                    url: "/briefing",
                  },
                  "email_urgent",
                );
              }
            }
          } catch (err) {
            // Gmail not connected, token expired, rate-limited, or network
            // flake — log + capture so "EVE stopped reading email" doesn't
            // become an invisible outage. Returns early so the next tick
            // still tries.
            console.error(`[AUTOMATION] Email sync failed for ${config.userId}:`, err);
            captureError(err, {
              tags: { scope: "automation.email-sync", userId: config.userId },
            });
          }
        }
      }

      // --- Proactive Actions (rule-based, no LLM cost) ---
      // Default OFF during dogfooding: these are useful but can create bell
      // noise until each rule has stronger precision and per-user controls.
      if (PROACTIVE_ACTIONS_ENABLED) {
        runProactiveActions(config.userId).catch((err) => {
          console.error(`[PROACTIVE] Failed for ${config.userId}:`, err);
        });
      }
    }
  } catch (err) {
    console.error("[AUTOMATION] Scheduler error:", err);
  }
}

/** Start the automation scheduler */
export function startAutomationScheduler() {
  if (intervalId) return;

  console.log(
    `[AUTOMATION] Scheduler started (checking every 60s, dbHeartbeat=${DB_HEARTBEAT_ENABLED ? "on" : "off"}, proactive=${PROACTIVE_ACTIONS_ENABLED ? "on" : "off"})`,
  );

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
