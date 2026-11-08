/**
 * Mail's "Later": a reminder about one mail (POST /api/reminders), the one
 * request a Mail v2 row and the Today cover screen both send. The mail itself
 * does not change; the caller confirms with a toast. Times: reminders.ts.
 */

import type { EmailListItem } from "@klorn/contract";
import { apiFetch } from "../../../lib/api";
import { type ReminderKey, reminderDate } from "./reminders";

type Translate = (key: string, vars?: Record<string, string>) => string;

export type ReminderMail = Pick<EmailListItem, "id" | "from" | "subject" | "needsReply">;

export async function postReminder(
  email: ReminderMail,
  key: ReminderKey,
  t: Translate,
  now: Date = new Date(),
): Promise<void> {
  const subject = email.subject || t("mailV2.noSubject");
  await apiFetch("/api/reminders", {
    method: "POST",
    body: JSON.stringify({
      title: t(
        email.needsReply ? "emailDetail.reminderTitle.replyTo" : "emailDetail.reminderTitle.review",
        { subject },
      ),
      remindAt: reminderDate(key, now).toISOString(),
      description: [`From: ${email.from}`, `Open: /email/${email.id}`].join("\n"),
    }),
  });
}
