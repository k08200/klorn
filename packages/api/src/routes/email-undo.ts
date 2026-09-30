/**
 * The undo half of trash and archive for IMAP mailboxes (step B2 of
 * docs/providers/unified-platform-plan.md), kept out of email-mutations.ts.
 *
 * Two things differ from Gmail:
 *   - Undo arrives after the local row was deleted, and web clients do not send the
 *     linked account id, so for an IMAP message id the mailbox is found from the
 *     move Klorn recorded. Only while IMAP_MOVE_ACTIONS_ENABLED is on; with it off
 *     nothing here runs and the routes behave as before.
 *   - A MOVE back into INBOX gives the message a NEW UID, so it returns under a new
 *     id. The provider answers it as `restoredMessageId`; the row is re-synced
 *     under that id here, which is the id the next poll will also use, so the poll
 *     finds the row already there and creates no second one.
 */

import type { EmailUndoActionResponse } from "@klorn/contract";

import { imapMoveActionsEnabled } from "../config.js";
import { syncEmailByGmailId } from "../mail/email-sync.js";
import { IMAP_PROVIDERS } from "../mail/imap-providers.js";
import { describeFailure } from "../mail/providers/action-failure.js";
import { findMovedAccountId, type MoveRoleName } from "../mail/providers/imap-moved.js";
import type { MailProviderActions, SimpleMailActionResult } from "../mail/providers/types.js";

const looksLikeImapId = (gmailId: string): boolean =>
  Object.values(IMAP_PROVIDERS).some((provider) => gmailId.startsWith(`${provider.idPrefix}:`));

/**
 * The linked account a parked IMAP message belongs to, from the recorded move, or
 * null (flag off, not an IMAP id, nothing recorded, or the lookup failed).
 */
export async function findParkedInbox(
  userId: string,
  gmailId: string,
  role: MoveRoleName,
): Promise<string | null> {
  if (!imapMoveActionsEnabled() || !looksLikeImapId(gmailId)) return null;
  try {
    return await findMovedAccountId(userId, gmailId, role);
  } catch (err) {
    console.warn(
      `[EMAIL] could not look up the recorded move for an undo (${describeFailure(err)})`,
    );
    return null;
  }
}

export type UndoCompletion = { payload: EmailUndoActionResponse } | { failure: string };

function isRestoredSuccess(
  result: SimpleMailActionResult,
): result is { success: true; restoredMessageId?: string } {
  return "success" in result;
}

/**
 * After a successful restore: bring the local row back. Gmail re-fetches the same
 * id (and throws on failure, which the route answers as before); an IMAP message
 * is re-synced under its new id, and a failure there is reported as what it is: the
 * message is back in the mailbox, only Klorn's copy is late.
 */
export async function completeUndo(
  userId: string,
  actions: MailProviderActions,
  gmailId: string,
  linkedInboxAccountId: string | null,
  result: SimpleMailActionResult,
): Promise<UndoCompletion> {
  const restoredId = isRestoredSuccess(result) ? result.restoredMessageId : undefined;
  if (!restoredId) {
    const synced = await syncEmailByGmailId(userId, gmailId, linkedInboxAccountId);
    return { payload: { success: true, gmailId, emailId: synced.emailId } };
  }

  const key = actions.provider;
  if ((key !== "NAVER" && key !== "ICLOUD") || !linkedInboxAccountId) {
    return { failure: "Could not refresh the restored message." };
  }
  const provider = IMAP_PROVIDERS[key];
  const late = {
    failure: `Restored on ${provider.label}, but Klorn could not refresh its copy. It will reappear after the next sync.`,
  };
  try {
    // Loaded here, not at the top: the IMAP ingestion chain (persist, judge) is only
    // needed on this path, and the routes that import this module must not load it.
    const { syncImapMessageForUser } = await import("../mail/imap-accounts.js");
    const synced = await syncImapMessageForUser(userId, provider, linkedInboxAccountId, restoredId);
    if (!synced) return late;
    return { payload: { success: true, gmailId: restoredId, emailId: synced.emailId } };
  } catch (err) {
    console.warn(`[EMAIL] re-sync after an IMAP undo failed (${describeFailure(err)})`);
    return late;
  }
}
