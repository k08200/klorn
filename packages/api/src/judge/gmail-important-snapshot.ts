/**
 * Gmail's own importance verdict on a mail, read from its stored labels when
 * Klorn judges it: the IP24 baseline (ip24.ts), i.e. what Gmail's "High
 * priority only" notification setting would ring for.
 *
 * Only Gmail mail has that verdict. The IMAP and Outlook syncs write
 * "IMPORTANT" for the user's own flag (imap-sync.ts, outlook-sync.ts), and
 * Klorn's own mailbox has none, so for them the answer is unknown (null), not
 * false. Every non-Gmail provider namespaces its message id as
 * `<prefix>:…`; Gmail API ids are bare hex (all 16 hex characters in prod,
 * checked 2026-11-12), so the id tells them apart without another lookup.
 */

import { FIREWALL_PUSH_RECENCY_MS } from "./firewall-push.js";

const GMAIL_MESSAGE_ID = /^[0-9a-f]+$/i;

/**
 * True when Gmail had marked this inbox mail IMPORTANT, false for other Gmail
 * mail (spam included: Gmail never rings for it), null when it is not Gmail
 * mail or the id is unknown.
 */
export function gmailImportantAtJudge(
  gmailId: string | undefined,
  labels: readonly string[],
): boolean | null {
  if (!gmailId || !GMAIL_MESSAGE_ID.test(gmailId)) return null;
  return labels.includes("INBOX") && labels.includes("IMPORTANT");
}

/**
 * The snapshot the ledger stores when a row is created, or null when the
 * stored labels can no longer stand for Gmail's verdict at arrival:
 *  - a re-judge: the row is being refreshed, not first written;
 *  - mail judged more than FIREWALL_PUSH_RECENCY_MS after it arrived (the
 *    backfill sweep, up to 14 days late): sync copies Gmail's live labels onto
 *    the stored row, and Gmail adds IMPORTANT after the user replies. Klorn
 *    never rings mail that old either, so both sides of IP24 compare the same
 *    fresh mail.
 */
export function gmailImportantSnapshot(
  email: { gmailId?: string; labels: readonly string[]; receivedAt: Date },
  options: { rejudge: boolean },
  now: Date = new Date(),
): boolean | null {
  if (options.rejudge) return null;
  if (now.getTime() - email.receivedAt.getTime() > FIREWALL_PUSH_RECENCY_MS) return null;
  return gmailImportantAtJudge(email.gmailId, email.labels);
}
