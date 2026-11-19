/**
 * Why a mailbox poll failed, reduced to the short code stored on
 * LinkedInboxAccount.syncErrorCode. Clients put the code into words in the
 * user's language (Settings -> Accounts); the raw error text, which can come
 * from a server the user chose, never reaches the database or the UI.
 */

import { prisma } from "../db.js";
import { logDbFailure } from "../report-db-failure.js";
import { pollFailureKind } from "./imap-poll-failures.js";
import { IMAP_THROTTLED_CODE } from "./imap-throttled.js";
import { isImapAuthFailure, isImapCredentialRefusal } from "./providers/imap-session.js";

export type SyncErrorCode = "auth" | "unreachable" | "throttled" | "error";

export const SYNC_ERROR_CODES: readonly SyncErrorCode[] = [
  "auth",
  "unreachable",
  "throttled",
  "error",
];

/** Socket and DNS failures, imapflow's connection codes, and the host-pin refusals. */
const UNREACHABLE_KINDS = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "NoConnection",
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
  "UPGRADE_TIMEOUT",
  // PinnedAddressError (generic IMAP): the host does not resolve, or resolves
  // to an address Klorn refuses to connect to.
  "unresolvable",
  "blocked-address",
]);

/** A throttled command (Microsoft 365), at login or later: not a refusal, not unreachable. */
const THROTTLED_KINDS = new Set([IMAP_THROTTLED_CODE]);

/**
 * A refused login that is about the credentials: only the user can fix it. The
 * actions answer with the same test (providers/imap-session.ts), so a busy server
 * reads the same on both paths.
 */
export function isCredentialRefusal(err: unknown): boolean {
  return isImapCredentialRefusal(err);
}

/** The code for a failed IMAP poll (pollFailureKind: "auth", a library code, or "error"). */
export function imapSyncErrorCode(err: unknown): SyncErrorCode {
  if (isImapAuthFailure(err)) return isCredentialRefusal(err) ? "auth" : "throttled";
  const kind = pollFailureKind(err);
  if (UNREACHABLE_KINDS.has(kind)) return "unreachable";
  if (THROTTLED_KINDS.has(kind)) return "throttled";
  return "error";
}

/**
 * Record a failed poll on the user's own row. Written only when the code
 * changes, so a mailbox failing the same way every five minutes does not
 * rewrite its row every tick. Best-effort: never throws.
 */
export async function recordSyncError(
  userId: string,
  rowId: string,
  code: SyncErrorCode,
  // The stored IMAP password the poll began with: a poll that fails after the user
  // reconnected must not pin its failure on the new password.
  imapPasswordCipher?: string,
): Promise<void> {
  try {
    await prisma.linkedInboxAccount.updateMany({
      where: {
        id: rowId,
        userId,
        ...(imapPasswordCipher !== undefined ? { imapPasswordCipher } : {}),
        OR: [{ syncErrorCode: null }, { syncErrorCode: { not: code } }],
      },
      data: { syncErrorCode: code, syncErrorAt: new Date() },
    });
  } catch (err) {
    logDbFailure("[sync-status] could not record the sync error code", err, {
      ids: { userId, rowId, code },
    });
  }
}

/** The fields a successful poll writes alongside lastSyncedAt. */
export function syncSucceededFields(now: Date = new Date()) {
  return { lastSyncedAt: now, syncErrorCode: null, syncErrorAt: null };
}
