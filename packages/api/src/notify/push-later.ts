/**
 * "Later" from a web push action (decision N1): the reminder the web reader's
 * Later sets for a mail — later today, LATER_TODAY hours out — written for the
 * one mail a verified push-later token names (notify/push-later-token.ts).
 * The reminder scheduler (pim/reminder-scheduler.ts) delivers it.
 *
 * The mail must be the token user's own; nothing else is read or written.
 * Idempotent: a second tap or a replayed token finds the pending reminder for
 * the mail and sets no other.
 */

import { prisma } from "../db.js";
import { escapeLikePattern } from "../db-like.js";
import { createReminder } from "../pim/reminders.js";
import { getUserNotificationLanguage, notificationCopy } from "./notification-strings.js";
import { pushActionCopy } from "./push-action-strings.js";
import type { PushLaterGrant } from "./push-later-token.js";

/** "Later today": the web reader's offset (web app/email/_v2/reminders.ts). */
export const PUSH_LATER_HOURS = 4;

export type PushLaterResult = { ok: true; created: boolean } | { ok: false };

function openLine(emailId: string): string {
  return `Open: /email/${emailId}`;
}

export async function remindLaterFromPush(
  grant: PushLaterGrant,
  now: Date = new Date(),
): Promise<PushLaterResult> {
  const email = await prisma.emailMessage.findFirst({
    where: { id: grant.emailId, userId: grant.userId },
    select: { id: true, from: true, subject: true },
  });
  if (!email) return { ok: false };

  const pending = await prisma.reminder.findFirst({
    where: {
      userId: grant.userId,
      status: "PENDING",
      description: { contains: escapeLikePattern(openLine(email.id)) },
    },
    select: { id: true },
  });
  if (pending) return { ok: true, created: false };

  const language = await getUserNotificationLanguage(grant.userId);
  const subject = email.subject || notificationCopy(language).noSubject;
  await createReminder(
    grant.userId,
    pushActionCopy(language).laterReminderTitle(subject),
    new Date(now.getTime() + PUSH_LATER_HOURS * 3_600_000).toISOString(),
    // The web reader's description, so a reminder looks the same wherever it was set.
    [`From: ${email.from}`, openLine(email.id)].join("\n"),
  );
  return { ok: true, created: true };
}
