/**
 * Mail's "Later": a reminder about one mail (POST /api/email/:id/later), the
 * one request every web Later sends — a Mail v2 row, the reader, the legacy
 * list and the Today cards. Only the chosen time goes up; the server titles
 * the reminder and links the mail, the same way the web push Later does. The
 * mail itself does not change; the caller confirms with a toast once this
 * resolves, and shows its error when it throws. Times: reminders.ts.
 */

import { apiFetch } from "../../../lib/api";
import { type ReminderKey, reminderDate } from "./reminders";

export async function postReminder(
  emailId: string,
  key: ReminderKey,
  now: Date = new Date(),
): Promise<void> {
  await apiFetch(`/api/email/${encodeURIComponent(emailId)}/later`, {
    method: "POST",
    body: JSON.stringify({ remindAt: reminderDate(key, now).toISOString() }),
  });
}
