/**
 * The undo half of trash and archive for every provider, kept out of
 * email-mutations.ts (IMAP: step B2 of docs/providers/unified-platform-plan.md;
 * Outlook and the account rule: docs/design/mail-cleanup-actions.md, PR1).
 *
 * Which account: undo arrives after the local row was deleted, so the client that
 * did the action names the account (`linkedInboxAccountId`). When it does not (an
 * older client), the account is found from what is known without the row: the
 * move Klorn recorded for an IMAP id (only while IMAP_MOVE_ACTIONS_ENABLED is on),
 * or the mailbox address an Outlook id embeds. A provider-prefixed id whose
 * account cannot be found is refused, never handed to the primary Gmail; only a
 * plain Gmail id with nothing else to go on is the primary, as before.
 *
 * Bringing the row back:
 *   - Gmail re-fetches the same id.
 *   - Outlook keeps an immutable id across folder moves, so the message is fetched
 *     once by that id through Graph and persisted like the delta poll does.
 *   - An IMAP MOVE back into INBOX gives the message a NEW UID, so it returns under
 *     a new id. The provider answers it as `restoredMessageId`; the row is
 *     re-synced under that id here, which is the id the next poll will also use, so
 *     the poll finds the row already there and creates no second one.
 */

import type { EmailUndoActionResponse } from "@klorn/contract";

import { imapMoveActionsEnabled } from "../config.js";
import { prisma } from "../db.js";
import { syncEmailByGmailId } from "../mail/email-sync.js";
import { IMAP_PROVIDERS, type ImapProviderKey } from "../mail/imap-providers.js";
import { findMovedAccountId, type MoveRoleName } from "../mail/providers/imap-moved.js";
import type { MailProviderActions, SimpleMailActionResult } from "../mail/providers/types.js";
import { logDbFailure } from "../report-db-failure.js";

const isImapProviderKey = (key: string): key is ImapProviderKey =>
  Object.hasOwn(IMAP_PROVIDERS, key);

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
    logDbFailure("[EMAIL] could not look up the recorded move for an undo", err, {
      ids: { userId },
    });
    return null;
  }
}

const OUTLOOK_ID_PREFIX = "outlook:";

/** The mailbox address an Outlook id embeds (`outlook:<mailbox>:<graph id>`), or null. */
export function outlookMailboxOf(gmailId: string): string | null {
  if (!gmailId.startsWith(OUTLOOK_ID_PREFIX)) return null;
  const rest = gmailId.slice(OUTLOOK_ID_PREFIX.length);
  const end = rest.indexOf(":");
  if (end <= 0 || end === rest.length - 1) return null;
  return rest.slice(0, end);
}

/** True for an id that names a mailbox other than a Gmail one (Outlook, every IMAP preset). */
function isProviderPrefixedId(gmailId: string): boolean {
  return gmailId.startsWith(OUTLOOK_ID_PREFIX) || looksLikeImapId(gmailId);
}

/** The caller's linked Outlook account for the mailbox an Outlook id names, or null. */
async function findOutlookInbox(userId: string, gmailId: string): Promise<string | null> {
  const mailbox = outlookMailboxOf(gmailId);
  if (!mailbox) return null;
  try {
    const row = await prisma.linkedInboxAccount.findFirst({
      where: { userId, provider: "OUTLOOK", email: mailbox },
      select: { id: true },
    });
    return row?.id ?? null;
  } catch (err) {
    logDbFailure("[EMAIL] could not look up the Outlook account for an undo", err, {
      ids: { userId },
    });
    return null;
  }
}

export type UndoInbox = { linkedInboxAccountId: string | null } | { unknown: true };

/**
 * The account an undo restores in (header comment): the one the client named,
 * else the recorded IMAP move, else the Outlook mailbox in the id. `unknown` for a
 * provider-prefixed id whose account cannot be found.
 */
export async function resolveUndoInbox(
  userId: string,
  gmailId: string,
  named: string | null,
  role: MoveRoleName,
): Promise<UndoInbox> {
  if (named) return { linkedInboxAccountId: named };
  const found =
    (await findParkedInbox(userId, gmailId, role)) ?? (await findOutlookInbox(userId, gmailId));
  if (found) return { linkedInboxAccountId: found };
  return isProviderPrefixedId(gmailId) ? { unknown: true } : { linkedInboxAccountId: null };
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
  if (actions.provider === "OUTLOOK") {
    return completeOutlookUndo(userId, gmailId, linkedInboxAccountId);
  }
  const restoredId = isRestoredSuccess(result) ? result.restoredMessageId : undefined;
  if (!restoredId) {
    const synced = await syncEmailByGmailId(userId, gmailId, linkedInboxAccountId);
    return { payload: { success: true, gmailId, emailId: synced.emailId } };
  }

  const key = actions.provider;
  if (!isImapProviderKey(key) || !linkedInboxAccountId) {
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
    logDbFailure("[EMAIL] re-sync after an IMAP undo failed", err, { ids: { userId } });
    return late;
  }
}

const OUTLOOK_LATE: UndoCompletion = {
  failure:
    "Restored on Outlook, but Klorn could not refresh its copy. It will reappear after the next sync.",
};

/**
 * The Outlook message is back in its inbox under the same immutable id: fetch it
 * once through Graph and persist it. A failure is reported as what it is — the
 * message is restored, only Klorn's copy is late (the next delta delivers it).
 */
async function completeOutlookUndo(
  userId: string,
  gmailId: string,
  linkedInboxAccountId: string | null,
): Promise<UndoCompletion> {
  if (!linkedInboxAccountId) return OUTLOOK_LATE;
  try {
    // Loaded here, like the IMAP chain below: the Outlook ingestion chain (persist,
    // judge) is only needed on this path.
    const { syncOutlookMessageForUser } = await import("../mail/outlook-accounts.js");
    const synced = await syncOutlookMessageForUser(userId, linkedInboxAccountId, gmailId);
    if (!synced) return OUTLOOK_LATE;
    return { payload: { success: true, gmailId, emailId: synced.emailId } };
  } catch (err) {
    logDbFailure("[EMAIL] re-sync after an Outlook undo failed", err, { ids: { userId } });
    return OUTLOOK_LATE;
  }
}
