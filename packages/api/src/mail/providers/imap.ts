/**
 * IMAP implementation of MailProviderActions for NAVER and ICLOUD — step B1 of
 * docs/providers/unified-platform-plan.md. Covers exactly three actions, all
 * done with IMAP flags on INBOX and addressed by UID:
 *
 *   markAsRead / toggleRead  ->  \Seen
 *   toggleStar               ->  \Flagged
 *
 * Every other action (send, drafts, trash, archive and their inverses) is
 * spread in from `unsupportedMailActions` and answers `{ unsupported: true }`
 * (501 at the routes) exactly as before. Send is imap-send.ts (step B3);
 * archive, trash and their inverses are imap-moves.ts (step B2), which dispatch.ts
 * composes over this set behind their own flag.
 *
 * This file validates and resolves; the connection work is in imap-session.ts,
 * which coalesces concurrent callers into one login per account, caps
 * concurrent sessions, and pauses an account after a rejected login.
 *
 * Result contract (types.ts):
 *   - `{ success: true }` ONLY when the server confirmed the flag by reading it
 *     back (imap-flags.ts).
 *   - `{ error }` for everything else the provider tried and failed: bad or
 *     foreign id, unusable account, auth rejection, transport failure, message
 *     gone from INBOX, flag not applied, a database failure. These actions
 *     never throw. Read and star are safe to fail softly because every caller
 *     writes the local row itself regardless of the result. That is NOT true of
 *     trash/archive, whose callers used to delete locally on `{ error }`: the
 *     routes now refuse that fallback for IMAP providers (step B2,
 *     error-semantics.ts), and imap-moves.ts answers `{ error }` for every failure.
 *   - Never `{ unsupported }` from these three actions.
 *
 * Auth failures mirror the poller (imap-accounts.ts): logged, and NOT flagged
 * `needsReconnect`. The IMAP poller does not flag either; Phase 0b deferred
 * flagging and the Naver/iCloud reconnect copy as one change
 * (multi-provider-plan.md), so this step does not half-implement it.
 *
 * UIDVALIDITY (step B2): before a UID is touched, the live INBOX value must equal
 * the one the poller stored (imap-uidvalidity.ts). A mismatch, or no stored value,
 * answers `{ error }` and sends nothing; the session layer does the comparison.
 *
 * Local state: after a confirmed change the EmailMessage row is updated scoped
 * by userId and message id, exactly like the Gmail path. The next poll reads
 * the same flags from the server, so it agrees with the mirror.
 */

import { prisma } from "../../db.js";
import {
  IMAP_PROVIDERS,
  type ImapProviderConfig,
  type ImapProviderKey,
} from "../imap-providers.js";
import { fail } from "./action-failure.js";
import { databaseFailure, resolveTarget } from "./imap-account.js";
import { type FlagChange, readChange, type ServerOutcome, starChange } from "./imap-flags.js";
import { submitFlagOp } from "./imap-session.js";
import type { MailActionFailure, MailProviderActions, SimpleMailActionResult } from "./types.js";
import { unsupportedMailActions } from "./unsupported.js";

function outcomeError(
  outcome: Exclude<ServerOutcome, "confirmed">,
  label: string,
): MailActionFailure {
  return fail(
    outcome === "missing"
      ? `The message is no longer in your ${label} INBOX.`
      : `${label} did not confirm the change.`,
  );
}

/** Mirror the Gmail path: local state follows only a confirmed server change. */
async function mirrorLocally(
  provider: ImapProviderConfig,
  ids: { userId: string; rowId: string },
  messageId: string,
  change: FlagChange,
): Promise<SimpleMailActionResult> {
  const { userId } = ids;
  try {
    await prisma.emailMessage.updateMany({
      where: { userId, gmailId: messageId },
      data: change.local,
    });
  } catch (err) {
    databaseFailure(err, provider, ids, "local update failed after a confirmed change");
    return fail(
      `Changed on ${provider.label}, but the local copy could not be updated. The next sync will catch up.`,
    );
  }
  return { success: true };
}

async function changeFlag(
  provider: ImapProviderConfig,
  userId: string,
  messageId: string,
  linkedInboxAccountId: string | null | undefined,
  change: FlagChange,
): Promise<SimpleMailActionResult> {
  // The primary inbox (null id) is always Google; an IMAP action without its
  // linked row id is the not-connected class.
  if (!linkedInboxAccountId) {
    return fail(`${provider.label} actions need the linked mailbox id.`);
  }
  const target = await resolveTarget(provider, userId, linkedInboxAccountId, messageId);
  if ("error" in target) return target;

  const result = await submitFlagOp(provider, target.session, { uid: target.uid, change });
  if (typeof result !== "string") return result;
  if (result !== "confirmed") return outcomeError(result, provider.label);
  return mirrorLocally(provider, { userId, rowId: target.session.rowId }, messageId, change);
}

export function imapMailActions(providerKey: ImapProviderKey): MailProviderActions {
  const provider = IMAP_PROVIDERS[providerKey];
  return {
    ...unsupportedMailActions(providerKey),
    markAsRead: (userId, messageId, linkedInboxAccountId) =>
      changeFlag(provider, userId, messageId, linkedInboxAccountId, readChange(true)),
    toggleRead: (userId, messageId, isRead, linkedInboxAccountId) =>
      changeFlag(provider, userId, messageId, linkedInboxAccountId, readChange(isRead)),
    toggleStar: (userId, messageId, starred, linkedInboxAccountId) =>
      changeFlag(provider, userId, messageId, linkedInboxAccountId, starChange(starred)),
  };
}
