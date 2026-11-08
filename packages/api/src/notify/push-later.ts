/**
 * "Later" from a web push action (decision N1): the reminder the in-app Later
 * sets for a mail — later today, LATER_TODAY hours out — written for the
 * one mail a verified push-later token names (notify/push-later-token.ts).
 * The shared write lives in pim/mail-reminder.ts; the reminder scheduler
 * (pim/reminder-scheduler.ts) delivers it.
 *
 * The mail must be the token user's own; nothing else is read or written.
 * Idempotent: a second tap or a replayed token finds the pending reminder for
 * the mail and sets no other, nor moves it.
 */

import { setMailReminder } from "../pim/mail-reminder.js";
import type { PushLaterGrant } from "./push-later-token.js";

/** "Later today": the web reader's offset (web app/email/_v2/reminders.ts). */
export const PUSH_LATER_HOURS = 4;

export type PushLaterResult = { ok: true; created: boolean } | { ok: false };

export async function remindLaterFromPush(
  grant: PushLaterGrant,
  now: Date = new Date(),
): Promise<PushLaterResult> {
  const result = await setMailReminder(
    grant.userId,
    grant.emailId,
    new Date(now.getTime() + PUSH_LATER_HOURS * 3_600_000),
    { onPending: "keep" },
  );
  return result.ok ? { ok: true, created: result.created } : { ok: false };
}
