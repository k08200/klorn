/**
 * One mail's reminder — the "Later" every surface offers: the in-app Later
 * (POST /api/email/:id/later) and the web push Later (notify/push-later.ts).
 * Both write the same Reminder row, titled in the user's notification language
 * and described as "From: …\nOpen: /email/:id", which the reminder scheduler
 * (pim/reminder-scheduler.ts) reads back to open the mail when it fires.
 *
 * The mail must be the user's own; nothing else is read or written. At most
 * one PENDING reminder per mail: a repeat either moves it to the new time (the
 * in-app choice, where the user just picked a time) or keeps it (a push tap
 * replayed or tapped twice).
 */

import { prisma } from "../db.js";
import { escapeLikePattern } from "../db-like.js";
import { getUserNotificationLanguage, notificationCopy } from "../notify/notification-strings.js";
import { pushActionCopy } from "../notify/push-action-strings.js";
import { createReminder } from "./reminders.js";

export type MailReminderPending = "move" | "keep";

export type MailReminderResult =
  | { ok: true; created: boolean; reminder: { id: string; remindAt: string } }
  | { ok: false };

const OPEN_PREFIX = "Open: /email/";
/**
 * The LAST line only — the one the server writes. The id charset is a Klorn
 * EmailMessage id's (uuid) and test ids'; nothing path-like.
 */
const OPEN_LINE = /(?:^|\n)Open: \/email\/([A-Za-z0-9_-]{1,128})$/;

function openLine(emailId: string): string {
  return `${OPEN_PREFIX}${emailId}`;
}

/** The sender on one line: a decoded header must not add a line of its own. */
function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

function mailDescription(from: string, emailId: string): string {
  return [`From: ${oneLine(from)}`, openLine(emailId)].join("\n");
}

/**
 * The mail a reminder is about, read from its description's Open line — or
 * null for a reminder that names no mail (or names one in any other shape).
 */
export function mailReminderEmailId(description: string | null | undefined): string | null {
  if (!description) return null;
  return OPEN_LINE.exec(description)?.[1] ?? null;
}

export async function setMailReminder(
  userId: string,
  emailId: string,
  remindAt: Date,
  options: { onPending: MailReminderPending },
): Promise<MailReminderResult> {
  const email = await prisma.emailMessage.findFirst({
    where: { id: emailId, userId },
    select: { id: true, from: true, subject: true },
  });
  if (!email) return { ok: false };

  const pending = await prisma.reminder.findFirst({
    where: {
      userId,
      status: "PENDING",
      // The description's last line, exactly: no other mail's id (or a prefix of it) matches.
      description: { endsWith: escapeLikePattern(`\n${openLine(email.id)}`) },
    },
    select: { id: true, remindAt: true },
  });
  if (pending) {
    if (options.onPending === "keep") {
      return {
        ok: true,
        created: false,
        reminder: { id: pending.id, remindAt: pending.remindAt.toISOString() },
      };
    }
    // Scoped by user and status, so a reminder that fired meanwhile is not
    // revived; then it is gone, and a new one is set below.
    const moved = await prisma.reminder.updateMany({
      where: { id: pending.id, userId, status: "PENDING" },
      data: { remindAt },
    });
    if (moved.count > 0) {
      return {
        ok: true,
        created: false,
        reminder: { id: pending.id, remindAt: remindAt.toISOString() },
      };
    }
  }

  const language = await getUserNotificationLanguage(userId);
  const subject = email.subject || notificationCopy(language).noSubject;
  const { reminder } = await createReminder(
    userId,
    pushActionCopy(language).laterReminderTitle(subject),
    remindAt.toISOString(),
    mailDescription(email.from, email.id),
  );
  return { ok: true, created: true, reminder: { id: reminder.id, remindAt: reminder.remindAt } };
}
