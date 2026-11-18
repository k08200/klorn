/**
 * Quiet hours hold urgent mail for the server's push channels and ring it
 * ONCE after they end (2026-11-09). Before this, push.ts dropped a push its
 * gate held with quiet_hours (notification-prefs.ts): web push, Telegram, FCM
 * and APNs stayed silent and nothing rang later; only the bell row kept the
 * event. The Mac app (#1650) and the Windows shell (#1644, decision N6) already
 * hold such mail and show it after; this sweep does the same for the server's
 * channels, with the same rules:
 *   - held: PUSH-lane mail whose urgent-mail bell row was written inside the
 *     quiet window that just ended (MEETING mail and the meeting-soon alert are
 *     not caught up, as on both desktop apps: by morning they are stale). The
 *     row's time stands in for the gate's: a row written in the last instant
 *     before the window ends can ring live AND here (sub-second, accepted);
 *   - still deserving: bell row unread and the mail still an OPEN PUSH item
 *     (open-push-mail.ts, the rule the Windows catch-up uses), and the mail
 *     itself still unread, as the Mac skips mail already opened;
 *   - one held mail rings as itself (N1 shape, Reply / Later, opens the mail);
 *     two or more ring ONE summary, "N urgent emails during quiet hours",
 *     naming up to three senders then "+k", opening Today;
 *   - at most once per user per window: a hidden claim row with dedupeKey
 *     `quiet-summary:<local end date>` (create-catch-P2002), so a restart or
 *     overlapping ticks never ring twice. Nothing held → no row, no push. A
 *     push the rate limit refused gives the claim back, so a later tick inside
 *     the grace period retries; any other outcome keeps it (at most once);
 *   - ambient bucket, never interrupt (push-bucket.ts): none of it is new, and
 *     it must not use up the room live interrupts need. sendPushNotification
 *     still applies the category opt-out, so "Urgent email" off means no ring.
 *   - Slack PUSH held during quiet hours counts too, while Slack is open to the
 *     user (SLACK_ENABLED, its cohort): the Slack row a will-not-ring push
 *     wrote inside the window ("slack:<episodeId>", slack/notify.ts), unread,
 *     whose episode the user did not answer in Slack since (held-slack-rows.ts,
 *     the Windows catch-up's rule). One held Slack row alone rings as its live
 *     push (opening Today); a summary holding one is worded "N urgent messages
 *     during quiet hours", as the Windows shell words its own. A Slack row that
 *     rang live or was held for good ("slack-held:") never rings here. Slack
 *     off: not one read more than the mail-only sweep.
 *
 * Desktop apps: the summary rides only sendPushNotification's channels (web
 * push subscriptions, Telegram, FCM, APNs), never the real-time frame the
 * desktop shells turn into banners, and the claim row is neither a bell entry
 * nor an urgent-mail row, so the Windows catch-up never reads it. Each desktop
 * app summarizes its own held mail, so each surface rings once, just as a live
 * PUSH mail rings each surface once (#1637). Desktop presence is not consulted:
 * desktop-presence.ts is a per-process liveness hint, and a running desktop app
 * says nothing about whether the phone or the browser heard anything.
 *
 * Kill switch: PUSH_QUIET_HOLD_DISABLED=true stops the sweep, so pushes held
 * by quiet hours are dropped as before. Read at call time.
 */

import { HIDDEN_CLAIM_TYPE } from "../agentcore/auto-reply-ledger-keys.js";
import { slackOpenTo } from "../config.js";
import { prisma } from "../db.js";
import { stampDecisionRang } from "../judge/decision-label.js";
import { logDbFailure } from "../report-db-failure.js";
import { SLACK_NOTIFICATION_TYPE, SLACK_ROW_KEY_PREFIX } from "../slack/push-strings.js";
import { withoutAnsweredEpisodes } from "./held-slack-rows.js";
import type { MailPushLane } from "./mail-push-content.js";
import {
  type NotificationLanguage,
  notificationCopy,
  resolveNotificationLanguage,
} from "./notification-strings.js";
import { type OpenPushMail, openPushMail, unreadUrgentMailRows } from "./open-push-mail.js";
import { sendPushNotification } from "./push.js";
import { lastEndedQuietWindow, type QuietWindow } from "./quiet-hours.js";

/** How long after a window ends its summary may still ring (restarts, a slow tick). */
export const QUIET_SUMMARY_GRACE_MS = 2 * 60 * 60 * 1000;
/** Held mail read per window, newest first; the Mac's cap too. */
export const QUIET_SUMMARY_MAX_MAIL = 200;
/** Senders named in the summary body before "+k" (both desktop apps use 3). */
export const QUIET_SUMMARY_SENDERS_MAX = 3;
const CLAIM_KEY_PREFIX = "quiet-summary:";
const CLAIM_TITLE = "Quiet hours summary";
const TODAY_PATH = "/today";
const DISABLED_VALUES = ["true", "1", "yes", "on"];
/** sendPushNotification's skip reason when a per-user rate bucket refused. */
const RATE_LIMITED = "rate_limited";

/** A Slack PUSH held during quiet hours: its bell row, which carries the live push's text. */
export interface HeldSlackRow {
  bellId: string;
  title: string;
  body: string;
  createdAt: Date;
}

/** What the sweep rings: the summary, the one held mail in N1 shape, or the one held Slack push. */
interface HeldMailPush {
  title: string;
  body: string;
  url: string;
  attentionItemId?: string;
  lane?: MailPushLane;
  language?: NotificationLanguage;
  emailId?: string;
  bellNotificationId?: string;
}

interface QuietConfigRow {
  userId: string;
  timezone: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  notificationLanguage: string;
}

/** Operator kill switch, read at call time so an env flip needs no deploy. */
export function quietHoldDisabled(): boolean {
  return DISABLED_VALUES.includes(
    (process.env.PUSH_QUIET_HOLD_DISABLED ?? "").trim().toLowerCase(),
  );
}

/**
 * One scheduler tick: every user whose quiet window just ended. Returns how
 * many rang (push.ts reported "sent"); a skipped push is logged, not counted.
 */
export async function sendQuietHoursSummaries(now: Date = new Date()): Promise<number> {
  if (quietHoldDisabled()) return 0;
  const configs: QuietConfigRow[] = await prisma.automationConfig.findMany({
    where: { quietHoursStart: { not: null }, quietHoursEnd: { not: null } },
    select: {
      userId: true,
      timezone: true,
      quietHoursStart: true,
      quietHoursEnd: true,
      notificationLanguage: true,
    },
  });
  let rung = 0;
  for (const config of configs) {
    try {
      if (await summarizeHeldMail(config, now)) rung++;
    } catch (err) {
      // One user's failure (a data wipe in progress, a DB blip) must not
      // starve the rest of the sweep. Before the claim the next tick retries;
      // after it the window is spent. The kind only: a Prisma message can echo
      // what it was given, and the single-mail push carries a sender's name.
      logDbFailure("[QUIET] summary failed", err, { ids: { userId: config.userId } });
    }
  }
  return rung;
}

async function summarizeHeldMail(config: QuietConfigRow, now: Date): Promise<boolean> {
  const window = lastEndedQuietWindow(now, config, config.timezone);
  if (!window || now.getTime() - window.end.getTime() > QUIET_SUMMARY_GRACE_MS) return false;
  const { userId } = config;
  const dedupeKey = `${CLAIM_KEY_PREFIX}${window.endDateKey}`;
  if (await windowClaimed(userId, dedupeKey)) return false;

  const language = resolveNotificationLanguage(config.notificationLanguage);
  const held = await heldPushMail(userId, window, language);
  const slack = await heldSlackPush(userId, window);
  const count = held.length + slack.length;
  if (count === 0) return false;
  if (!(await claimWindow(userId, dedupeKey, count))) return false;

  const result = await sendPushNotification(
    userId,
    quietSummaryPush(held, language, slack),
    "email_urgent",
    // Held mail is not news: ambient, never the interrupt bucket.
    { bucket: "ambient" },
  );
  // The held mail rang now: its ledger rows record the ring (IP24). A summary
  // the gates held again records nothing.
  if (result.dispatchedAt && held.length > 0) {
    await stampDecisionRang(
      userId,
      held.map((m) => m.emailId),
      result.dispatchedAt,
    );
  }
  if (result.status === "sent") return true;
  console.log(`[QUIET] summary not rung for user ${userId}: ${result.reason ?? "unknown"}`);
  if (result.reason === RATE_LIMITED) {
    await prisma.notification.deleteMany({ where: { userId, dedupeKey } });
  }
  return false;
}

/** The window's held mail that still deserves a ring, one per mail, newest first. */
async function heldPushMail(
  userId: string,
  window: QuietWindow,
  language: NotificationLanguage,
): Promise<OpenPushMail[]> {
  const rows = await prisma.notification.findMany({
    where: { ...unreadUrgentMailRows(userId), createdAt: { gte: window.start, lt: window.end } },
    select: { id: true, sourceEmailId: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: QUIET_SUMMARY_MAX_MAIL,
  });
  const mail = await openPushMail(userId, rows, language, { skipReadMail: true });
  // Two urgent rows can name one mail (a re-ring from before 2026-11-15, when
  // Clear all still deleted rows, or a race between the two ring paths): count
  // it once.
  const seen = new Set<string>();
  return mail.filter((m) => {
    if (seen.has(m.emailId)) return false;
    seen.add(m.emailId);
    return true;
  });
}

/**
 * The window's held Slack PUSH that still deserves a ring, newest first. Slack
 * closed to this user (flag off, or outside its cohort): none, and no read.
 * Named rows only: a Slack row with no key is from before episodes were named,
 * or a second row of an episode whose named row already stands for it.
 */
async function heldSlackPush(userId: string, window: QuietWindow): Promise<HeldSlackRow[]> {
  if (!slackOpenTo(userId)) return [];
  const rows = await prisma.notification.findMany({
    where: {
      userId,
      type: SLACK_NOTIFICATION_TYPE,
      isRead: false,
      createdAt: { gte: window.start, lt: window.end },
      dedupeKey: { startsWith: SLACK_ROW_KEY_PREFIX },
    },
    select: { id: true, title: true, message: true, createdAt: true, dedupeKey: true },
    orderBy: { createdAt: "desc" },
    take: QUIET_SUMMARY_MAX_MAIL,
  });
  const deserving = await withoutAnsweredEpisodes(userId, rows);
  return deserving.map((row) => ({
    bellId: row.id,
    title: row.title,
    body: row.message,
    createdAt: row.createdAt,
  }));
}

/**
 * The push for what was held: the mail itself when one, else one summary. With
 * held Slack PUSH among it: the Slack push itself when it is all there is, else
 * one summary worded "urgent messages", naming every item newest first.
 */
export function quietSummaryPush(
  held: readonly OpenPushMail[],
  language: NotificationLanguage,
  slack: readonly HeldSlackRow[] = [],
): HeldMailPush {
  if (slack.length > 0) return withSlackPush(held, language, slack);
  const [first] = held;
  if (held.length === 1) {
    return {
      title: first.title,
      body: first.body,
      url: `/email/${encodeURIComponent(first.emailId)}`,
      attentionItemId: first.attentionItemId,
      lane: "PUSH",
      language,
      emailId: first.emailId,
      bellNotificationId: first.bellId,
    };
  }
  return {
    title: notificationCopy(language).heldDuringQuietHours(held.length),
    body: formatSenders(held.map((m) => m.title)),
    url: TODAY_PATH,
  };
}

function withSlackPush(
  held: readonly OpenPushMail[],
  language: NotificationLanguage,
  slack: readonly HeldSlackRow[],
): HeldMailPush {
  const [only] = slack;
  if (held.length === 0 && slack.length === 1) {
    // As the live Slack push (slack/notify.ts ring): its text, opening Today.
    return {
      title: only.title,
      body: only.body,
      url: TODAY_PATH,
      bellNotificationId: only.bellId,
      language,
    };
  }
  const items = [...held, ...slack].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return {
    title: notificationCopy(language).messagesDuringQuietHours(items.length),
    body: formatSenders(items.map((item) => item.title)),
    url: TODAY_PATH,
  };
}

/**
 * "A, B, C +2": distinct senders in order, at most `max` named (as both
 * desktop apps). Trims only: pass titles mailPushContent already folded.
 */
export function formatSenders(
  names: readonly string[],
  max: number = QUIET_SUMMARY_SENDERS_MAX,
): string {
  const distinct = [...new Set(names.map((n) => n.trim()).filter((n) => n.length > 0))];
  const shown = distinct.slice(0, max).join(", ");
  const rest = distinct.length - max;
  return rest > 0 ? `${shown} +${rest}` : shown;
}

/** One indexed read, so a window already rung costs a tick nothing more. */
async function windowClaimed(userId: string, dedupeKey: string): Promise<boolean> {
  const claim = await prisma.notification.findUnique({
    where: { userId_dedupeKey: { userId, dedupeKey } },
    select: { id: true },
  });
  return claim !== null;
}

/**
 * Claim this user's window: true for the one caller whose create wins. The
 * row is a hidden claim (never listed in the bell, never unread) and carries
 * no mail content.
 */
async function claimWindow(userId: string, dedupeKey: string, count: number): Promise<boolean> {
  try {
    await prisma.notification.create({
      data: {
        userId,
        type: HIDDEN_CLAIM_TYPE,
        isRead: true,
        dedupeKey,
        title: CLAIM_TITLE,
        message: `${count} held`,
      },
      select: { id: true },
    });
    return true;
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") return false; // already rung
    throw err;
  }
}
