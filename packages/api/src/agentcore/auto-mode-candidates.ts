/**
 * Candidate selection for the auto-mode sweep (ontology v2 unattended replies).
 *
 * Only mail that can actually leave today is eligible: the primary Google
 * account, or a linked GOOGLE inbox. A linked NAVER / ICLOUD / OUTLOOK / IMAP
 * inbox is excluded until a separate founder decision enables unattended
 * replies from it (docs/providers/unified-platform-plan.md, B3 "Before the
 * flip") — its send either answers `{ unsupported }` or would leave from an
 * account the sender never wrote to.
 *
 * Items whose mail already has an unattended-reply ledger row (auto-mode or
 * rule) are excluded too: a send that failed leaves the item OPEN with its
 * ledger kept, and such an item must not keep taking one of the `take` slots
 * until the lookback expires.
 *
 * AttentionItem -> EmailMessage -> LinkedInboxAccount has no Prisma relations
 * (sourceId and EmailMessage.linkedInboxAccountId are plain tags), so the
 * filters are applied after a bounded scan. `take` is applied AFTER exclusion:
 * otherwise five newer NAVER (or ledger-failed) items would starve every
 * sendable item behind them on every tick.
 */

import { prisma } from "../db.js";
import { findReingestedHistory } from "../mail/imap-history.js";
import type { AutoModeCandidate } from "./auto-mode-sweep.js";
import { replyLedgerKeys } from "./auto-reply-ledger-keys.js";

/// Upper bound on items scanned per tick before exclusion. Items are already
/// limited to the sweep's 6h lookback, so this is a safety cap, not a window.
export const AUTO_MODE_CANDIDATE_SCAN_MAX = 50;

export interface LinkedInboxSendState {
  provider: string;
  needsReconnect: boolean;
}

/**
 * May Klorn send an unattended reply from the mailbox this email arrived on?
 *
 * `linkedInboxAccountId` is EmailMessage.linkedInboxAccountId: null = the
 * primary Google account. `linkedInboxes` is THIS USER's linked accounts by id.
 * A linked account qualifies only if it is GOOGLE and not flagged
 * needsReconnect (a revoked token can only fail the send). Fail closed: a tag
 * that is not in the map — another user's account, or an inbox unlinked since
 * (the mail is kept, the tag goes stale and the send would fall back to the
 * primary address) — is not sendable.
 */
export function canAutoSendFromMailbox(
  linkedInboxAccountId: string | null,
  linkedInboxes: ReadonlyMap<string, LinkedInboxSendState>,
): boolean {
  if (linkedInboxAccountId === null) return true;
  const inbox = linkedInboxes.get(linkedInboxAccountId);
  return inbox !== undefined && inbox.provider === "GOOGLE" && !inbox.needsReconnect;
}

export async function findAutoModeCandidates(
  userId: string,
  since: Date,
  take: number,
): Promise<AutoModeCandidate[]> {
  const items = await prisma.attentionItem.findMany({
    where: {
      userId,
      source: "EMAIL",
      status: "OPEN",
      autoEligible: true,
      tier: { in: ["QUEUE", "MEETING"] },
      isManualOverride: false,
      createdAt: { gte: since },
    },
    orderBy: { createdAt: "desc" },
    take: AUTO_MODE_CANDIDATE_SCAN_MAX,
    select: { id: true, sourceId: true },
  });
  if (items.length === 0) return [];

  const emails = await prisma.emailMessage.findMany({
    where: { userId, id: { in: items.map((item) => item.sourceId) } },
    select: { id: true, gmailId: true, linkedInboxAccountId: true, receivedAt: true },
  });
  if (emails.length === 0) return [];
  const emailById = new Map(emails.map((row) => [row.id, row]));
  // Step B2b: mail an IMAP UIDVALIDITY repair re-ingested, and the re-keyed tombstones,
  // never get an unattended reply. No IMAP account is sendable today
  // (canAutoSendFromMailbox); this holds on its own for the day one is.
  const history = await findReingestedHistory(userId, emails);

  // Mail a previous tick (or the rule sweep) already claimed, whatever became
  // of that send. The ledger keys are per gmailId.
  const ledgers = await prisma.notification.findMany({
    where: { userId, dedupeKey: { in: emails.flatMap((row) => replyLedgerKeys(row.gmailId)) } },
    select: { dedupeKey: true },
  });
  const claimedKeys = new Set(ledgers.map((row) => row.dedupeKey));

  // Skip the inbox lookup in the common primary-only case.
  const needsInboxLookup = emails.some((row) => row.linkedInboxAccountId !== null);
  const linkedInboxes: ReadonlyMap<string, LinkedInboxSendState> = needsInboxLookup
    ? new Map(
        (
          await prisma.linkedInboxAccount.findMany({
            where: { userId },
            select: { id: true, provider: true, needsReconnect: true },
          })
        ).map((inbox) => [inbox.id, inbox]),
      )
    : new Map();

  return items
    .filter((item) => {
      const row = emailById.get(item.sourceId);
      // No row = the email is gone; the sweep would skip it anyway.
      if (!row) return false;
      if (history.has(row.id)) return false;
      if (replyLedgerKeys(row.gmailId).some((key) => claimedKeys.has(key))) return false;
      return canAutoSendFromMailbox(row.linkedInboxAccountId, linkedInboxes);
    })
    .slice(0, take);
}
