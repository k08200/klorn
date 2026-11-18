/**
 * Rings a Slack PUSH episode (docs/providers/slack.md §9) through the same
 * path as PUSH mail: the interrupt budget first (admitPushNotification — the
 * per-day budget, the trusted reserve, the user's urgent-push opt-out, quiet
 * hours and focus window), then the open clients and device push with the
 * urgent-interrupt category. The bell row's link is the Slack permalink; the
 * device push opens Today (service workers only open same-origin paths).
 * Held by the budget: a bell row the user can find later, no ring. Will not
 * ring (quiet hours, focus, the urgent-mail opt-out): the bell row plus its
 * live frame, which desktopAlertTag leaves untagged, so no device push and no
 * banner; the Windows shell holds such a frame and toasts it once quiet hours
 * end (packages/web lib/native/desktop-push-catchup.ts, as for PUSH mail), and
 * the server's quiet-hours summary counts it for the phone and the browser
 * (notify/quiet-hours-summary.ts). The row names its episode (dedupeKey
 * slack:<episodeId>), so that late ring is dropped once the user replied in
 * Slack. `ring: false` (a late re-judge, rejudge.ts) asks for the bell row
 * only. A row held for good (the budget, the ring cap, `ring: false`) is named
 * slack-held:<episodeId> instead, so nothing rings it later.
 *
 * Slack's share is bounded so other people's messages cannot crowd out mail:
 * at most SLACK_RINGS_PER_DAY Slack rings a (UTC) day (past it, a bell row
 * without a ring) and SLACK_BELL_ROWS_PER_DAY Slack bell rows (past it,
 * nothing; the episode keeps its PUSH verdict). The budget's trusted reserve is never Slack's (trusted:
 * false), so VIP mail always has room.
 */

import { prisma } from "../db.js";
import type { SlackConversationKind } from "../judge/email-classifier.js";
import { admitPushNotification } from "../judge/v3/push-budget-gate.js";
import { getUserNotificationLanguage } from "../notify/notification-strings.js";
import { slackPushContent } from "./push-content.js";
import {
  SLACK_HELD_ROW_KEY_PREFIX,
  SLACK_NOTIFICATION_TYPE,
  SLACK_ROW_KEY_PREFIX,
  SLACK_TITLE_PREFIX,
} from "./push-strings.js";
import { isUniqueViolation } from "./unique-violation.js";

export { SLACK_NOTIFICATION_TYPE };
/** Slack rings a day: under the default stranger slots, so mail keeps at least one. */
export const SLACK_RINGS_PER_DAY = 2;
/** Slack bell rows a day (rung, held or quiet-hours), so the bell cannot be flooded. */
export const SLACK_BELL_ROWS_PER_DAY = 20;
const INTERRUPT_SLOT_PREFIX = "interrupt:";
const DAY_MS = 86_400_000;
/** Where a tap on the device push lands: Today, whose bell holds the Slack link. */
export const SLACK_PUSH_OPEN_PATH = "/today";

export interface SlackPushInput {
  userId: string;
  episodeId: string;
  kind: SlackConversationKind;
  preview: string;
  reason: string;
  link: string | null;
  /** False: a bell row only, never a ring or a live frame. Default true. */
  ring?: boolean;
  now?: Date;
}

export type SlackPushOutcome = "admitted" | "unbudgeted" | "held" | "capped";

function utcDayStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
}

/** Today's Slack bell rows: ones still typed slack, and slot rows a "Clear all" hid. */
async function slackRowsToday(userId: string, now: Date): Promise<{ rows: number; rings: number }> {
  const since = { gte: utcDayStart(now) };
  const [rows, rings] = await Promise.all([
    prisma.notification.count({
      where: {
        userId,
        createdAt: since,
        OR: [{ type: SLACK_NOTIFICATION_TYPE }, { title: { startsWith: SLACK_TITLE_PREFIX } }],
      },
    }),
    prisma.notification.count({
      where: {
        userId,
        createdAt: since,
        dedupeKey: { startsWith: INTERRUPT_SLOT_PREFIX },
        title: { startsWith: SLACK_TITLE_PREFIX },
      },
    }),
  ]);
  return { rows, rings };
}

async function writeHeldRow(
  userId: string,
  episodeId: string,
  row: { type: string; title: string; message: string; link?: string },
): Promise<void> {
  try {
    await prisma.notification.create({
      data: { userId, ...row, dedupeKey: `${SLACK_HELD_ROW_KEY_PREFIX}${episodeId}` },
      select: { id: true },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
}

/** The bell's real-time frame, tagged for a desktop banner only where the gate allows one. */
async function sendLiveFrame(
  userId: string,
  notification: { id: string; createdAt: Date },
  content: { title: string; body: string },
  link: string | null,
): Promise<void> {
  const [{ pushNotification }, { desktopAlertTag }] = await Promise.all([
    import("../websocket.js"),
    import("../notify/desktop-alert.js"),
  ]);
  pushNotification(userId, {
    id: notification.id,
    type: SLACK_NOTIFICATION_TYPE,
    title: content.title,
    message: content.body,
    createdAt: notification.createdAt.toISOString(),
    ...(link ? { link } : {}),
    ...(await desktopAlertTag(userId, "push")),
  });
}

/** Names the episode on a row admitPushNotification wrote, as a held row is named. */
async function linkRowToEpisode(notificationId: string, episodeId: string): Promise<void> {
  try {
    await prisma.notification.updateMany({
      where: { id: notificationId, dedupeKey: null },
      data: { dedupeKey: `${SLACK_ROW_KEY_PREFIX}${episodeId}` },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
}

async function ring(
  userId: string,
  notification: { id: string; createdAt: Date },
  content: { title: string; body: string },
  link: string | null,
  language: string,
): Promise<void> {
  await sendLiveFrame(userId, notification, content, link);
  const { sendPushNotification } = await import("../notify/push.js");
  await sendPushNotification(
    userId,
    {
      title: content.title,
      body: content.body,
      url: SLACK_PUSH_OPEN_PATH,
      bellNotificationId: notification.id,
      language,
    },
    "email_urgent",
    // A PUSH-lane interrupt, like PUSH mail (push-interrupt-callers-guard.test.ts).
    { bucket: "interrupt" },
  );
}

export async function notifySlackPush(input: SlackPushInput): Promise<SlackPushOutcome> {
  const now = input.now ?? new Date();
  const today = await slackRowsToday(input.userId, now);
  if (today.rows >= SLACK_BELL_ROWS_PER_DAY) return "capped";
  const language = await getUserNotificationLanguage(input.userId);
  const content = slackPushContent({
    kind: input.kind,
    preview: input.preview,
    reason: input.reason,
    language,
  });
  const row = {
    type: SLACK_NOTIFICATION_TYPE,
    title: content.title,
    message: content.body,
    ...(input.link ? { link: input.link } : {}),
  };
  if (input.ring === false || today.rings >= SLACK_RINGS_PER_DAY) {
    await writeHeldRow(input.userId, input.episodeId, row);
    return "held";
  }
  const admission = await admitPushNotification(input.userId, row, {
    pinned: false,
    trusted: false,
    now,
  });
  if (admission.status === "held") {
    await writeHeldRow(input.userId, input.episodeId, row);
    return "held";
  }
  if (admission.status === "unbudgeted") {
    await linkRowToEpisode(admission.notification.id, input.episodeId);
    await sendLiveFrame(input.userId, admission.notification, content, input.link);
    return "unbudgeted";
  }
  await ring(input.userId, admission.notification, content, input.link, language);
  return "admitted";
}
