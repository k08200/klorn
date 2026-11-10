/**
 * Dedup marker for the urgent-email notification sweep.
 *
 * The scheduler records which urgent emails it has already pinged by embedding
 * their Gmail message IDs in the Notification.message string, then reads them
 * back next tick to avoid re-notifying. The marker is a single trailing
 * `[id1,id2,…]` block: anchoring the reader to the END of the string (`$`)
 * avoids false-positives from any `[...]` that appears inside the human-facing
 * body (e.g. a sender name or subject), while still capturing EVERY notified id.
 *
 * The previous format embedded only the first email's id, so when several
 * urgent emails arrived in one tick the rest were never recorded and got
 * re-notified every sync tick for up to an hour.
 */

import { isImapMessageId } from "../mail/imap-message-id.js";

/** Build `"<body> [id1,id2,…]"`. Gmail message IDs are hex, never contain commas. */
export function buildUrgentDedupMessage(body: string, gmailIds: readonly string[]): string {
  return `${body} [${gmailIds.join(",")}]`;
}

/**
 * Extract every notified gmailId from prior notification messages. Reads only
 * the trailing `[...]` marker of each message and splits it, so all ids written
 * by buildUrgentDedupMessage are recovered. Backward-compatible with the old
 * single-id `[gmailId]` format (split of one element yields that one id).
 */
export function parseNotifiedGmailIds(messages: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const match = message.match(/\[([^\]]+)\]$/);
    if (!match) continue;
    for (const id of match[1].split(",")) {
      const trimmed = id.trim();
      if (trimmed) ids.add(trimmed);
    }
  }
  return ids;
}

/** A prior notification as the dedupe reads it: its text and when it was written. */
export interface NotifiedMarker {
  message: string;
  createdAt: Date;
}

/** Every id named in a trailing marker, with the time of the LATEST notification naming it. */
export function latestNotifiedAt(notifications: readonly NotifiedMarker[]): Map<string, Date> {
  const latest = new Map<string, Date>();
  for (const { message, createdAt } of notifications) {
    for (const id of parseNotifiedGmailIds([message])) {
      const seen = latest.get(id);
      if (!seen || createdAt.getTime() > seen.getTime()) latest.set(id, createdAt);
    }
  }
  return latest;
}

/**
 * Whether a marker for this email's id counts as "already notified". Gmail ids: always
 * (the behaviour before B2b). IMAP ids name a message only under one UIDVALIDITY: after
 * a repair re-keys the old row (step B2b), a NEW message can arrive under the same id,
 * so a marker counts only when it was written at or after this row was created.
 * The firewall PUSH path applies the same rule in its query (email-firewall.ts).
 */
export function markerCountsFor(
  email: { gmailId: string; createdAt: Date },
  notifiedAt: Date,
): boolean {
  return !isImapMessageId(email.gmailId) || notifiedAt.getTime() >= email.createdAt.getTime();
}

/** The emails no counting marker names yet, in their order. */
export function unnotifiedEmails<T extends { gmailId: string; createdAt: Date }>(
  emails: readonly T[],
  notified: ReadonlyMap<string, Date>,
): T[] {
  return emails.filter((email) => {
    const at = notified.get(email.gmailId);
    return at === undefined || !markerCountsFor(email, at);
  });
}

/**
 * The at-most-once key of an urgent batch, named after its lead email. Gmail:
 * `urgent:<gmailId>`, unchanged. IMAP: the row id is added, because the key is unique
 * forever and a new message that reuses a re-keyed id (B2b) is a different email.
 */
export function urgentDedupeKey(lead: { id: string; gmailId: string }): string {
  return isImapMessageId(lead.gmailId)
    ? `urgent:${lead.gmailId}@${lead.id}`
    : `urgent:${lead.gmailId}`;
}
