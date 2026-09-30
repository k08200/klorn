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
 * AttentionItem -> EmailMessage -> LinkedInboxAccount has no Prisma relations
 * (sourceId and EmailMessage.linkedInboxAccountId are plain tags), so the
 * filter is applied after a bounded scan. `take` is applied AFTER exclusion:
 * otherwise five newer NAVER items would starve every sendable item behind
 * them on every tick.
 */

import { prisma } from "../db.js";
import type { AutoModeCandidate } from "./auto-mode-sweep.js";

/// Upper bound on items scanned per tick before exclusion. Items are already
/// limited to the sweep's 6h lookback, so this is a safety cap, not a window.
export const AUTO_MODE_CANDIDATE_SCAN_MAX = 50;

/**
 * May Klorn send an unattended reply from the mailbox this email arrived on?
 *
 * `linkedInboxAccountId` is EmailMessage.linkedInboxAccountId: null = the
 * primary Google account. `googleLinkedInboxIds` is the user's linked accounts
 * whose provider is GOOGLE. Fail closed: a tag that is not in that set —
 * a non-Google provider, another user's account, or an inbox unlinked since
 * (the mail is kept, the tag goes stale and the send would fall back to the
 * primary address) — is not sendable.
 */
export function canAutoSendFromMailbox(
  linkedInboxAccountId: string | null,
  googleLinkedInboxIds: ReadonlySet<string>,
): boolean {
  return linkedInboxAccountId === null || googleLinkedInboxIds.has(linkedInboxAccountId);
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
    select: { id: true, linkedInboxAccountId: true },
  });
  const accountByEmailId = new Map(emails.map((row) => [row.id, row.linkedInboxAccountId]));

  // Skip the inbox lookup in the common primary-only case.
  const needsInboxLookup = emails.some((row) => row.linkedInboxAccountId !== null);
  const googleLinkedInboxIds: ReadonlySet<string> = needsInboxLookup
    ? new Set(
        (
          await prisma.linkedInboxAccount.findMany({
            where: { userId, provider: "GOOGLE" },
            select: { id: true },
          })
        ).map((inbox) => inbox.id),
      )
    : new Set();

  return items
    .filter((item) => {
      const account = accountByEmailId.get(item.sourceId);
      // undefined = the email row is gone; the sweep would skip it anyway.
      return account !== undefined && canAutoSendFromMailbox(account, googleLinkedInboxIds);
    })
    .slice(0, take);
}
