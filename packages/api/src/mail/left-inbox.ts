/**
 * What a single trash or archive leaves behind in Klorn once the mail has left
 * the inbox (docs/design/mail-cleanup-actions.md, PR1): no local row and no open
 * attention item, whichever provider ran it.
 *
 * Gmail and IMAP drop the row inside their provider call; Outlook's Graph move
 * does not, and its delta poll skips `@removed` entries, so the row stayed in
 * Klorn for good. The delete here is scoped by owner and idempotent. The rows are
 * gone, so no sync can notice the mail left and close its attention items (the
 * bulk route closes them for the same reason): they are closed here, or deleted
 * mail keeps showing on PUSH.
 */

import { prisma } from "../db.js";
import { resolveAttentionForEmails } from "../judge/attention-resolve.js";
import { captureDbFailure, logDbFailure } from "../report-db-failure.js";

/**
 * Remove the row of a mail that left the inbox. Fail-soft like the attention
 * close below: by now the provider moved the mail, so answering "failed" would be
 * false. A row left behind is reported, and a retry of the action is idempotent.
 */
export async function removeLeftInboxRow(userId: string, emailId: string): Promise<void> {
  try {
    await prisma.emailMessage.deleteMany({ where: { userId, id: emailId } });
  } catch (err) {
    logDbFailure("[EMAIL] row delete after a single action failed", err, {
      level: "error",
      ids: { userId, emailId },
    });
    captureDbFailure("[EMAIL] row delete after a single action failed", err, {
      tags: { scope: "email.single-action.row-delete" },
      extra: { userId },
    });
  }
}

/**
 * Close the attention items of a mail that left the inbox. Fail-soft: the mail
 * already left, and a bookkeeping miss must not report the action as failed.
 */
export async function closeLeftInboxAttention(userId: string, emailId: string): Promise<void> {
  try {
    await resolveAttentionForEmails(userId, [emailId]);
  } catch (err) {
    logDbFailure("[EMAIL] attention resolve after a single action failed", err, {
      ids: { userId, emailId },
    });
    captureDbFailure("[EMAIL] attention resolve after a single action failed", err, {
      tags: { scope: "email.single-action.resolve" },
      extra: { userId },
    });
  }
}
