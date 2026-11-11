/**
 * One urgent mail rings once: the agent's notify_user must not ring for a mail
 * the firewall (or the urgent-priority sweep) already rang as urgent mail.
 *
 * Production, 2026-11-11: a PUSH mail rang "Urgent email" (interrupt bucket)
 * and 13 s later the agent's notify_user rang "[Klorn] Unverified quote request
 * with a deadline" (ambient bucket) for the same mail. The agent deduped only
 * against its own notifications (title key, dedupKey), never against the
 * urgent-mail bell row.
 *
 * Linkage. The agent run is not tied to particular mail: the email trigger and
 * the 5-minute tick both run the same loop over the context mails
 * (agent-context.ts), which the prompt numbers "Email #N". The server keeps
 * that numbered list for the run, so:
 *   - a notify_user with `emailRef: N` is about context mail N (any other
 *     value is ignored: the model never hands the server a mail id);
 *   - an "email" notify_user without a usable ref is about one of the context
 *     mails: when every one of them already rang, the notification repeats a
 *     ring whichever mail it means;
 *   - anything else is about no context mail and rings as before.
 * The mail "already rang" when an urgent-mail bell row names it — the same row
 * and the same 7-day window the firewall's own push dedupe reads
 * (firewall-push.ts), so the two paths agree on what "already pushed" means.
 */

import { prisma } from "../db.js";
import { URGENT_EMAIL_TITLES } from "../notify/notification-strings.js";
import { latestNotifiedAt, markerCountsFor } from "../notify/urgent-dedup.js";
import { captureError } from "../sentry.js";
import { HIDDEN_CLAIM_TYPE } from "./auto-reply-ledger-keys.js";

/** The firewall push dedupe window (firewall-push.ts PUSH_DEDUP_WINDOW_MS). */
const URGENT_ROW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** A context mail, in "Email #N" order (N = index + 1). */
export interface AgentContextEmail {
  id: string;
  gmailId: string;
  createdAt: Date;
}

/** "2", "#2", "Email #2" — the shapes a model writes a ref in. */
const TEXT_REF = /^\s*(?:email\s*)?#?\s*(\d{1,4})\s*$/i;
/** Longer text is not a ref; the cap also bounds the regex on model output. */
const MAX_TEXT_REF_LENGTH = 16;

function parseEmailRef(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value !== "string" || value.length > MAX_TEXT_REF_LENGTH) return null;
  const match = value.match(TEXT_REF);
  return match ? Number(match[1]) : null;
}

/**
 * The context mails a notify_user call is about: the one its emailRef names;
 * for an "email" notification without a usable ref, every context mail (it is
 * about one of them, and which one is unknown); otherwise none.
 */
export function notifyTargetEmails(
  args: { emailRef?: unknown; category?: unknown },
  contextEmails: readonly AgentContextEmail[],
): readonly AgentContextEmail[] {
  const ref = parseEmailRef(args.emailRef);
  if (ref !== null && ref >= 1 && ref <= contextEmails.length) {
    return [contextEmails[ref - 1]];
  }
  return args.category === "email" ? contextEmails : [];
}

/**
 * The ids of the given mails an urgent-mail bell row already names: a firewall
 * row by its sourceEmailId, an urgent-sweep batch row by its trailing
 * `[id1,id2,…]` marker (urgent-dedup.ts, with the IMAP re-key rule). Hidden
 * claim rows count: a v3 user's cleared bell keeps them, and the mail rang.
 */
export async function urgentRungEmailIds(
  userId: string,
  emails: readonly AgentContextEmail[],
): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const rows = await prisma.notification.findMany({
    where: {
      userId,
      type: { in: ["email", HIDDEN_CLAIM_TYPE] },
      title: { in: [...URGENT_EMAIL_TITLES] },
      createdAt: { gte: new Date(Date.now() - URGENT_ROW_WINDOW_MS) },
    },
    select: { sourceEmailId: true, message: true, createdAt: true },
  });
  const bySource = new Set(rows.flatMap((row) => (row.sourceEmailId ? [row.sourceEmailId] : [])));
  const byMarker = latestNotifiedAt(rows);
  return new Set(
    emails
      .filter((email) => {
        if (bySource.has(email.id)) return true;
        const at = byMarker.get(email.gmailId);
        return at !== undefined && markerCountsFor(email, at);
      })
      .map((email) => email.id),
  );
}

/**
 * True when this notify_user is about context mail that every one already rang
 * as urgent mail, so ringing again would repeat it. Fails open: a lookup error
 * is logged and the notification rings as it did before this check existed.
 */
export async function notifyRepeatsUrgentMail(
  userId: string,
  args: { emailRef?: unknown; category?: unknown },
  contextEmails: readonly AgentContextEmail[],
): Promise<boolean> {
  const targets = notifyTargetEmails(args, contextEmails);
  if (targets.length === 0) return false;
  try {
    const rung = await urgentRungEmailIds(userId, targets);
    return targets.every((email) => rung.has(email.id));
  } catch (err) {
    console.warn(
      "[AGENT] urgent-mail overlap lookup failed (notification rings):",
      err instanceof Error ? err.message : String(err),
    );
    captureError(err, { tags: { scope: "agent.urgent-overlap" }, extra: { userId } });
    return false;
  }
}
