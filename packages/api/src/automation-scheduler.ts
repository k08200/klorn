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
import { syncRecentCandidateIntakes } from "./email-candidate-intake.js";
import {
  checkAutoReplyRules,
  generateSmartReply,
  reconcileEmails,
  summarizeUnsummarizedEmails,
  syncEmails,
} from "./email-sync.js";
import { getAuthedClient, renewExpiringGmailWatches, sendEmail } from "./gmail.js";
import { formatUrgentEmailBody, senderName } from "./notification-format.js";
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

  for (const email of candidateEmails) {
    const existing = await prisma.notification.findFirst({
      where: {
        userId,
        type: "email",
        OR: [{ title: "Candidate materials received" }, { title: "후보자 자료 도착" }],
        sourceEmailId: email.id,
      },
      select: { id: true },
    });
    if (existing) continue;

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

    const BATCH_SIZE = 100;
    let cursor: string | undefined;

    for (;;) {
      const configs = await prisma.automationConfig.findMany({
        where: {
          OR: [{ dailyBriefing: true }, { emailAutoClassify: true }, { autonomousAgent: true }],
        },
        take: BATCH_SIZE,
        skip: cursor ? 1 : 0,
        cursor: cursor ? { userId: cursor } : undefined,
        orderBy: { userId: "asc" },
      });
      if (configs.length === 0) break;

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
                  OR: [
                    { title: { contains: "Google disconnected" } },
                    { title: { contains: "Google 연결 끊김" } },
                  ],
                  createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
                },
              });
              if (!existingAlert) {
                await prisma.notification.create({
                  data: {
                    userId: config.userId,
                    type: "calendar",
                    title: "Google disconnected",
                    message: "Calendar sync stopped. Reconnect your Google account in settings.",
                    link: "/settings",
                  },
                });
                pushNotification(config.userId, {
                  id: crypto.randomUUID(),
                  type: "calendar",
                  title: "Google disconnected",
                  message: "Reconnect your Google account in settings.",
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
              await syncRecentCandidateIntakes(config.userId, Math.max(syncResult.newCount, 10));
              await notifyCandidateEmails(config.userId);

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
                    OR: [{ title: "Urgent email" }, { title: "긴급 이메일" }],
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
                      title: "Urgent email",
                      message: dbMessage,
                    },
                  });

                  pushNotification(config.userId, {
                    id: notification.id,
                    type: "email",
                    title: "Urgent email",
                    message: userBody,
                    createdAt: notification.createdAt.toISOString(),
                  });

                  sendPushNotification(
                    config.userId,
                    {
                      title: "Urgent mail",
                      body: userBody,
                      url: "/briefing",
                    },
                    "email_urgent",
                  );
                }
              }
            } catch (err) {
              // Gmail not connected, token expired, rate-limited, or network
              // flake — log + capture so "Eve stopped reading email" doesn't
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
        // Enabled either via global env flag (PROACTIVE_ACTIONS_ENABLED=true for all users)
        // or per-user toggle (proactiveActions: true in automationConfig JSON field).
        const perUserProactive =
          (config as unknown as Record<string, unknown>).proactiveActions === true;
        if (PROACTIVE_ACTIONS_ENABLED || perUserProactive) {
          runProactiveActions(config.userId).catch((err) => {
            console.error(`[PROACTIVE] Failed for ${config.userId}:`, err);
          });
        }
      }
      if (configs.length < BATCH_SIZE) break;
      cursor = configs[configs.length - 1].userId;
    }

    // --- Weekly: Voice Profile Extraction (Sunday only) ---
    // Runs once per week for all users with Google connected. Each user is
    // skipped automatically if their profile was updated within the last 7 days.
    if (new Date().getDay() === 0) {
      import("./voice-profile-extractor.js")
        .then(({ extractVoiceProfilesForAllUsers }) => extractVoiceProfilesForAllUsers())
        .catch((err) => console.error("[AUTOMATION] Voice profile extraction failed:", err));
    }

    // --- Every tick: Resurrect snoozed AttentionItems whose snooze has expired ---
    await resurrectSnoozedItems().catch((err) =>
      console.warn("[AUTOMATION] Snooze resurrection failed:", err),
    );
  } catch (err) {
    console.error("[AUTOMATION] Scheduler error:", err);
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
