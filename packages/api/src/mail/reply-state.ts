/**
 * Reply state (2026-09-14): the axis every reference client labels first —
 * Spark's "To respond / Actioned", Superhuman's "needs response",
 * Inbox Zero's Reply Zero. Klorn judged `needsReply` at sync time but only
 * showed it inside the reading pane, and never recorded that the user had
 * replied. Now each inbox row carries one of:
 *
 *   "needsReply" — the summarize pass judged a reply is owed and none was
 *                  sent through Klorn since
 *   "replied"    — the user answered this mail through Klorn (reply draft,
 *                  agent, auto mode); a recorded fact
 *   null         — no claim
 *
 * Replies sent from Gmail directly are NOT seen (the local mirror is
 * INBOX-only) — stated, not hidden: the chip says "answered in Klorn".
 */

import { prisma } from "../db.js";
import { captureError } from "../sentry.js";

export type ReplyState = "needsReply" | "replied";

export function replyStateOf(email: {
  needsReply?: boolean | null;
  repliedAt?: Date | null;
}): ReplyState | null {
  if (email.repliedAt) return "replied";
  if (email.needsReply) return "needsReply";
  return null;
}

/**
 * A draft is waiting for this mail: one was written ahead of time
 * (proactive-drafts.ts) and the mail has not been answered since.
 */
export function draftReadyFor(email: {
  proactiveDraft?: string | null;
  repliedAt?: Date | null;
}): boolean {
  return offeredDraftFor(email) !== null;
}

/**
 * The draft the reading pane may offer, or null. One rule for the row flag
 * and the detail payload: an answered mail offers nothing, however good the
 * draft was.
 */
export function offeredDraftFor(email: {
  proactiveDraft?: string | null;
  repliedAt?: Date | null;
}): string | null {
  if (email.repliedAt) return null;
  return email.proactiveDraft?.trim() ? email.proactiveDraft : null;
}

/**
 * Record that the user answered this mail. `ref` is the EmailMessage id or
 * its gmailId (the reply routes hold either). Scoped by userId so a foreign
 * id is a no-op; fail-soft — a bookkeeping miss must never fail a send
 * that already went out.
 */
export async function markEmailReplied(userId: string, ref: string): Promise<void> {
  try {
    await prisma.emailMessage.updateMany({
      where: { userId, OR: [{ id: ref }, { gmailId: ref }] },
      data: { repliedAt: new Date() },
    });
  } catch (err) {
    console.warn("[REPLY-STATE] mark replied failed:", err instanceof Error ? err.message : err);
    captureError(err, { tags: { scope: "reply-state.mark" }, extra: { userId, ref } });
  }
}
