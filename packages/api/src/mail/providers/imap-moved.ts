/**
 * The record of where Klorn parked a message when it trashed or archived it
 * (table `ImapMovedMessage`, step B2 of docs/providers/unified-platform-plan.md).
 *
 * An IMAP MOVE gives the message a NEW UID in the destination, and trash/archive
 * remove the local EmailMessage row, so "where did it go" cannot live on that row.
 * One record per parked message, keyed by the INBOX id it had. Undo reads it, moves
 * the message back and deletes it. Every function is scoped by user AND account and
 * throws on a database failure; the caller decides what that means for its result.
 */

import { prisma } from "../../db.js";

export type MoveRoleName = "TRASH" | "ARCHIVE";

/** How long a record outlives its move: Gmail's own Trash retention, which is what users expect of trash. */
export const MOVED_MESSAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface MoveRecord {
  /** The EmailMessage.gmailId the message had in INBOX. */
  sourceId: string;
  role: MoveRoleName;
  folderPath: string;
  /** The UID in `folderPath`. A number: it is an unsigned 32-bit value, well inside 2^53. */
  folderUid: number;
  folderUidValidity: string;
  messageIdHeader: string | null;
  subject: string;
  sentAt: Date | null;
}

export interface MoveScope {
  userId: string;
  linkedInboxAccountId: string;
}

/** Record a move (replacing an older record of the same message), then sweep expired ones. */
export async function recordMove(scope: MoveScope, record: MoveRecord): Promise<void> {
  const data = {
    role: record.role,
    folderPath: record.folderPath,
    folderUid: BigInt(record.folderUid),
    folderUidValidity: record.folderUidValidity,
    messageIdHeader: record.messageIdHeader,
    subject: record.subject,
    sentAt: record.sentAt,
    createdAt: new Date(),
  };
  await prisma.imapMovedMessage.upsert({
    where: {
      linkedInboxAccountId_sourceId: {
        linkedInboxAccountId: scope.linkedInboxAccountId,
        sourceId: record.sourceId,
      },
    },
    create: {
      userId: scope.userId,
      linkedInboxAccountId: scope.linkedInboxAccountId,
      sourceId: record.sourceId,
      ...data,
    },
    update: data,
  });
  await prisma.imapMovedMessage.deleteMany({
    where: {
      linkedInboxAccountId: scope.linkedInboxAccountId,
      createdAt: { lt: new Date(Date.now() - MOVED_MESSAGE_RETENTION_MS) },
    },
  });
}

/** The record of a message parked by `role`, or null. */
export async function findMove(
  scope: MoveScope,
  sourceId: string,
  role: MoveRoleName,
): Promise<MoveRecord | null> {
  const row = await prisma.imapMovedMessage.findFirst({
    where: {
      userId: scope.userId,
      linkedInboxAccountId: scope.linkedInboxAccountId,
      sourceId,
      role,
    },
  });
  if (!row) return null;
  return {
    sourceId: row.sourceId,
    role: row.role,
    folderPath: row.folderPath,
    folderUid: Number(row.folderUid),
    folderUidValidity: row.folderUidValidity,
    messageIdHeader: row.messageIdHeader,
    subject: row.subject,
    sentAt: row.sentAt,
  };
}

/** Drop the record of a message (after undo, or when it can never be restored). */
export async function forgetMove(scope: MoveScope, sourceId: string): Promise<void> {
  await prisma.imapMovedMessage.deleteMany({
    where: { userId: scope.userId, linkedInboxAccountId: scope.linkedInboxAccountId, sourceId },
  });
}

/**
 * The linked account a parked message belongs to. Undo arrives after the local row
 * is gone and web clients do not send the account id, so the record is how the
 * route finds the mailbox. Scoped to the user, so it never names another's account.
 */
export async function findMovedAccountId(
  userId: string,
  sourceId: string,
  role: MoveRoleName,
): Promise<string | null> {
  const row = await prisma.imapMovedMessage.findFirst({
    where: { userId, sourceId, role },
    select: { linkedInboxAccountId: true },
  });
  return row?.linkedInboxAccountId ?? null;
}

/**
 * How far back the poller looks for a move it may have raced. A poll reads its
 * window from the server, then persists each message; a message Klorn moved out in
 * between is written back as a fresh row for a message that is no longer in INBOX.
 * Only a recent record can be that race, and an old one must not hide a message:
 * after a renumbering a UID can name a new message.
 */
export const MOVE_RACE_WINDOW_MS = 10 * 60 * 1000;

/** The INBOX ids Klorn moved out within MOVE_RACE_WINDOW_MS, for one account. */
export async function recentlyMovedSourceIds(scope: MoveScope): Promise<string[]> {
  const rows = await prisma.imapMovedMessage.findMany({
    where: {
      userId: scope.userId,
      linkedInboxAccountId: scope.linkedInboxAccountId,
      createdAt: { gte: new Date(Date.now() - MOVE_RACE_WINDOW_MS) },
    },
    select: { sourceId: true },
  });
  return rows.map((row) => row.sourceId);
}

/**
 * Drop the records made within MOVE_RACE_WINDOW_MS for one account. After a
 * UIDVALIDITY reset the INBOX ids in them can name NEW messages, and the poller's
 * race cleanup (`recentlyMovedSourceIds`) would delete those. Older records point at
 * other folders under their own UIDVALIDITY and stay.
 */
export async function forgetRecentMoves(scope: MoveScope): Promise<void> {
  await prisma.imapMovedMessage.deleteMany({
    where: {
      userId: scope.userId,
      linkedInboxAccountId: scope.linkedInboxAccountId,
      createdAt: { gte: new Date(Date.now() - MOVE_RACE_WINDOW_MS) },
    },
  });
}
