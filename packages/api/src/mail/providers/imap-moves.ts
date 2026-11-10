/**
 * IMAP implementation of trash, archive and their inverses for NAVER and ICLOUD —
 * step B2 of docs/providers/unified-platform-plan.md.
 *
 *   trash / archive      ->  UID MOVE out of INBOX into the account's flagged
 *                            \Trash / \Archive folder (imap-folders.ts)
 *   untrash / unarchive  ->  UID MOVE back from where it was parked into INBOX
 *
 * Never `\Deleted` + EXPUNGE: that is delete_permanent, on the deterministic floor
 * (docs/doctrine/deterministic-floor.md). A server with no MOVE, or an account with
 * no trustworthy destination, answers `unsupported` for the action.
 *
 * A MOVE assigns the message a NEW UID, and trash/archive remove the local
 * EmailMessage row (as the Gmail path does), so where the message went is recorded
 * in `ImapMovedMessage` (imap-moved.ts) before the row goes. Undo reads it, moves
 * the message back and answers the message's NEW INBOX id as `restoredMessageId`,
 * which the route uses to re-sync the row; the next poll then finds it already
 * there under that id and creates nothing.
 *
 * Result contract (types.ts), same as the flag actions: these never throw.
 *   - `{ success: true }` only when the server confirmed where the message went;
 *   - `{ unsupported }` when this account or server cannot do the action;
 *   - `{ error }` for everything else: bad or foreign id, a mailbox that was
 *     renumbered, a UID that no longer names the message Klorn has, a server that
 *     refused or could not be confirmed, a database failure. Unlike read and star,
 *     the callers of trash and archive used to delete the local row on `{ error }`;
 *     the routes now refuse that fallback for these providers (email-mutations.ts),
 *     so an `{ error }` here always leaves the row and the message where they were.
 *
 * Retrying is safe: if the move was confirmed but the local row could not be
 * removed, the record exists, and the retry finishes the local cleanup instead of
 * failing on a message that is no longer in INBOX.
 */

import { prisma } from "../../db.js";
import type { EnvelopeFacts } from "../imap-envelope.js";
import { formatImapMessageId } from "../imap-message-id.js";
import {
  IMAP_PROVIDERS,
  type ImapProviderConfig,
  type ImapProviderKey,
} from "../imap-providers.js";
import { describeFailure, fail } from "./action-failure.js";
import { databaseFailure, resolveTarget } from "./imap-account.js";
import type { MoveRole } from "./imap-folders.js";
import type { MovedTo, MoveOpResult } from "./imap-move-run.js";
import {
  findMove,
  forgetMove,
  type MoveRecord,
  type MoveRoleName,
  recordMove,
} from "./imap-moved.js";
import { submitMoveOp } from "./imap-session.js";
import type { MailProviderActions, SimpleMailActionResult } from "./types.js";

export type MoveSurface = Pick<MailProviderActions, "trash" | "untrash" | "archive" | "unarchive">;

const ROLE_FOLDER: Readonly<Record<MoveRoleName, MoveRole>> = {
  TRASH: "\\Trash",
  ARCHIVE: "\\Archive",
};

interface Scope {
  userId: string;
  linkedInboxAccountId: string;
}

const isOutcome = (result: MoveOpResult): result is Extract<MoveOpResult, { status: string }> =>
  "status" in result;

/** Run `work`, and answer `{ error }` instead of throwing whatever goes wrong. */
async function neverThrow(
  provider: ImapProviderConfig,
  what: string,
  work: () => Promise<SimpleMailActionResult>,
): Promise<SimpleMailActionResult> {
  try {
    return await work();
  } catch (err) {
    console.warn(`[${provider.logScope}] could not ${what} (${describeFailure(err)})`);
    return fail(`Could not ${what}. Try again shortly.`);
  }
}

/** A database failure that must not decide the caller's result: log and report it, go on. */
function noteDatabaseFailure(
  err: unknown,
  provider: ImapProviderConfig,
  scope: Scope,
  what: string,
): void {
  databaseFailure(err, provider, { userId: scope.userId, rowId: scope.linkedInboxAccountId }, what);
}

// --- out of INBOX (trash, archive) ---------------------------------------------

/** What Klorn knows of the message, from its local row; null when there is none. */
async function expectedFromLocalRow(
  userId: string,
  messageId: string,
): Promise<EnvelopeFacts | null> {
  const row = await prisma.emailMessage.findFirst({
    where: { userId, gmailId: messageId },
    select: { subject: true, receivedAt: true },
  });
  return row ? { messageId: null, subject: row.subject, date: row.receivedAt } : null;
}

async function removeLocalRow(
  provider: ImapProviderConfig,
  scope: Scope,
  messageId: string,
): Promise<SimpleMailActionResult> {
  try {
    await prisma.emailMessage.deleteMany({ where: { userId: scope.userId, gmailId: messageId } });
  } catch (err) {
    noteDatabaseFailure(err, provider, scope, "local delete failed after a confirmed move");
    return fail(
      `The message was moved on ${provider.label}, but its local copy could not be removed. Try again to finish.`,
    );
  }
  return { success: true };
}

function recordFor(
  messageId: string,
  role: MoveRoleName,
  to: MovedTo,
  seen: EnvelopeFacts,
): MoveRecord {
  return {
    sourceId: messageId,
    role,
    folderPath: to.path,
    folderUid: to.uid,
    folderUidValidity: to.uidValidity,
    messageIdHeader: seen.messageId,
    subject: seen.subject,
    sentAt: seen.date,
  };
}

/** The server confirmed the move: record where it went, then remove the local row. */
async function finishMove(
  provider: ImapProviderConfig,
  scope: Scope,
  messageId: string,
  role: MoveRoleName,
  moved: { to: MovedTo; seen: EnvelopeFacts },
): Promise<SimpleMailActionResult> {
  try {
    await recordMove(scope, recordFor(messageId, role, moved.to, moved.seen));
  } catch (err) {
    // The message IS parked. Failing here would leave a listed row for a message
    // that is gone; the cost of the lost record is that undo will say it cannot.
    noteDatabaseFailure(err, provider, scope, "could not record the move");
  }
  return removeLocalRow(provider, scope, messageId);
}

/** A retry for a message that is no longer in INBOX: done already if Klorn recorded moving it this way. */
async function completeIfRecorded(
  provider: ImapProviderConfig,
  scope: Scope,
  messageId: string,
  role: MoveRoleName,
  notDone: string,
): Promise<SimpleMailActionResult> {
  const recorded = await findMove(scope, messageId, role);
  if (!recorded) return fail(notDone);
  return removeLocalRow(provider, scope, messageId);
}

async function moveOut(
  provider: ImapProviderConfig,
  role: MoveRoleName,
  userId: string,
  messageId: string,
  linkedInboxAccountId: string | null | undefined,
): Promise<SimpleMailActionResult> {
  // The primary inbox (null id) is always Google; an IMAP action without its
  // linked row id is the not-connected class.
  if (!linkedInboxAccountId) return fail(`${provider.label} actions need the linked mailbox id.`);
  const scope = { userId, linkedInboxAccountId };
  const target = await resolveTarget(provider, userId, linkedInboxAccountId, messageId);
  if ("error" in target) return target;

  const expected = await expectedFromLocalRow(userId, messageId);
  if (!expected) {
    return completeIfRecorded(
      provider,
      scope,
      messageId,
      role,
      "That message is not in your synced mail.",
    );
  }
  const result = await submitMoveOp(provider, target.session, {
    kind: "to-role",
    uid: target.uid,
    role: ROLE_FOLDER[role],
    expected,
  });
  if (!isOutcome(result)) return result;

  switch (result.status) {
    case "moved":
      return finishMove(provider, scope, messageId, role, result);
    case "missing":
      return completeIfRecorded(
        provider,
        scope,
        messageId,
        role,
        `The message is no longer in your ${provider.label} INBOX.`,
      );
    case "mismatch":
      console.warn(
        `[${provider.logScope}] move refused for row ${scope.linkedInboxAccountId} — the UID no longer names the stored message`,
      );
      return fail(
        `The message on ${provider.label} no longer matches Klorn's copy. Sync and try again.`,
      );
    default:
      return fail(`${provider.label} did not confirm the move.`);
  }
}

// --- back into INBOX (untrash, unarchive) -------------------------------------

async function forgetQuietly(
  provider: ImapProviderConfig,
  scope: Scope,
  messageId: string,
): Promise<void> {
  try {
    await forgetMove(scope, messageId);
  } catch (err) {
    // A stale record is swept after the retention window; it cannot cause a wrong move.
    noteDatabaseFailure(err, provider, scope, "could not drop the move record");
  }
}

async function moveBack(
  provider: ImapProviderConfig,
  role: MoveRoleName,
  userId: string,
  messageId: string,
  linkedInboxAccountId: string | null | undefined,
): Promise<SimpleMailActionResult> {
  if (!linkedInboxAccountId) return fail(`${provider.label} actions need the linked mailbox id.`);
  const scope = { userId, linkedInboxAccountId };
  const target = await resolveTarget(provider, userId, linkedInboxAccountId, messageId);
  if ("error" in target) return target;

  const record = await findMove(scope, messageId, role);
  if (!record) {
    return fail("Klorn has no record of moving this message, so it cannot restore it.");
  }
  const result = await submitMoveOp(provider, target.session, {
    kind: "restore",
    uid: record.folderUid,
    from: { path: record.folderPath, uidValidity: record.folderUidValidity },
    expected: { messageId: record.messageIdHeader, subject: record.subject, date: record.sentAt },
  });
  if (!isOutcome(result)) return result;

  switch (result.status) {
    case "moved":
      await forgetQuietly(provider, scope, messageId);
      return {
        success: true,
        restoredMessageId: formatImapMessageId(
          provider.idPrefix,
          target.session.email,
          result.to.uid,
        ),
      };
    case "missing":
    case "mismatch":
      // The parked message is gone (the folder was emptied) or its UID names
      // something else: this record can never restore anything.
      await forgetQuietly(provider, scope, messageId);
      return fail(`The message is no longer where Klorn moved it on ${provider.label}.`);
    default:
      return fail(`${provider.label} did not confirm the move.`);
  }
}

export function imapMoveActions(providerKey: ImapProviderKey): MoveSurface {
  const provider = IMAP_PROVIDERS[providerKey];
  return {
    trash: (userId, messageId, linkedInboxAccountId) =>
      neverThrow(provider, "move the message to Trash", () =>
        moveOut(provider, "TRASH", userId, messageId, linkedInboxAccountId),
      ),
    archive: (userId, messageId, linkedInboxAccountId) =>
      neverThrow(provider, "archive the message", () =>
        moveOut(provider, "ARCHIVE", userId, messageId, linkedInboxAccountId),
      ),
    untrash: (userId, messageId, linkedInboxAccountId) =>
      neverThrow(provider, "restore the message from Trash", () =>
        moveBack(provider, "TRASH", userId, messageId, linkedInboxAccountId),
      ),
    unarchive: (userId, messageId, linkedInboxAccountId) =>
      neverThrow(provider, "restore the message from Archive", () =>
        moveBack(provider, "ARCHIVE", userId, messageId, linkedInboxAccountId),
      ),
  };
}
