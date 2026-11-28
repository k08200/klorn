/**
 * What the reply-wait reminders of proactive-actions.ts read: their age
 * windows, their order, the bulk-mail filter, one mail per thread, and the
 * sender's contact line. Split from proactive-actions.ts, which re-exports
 * getContactContext.
 */

import { prisma } from "../db.js";
import { parseAddress } from "../mail/email-address.js";
import { contactContextLabel } from "./reply-wait-content.js";

/** The oldest mail the unanswered reminder (flag off) still lists. */
export const UNANSWERED_MAX_AGE_DAYS = 7;
/** The follow-up suggestion: older than this, up to FOLLOW_UP_MAX_AGE_DAYS. */
export const FOLLOW_UP_MIN_AGE_HOURS = 72;
export const FOLLOW_UP_MAX_AGE_DAYS = 14;
/**
 * Rows read per reminder before one-per-thread folding: the title counts what
 * waits, so the read is not cut to the lines shown.
 */
export const REPLY_WAIT_SCAN = 100;
/** Follow-up lines that get a contact lookup (the ones listed). */
export const FOLLOW_UP_LISTED = 3;
/** Both reminder types: the merged one dedupes against either, so a flip mid-day never sends twice. */
export const REPLY_WAIT_TYPES = ["email_followup", "followup"];
/**
 * Most important first, deterministically: URGENT before NORMAL before LOW
 * (EmailPriority's declaration order, which Postgres sorts enums by), then the
 * judge's reply confidence, then the mail that has waited longest; the id
 * breaks every remaining tie.
 */
export const REPLY_WAIT_ORDER = [
  { priority: "asc" as const },
  { needsReplyConfidence: "desc" as const },
  { receivedAt: "asc" as const },
  { id: "asc" as const },
];

/**
 * Bulk mail stays out. `category NOT IN (...)` alone is NULL for a mail with
 * no category, which drops it: the null branch keeps unclassified mail in.
 */
export const NOT_BULK = [{ category: null }, { category: { notIn: ["automated", "newsletter"] } }];

export const WAITING_SELECT = {
  id: true,
  from: true,
  subject: true,
  receivedAt: true,
  threadId: true,
} as const;

/** One mail per thread, the first in order: a back-and-forth is one thing to answer. */
export function oneMailPerThread<T extends { id: string; threadId: string | null }>(
  rows: readonly T[],
): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = row.threadId ?? `id:${row.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── NEW: Contact context on emails ────────────────────────────────────

/**
 * Enrich unanswered email notifications with contact history. The sender is
 * matched on the whole address: the From header is the sender's to write, so a
 * part of it (`ceo@` of ceo@evil.com, or an empty one) must not pick a contact.
 */
export async function getContactContext(userId: string, fromEmail: string): Promise<string> {
  const email = parseAddress(fromEmail);
  const contact = await prisma.contact.findFirst({
    where: { userId, email: { equals: email.trim(), mode: "insensitive" } },
    select: { name: true, company: true, role: true, tags: true },
  });
  return contact ? contactContextLabel(contact) : "";
}
