/**
 * Delivering the day's briefing: one note and one notification per user per
 * local day (atomic dedupe), the push, and the one-shot self-heal of a day's
 * rule-based fallback note. Split from briefing.ts, which re-exports the
 * public surface.
 */

import { pushPresentationOpenTo } from "../config.js";
import { prisma } from "../db.js";
import { getUserNotificationLanguage } from "../notify/notification-strings.js";
import { sendPushNotification } from "../notify/push.js";
import { logDbFailure } from "../report-db-failure.js";
import { localDayUtcRange, normalizeTimeZone } from "../time-zone.js";
import { stripUntrusted } from "../untrusted.js";
import { pushNotification } from "../websocket.js";
import { briefingCopy, isQuietBriefing } from "./briefing-copy.js";
import generateBriefing, {
  type BriefingLlmOutcome,
  FALLBACK_BRIEFING_SENTINEL,
} from "./briefing-generate.js";
import type { BriefingPick } from "./briefing-picks.js";
import { briefingPushCopy } from "./briefing-push.js";

/// One heal attempt per user per window — a fallback note otherwise retries
/// the LLM on EVERY sidebar read. In-process is fine on a single instance;
/// worst case after a restart is one extra attempt.
const HEAL_COOLDOWN_MS = 10 * 60 * 1000;
const healAttemptAt = new Map<string, number>();

/** Test seam: cooldown state is module-held. */
export function __resetBriefingHealCooldownForTests(): void {
  healAttemptAt.clear();
}

/** Picks as a JSON column value (Note.picks); undefined leaves the column unset. */
export function picksColumn(picks: readonly BriefingPick[]) {
  if (picks.length === 0) return undefined;
  return picks.map((p) => ({
    rank: p.rank,
    emailId: p.emailId,
    action: p.action,
    reason: p.reason,
    quote: p.quote,
    openedAt: p.openedAt ?? null,
  }));
}

/**
 * If the cached note is the rule-based fallback, try ONE fresh generation.
 * Returns the healed content (note rewritten in place) or null when the note
 * is healthy, the cooldown is active, or the LLM is still failing.
 */
async function healFallbackBriefing(
  userId: string,
  note: { id: string; content: string },
): Promise<{ content: string; llm: BriefingLlmOutcome } | null> {
  if (!note.content.startsWith(FALLBACK_BRIEFING_SENTINEL)) return null;
  const last = healAttemptAt.get(userId) ?? 0;
  if (Date.now() - last < HEAL_COOLDOWN_MS) return null;
  healAttemptAt.set(userId, Date.now());
  try {
    const { content, llm, picks } = await generateBriefing(userId);
    // generateBriefing already degraded internally — still no AI. Keep the
    // cached fallback rather than rewriting it with an identical one.
    if (llm.source !== "ai") return null;
    await prisma.note.update({
      where: { id: note.id },
      data: { content, picks: picksColumn(picks) },
    });
    return { content, llm };
  } catch (err) {
    logDbFailure("[BRIEFING] fallback self-heal failed", err, { ids: { userId } });
    return null;
  }
}

/**
 * Deliver today's briefing at most once per user per local day.
 *
 * The dedup is ATOMIC: a `(userId, dayKey)` unique on Note plus a
 * create-catch-P2002 recovery closes the check-then-create (TOCTOU) race. Four
 * callers can fire concurrently — the scheduler, the agent tool-executor, cron,
 * and post-login auth — but only the create winner generates + pushes; every
 * other caller reuses the winner's note and gets `notification: null` (no push).
 */
export async function createDailyBriefingDelivery(userId: string): Promise<{
  briefing: string;
  note: { id: string; createdAt: Date };
  notification: { id: string; createdAt: Date } | null;
  reused: boolean;
  /** LLM outcome for THIS caller's generation; "cache" when a note was reused. */
  llm: BriefingLlmOutcome;
}> {
  const dayKey = await briefingDayKeyForUser(userId);
  const cacheLlm: BriefingLlmOutcome = {
    source: "cache",
    reason: "reused today's existing note",
    model: "",
  };

  const existing = await prisma.note.findUnique({
    where: { userId_dayKey: { userId, dayKey } },
    select: { id: true, content: true, createdAt: true },
  });
  if (existing) {
    // Self-heal: a transient LLM failure at generation time persisted the
    // rule-based fallback as the DAY'S note, so every later read served
    // "AI summary unavailable" all day even after the provider recovered
    // (founder screenshots 2026-08-19/20). One retry per cooldown window;
    // failure keeps the fallback — the page never goes blank.
    const healed = await healFallbackBriefing(userId, existing);
    const content = healed?.content ?? existing.content;
    const notification = await ensureDailyBriefingNotification(userId, content, dayKey, {
      quiet: isQuietBriefing(content),
    });
    return {
      briefing: content,
      note: { id: existing.id, createdAt: existing.createdAt },
      notification,
      reused: true,
      llm: healed?.llm ?? cacheLlm,
    };
  }

  const { content: briefing, llm, picks, quiet } = await generateBriefing(userId);

  let note: { id: string; createdAt: Date };
  try {
    note = await prisma.note.create({
      data: {
        userId,
        dayKey,
        title: `Daily Briefing — ${new Date().toLocaleDateString("en-US")}`,
        content: briefing,
        picks: picksColumn(picks),
      },
      select: { id: true, createdAt: true },
    });
  } catch (err) {
    // A concurrent caller won the (userId, dayKey) race between our findUnique
    // miss and this create. Recover by reading the winner's note and reusing it
    // — matches the WebhookEvent P2002-dedup idiom (routes/webhook.ts).
    if ((err as { code?: string })?.code !== "P2002") throw err;
    const winner = await prisma.note.findUnique({
      where: { userId_dayKey: { userId, dayKey } },
      select: { id: true, content: true, createdAt: true },
    });
    if (!winner) throw err; // P2002 but no row — genuinely unexpected, surface it
    const notification = await ensureDailyBriefingNotification(userId, winner.content, dayKey, {
      quiet: isQuietBriefing(winner.content),
    });
    return {
      briefing: winner.content,
      note: { id: winner.id, createdAt: winner.createdAt },
      notification,
      reused: true,
      llm: cacheLlm,
    };
  }

  const notification = await ensureDailyBriefingNotification(userId, briefing, dayKey, { quiet });

  return { briefing, note, notification, reused: false, llm };
}

/**
 * Create the briefing notification and push it — WINNER-ONLY and atomic.
 *
 * A `(userId, dedupeKey)` unique on Notification (dedupeKey = "briefing:<dayKey>")
 * means exactly one caller's create succeeds. The winner does both pushes and
 * returns the notification; a concurrent loser gets P2002 → returns null WITHOUT
 * pushing, so the user can never receive a duplicate briefing web-push. Matches
 * the WebhookEvent P2002-dedup idiom (routes/webhook.ts).
 *
 * A quiet card (nothing new, nothing scheduled or due) still gets its bell
 * row — it is the day's dedupe record, so no later caller pushes the day —
 * but already read, and without a live or device push: an interruption that
 * says "nothing" teaches the user to ignore the next one. The title follows
 * the user's notification language.
 */
export async function ensureDailyBriefingNotification(
  userId: string,
  briefing: string,
  dayKey: string,
  options: { quiet?: boolean } = {},
): Promise<{ id: string; createdAt: Date } | null> {
  // Strip first (a note saved before the strip existed may carry tags), then cut.
  const clean = stripUntrusted(briefing);
  const briefingMsg = clean.slice(0, 200) + (clean.length > 200 ? "..." : "");
  const dedupeKey = `briefing:${dayKey}`;
  const title = briefingCopy(await getUserNotificationLanguage(userId)).pushTitle;
  const quiet = options.quiet === true;

  let notification: { id: string; createdAt: Date };
  try {
    notification = await prisma.notification.create({
      data: {
        userId,
        type: "briefing",
        dedupeKey,
        title,
        message: briefingMsg,
        link: "/briefing",
        ...(quiet ? { isRead: true } : {}),
      },
      select: { id: true, createdAt: true },
    });
  } catch (err) {
    // Someone already created + pushed this briefing for the day. Do NOT push
    // again — this is exactly the duplicate-push hole being closed.
    if ((err as { code?: string })?.code === "P2002") return null;
    throw err;
  }
  if (quiet) return notification;

  pushNotification(userId, {
    id: notification.id,
    type: "briefing",
    title,
    message: briefingMsg,
    createdAt: notification.createdAt.toISOString(),
  });

  // NOTIFY_PUSH_PRESENTATION: the NT0 brief copy (counts only) on the device
  // push; the bell row and the live frame keep the briefing itself.
  const nt = pushPresentationOpenTo(userId) ? await briefingPushCopy(userId) : null;
  await sendPushNotification(
    userId,
    {
      title: nt?.title ?? title,
      body: nt?.body ?? briefingMsg,
      url: "/briefing",
      notificationId: notification.id,
    },
    "daily_briefing",
  );

  return notification;
}

/**
 * The user's LOCAL calendar day as YYYY-MM-DD, using the SAME timezone
 * resolution as todayRangeForUser in briefing-routes.ts (localDayUtcRange
 * returns this exact key as `dateKey`). Sharing the resolution keeps dayKey
 * aligned with the "today" window and stable across a local day — the dedup
 * key for the daily briefing.
 */
export async function briefingDayKeyForUser(userId: string): Promise<string> {
  const config = await prisma.automationConfig.findUnique({
    where: { userId },
    select: { timezone: true },
  });
  return localDayUtcRange(new Date(), normalizeTimeZone(config?.timezone)).dateKey;
}
