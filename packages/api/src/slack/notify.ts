/**
 * Rings a Slack PUSH episode (docs/providers/slack.md §9) through the same
 * path as PUSH mail: the interrupt budget first (admitPushNotification — the
 * per-day budget, the trusted reserve, the user's urgent-push opt-out, quiet
 * hours and focus window), then the open clients and device push with the
 * urgent-interrupt category. The bell row's link is the Slack permalink; the
 * device push opens Today (service workers only open same-origin paths).
 * Held by the budget: a bell row the user can find later, no ring.
 */

import type { SlackConversationKind } from "../judge/email-classifier.js";
import { admitPushNotification } from "../judge/v3/push-budget-gate.js";
import { prisma } from "../db.js";
import { getUserNotificationLanguage } from "../notify/notification-strings.js";
import { slackPushContent } from "./push-content.js";
import { isUniqueViolation } from "./unique-violation.js";

export const SLACK_NOTIFICATION_TYPE = "slack";
/** Where a tap on the device push lands: Today, whose bell holds the Slack link. */
export const SLACK_PUSH_OPEN_PATH = "/today";

export interface SlackPushInput {
  userId: string;
  episodeId: string;
  kind: SlackConversationKind;
  preview: string;
  reason: string;
  link: string | null;
  now?: Date;
}

export type SlackPushOutcome = "admitted" | "unbudgeted" | "held";

async function writeHeldRow(
  userId: string,
  episodeId: string,
  row: { type: string; title: string; message: string; link?: string },
): Promise<void> {
  try {
    await prisma.notification.create({
      data: { userId, ...row, dedupeKey: `slack:${episodeId}` },
      select: { id: true },
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
  const [{ pushNotification }, { sendPushNotification }, { desktopAlertTag }] = await Promise.all([
    import("../websocket.js"),
    import("../notify/push.js"),
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
  const admission = await admitPushNotification(input.userId, row, {
    pinned: false,
    trusted: false,
    now: input.now,
  });
  if (admission.status === "held") {
    await writeHeldRow(input.userId, input.episodeId, row);
    return "held";
  }
  if (admission.status === "unbudgeted") return "unbudgeted";
  await ring(input.userId, admission.notification, content, input.link, language);
  return "admitted";
}
