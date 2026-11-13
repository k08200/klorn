/**
 * Why a mailbox poll failed, reduced to the short code stored on
 * LinkedInboxAccount.syncErrorCode. Clients put the code into words in the
 * user's language (Settings -> Accounts); the raw error text, which can come
 * from a server the user chose, never reaches the database or the UI.
 */

import { prisma } from "../db.js";
import { pollFailureKind } from "./imap-poll-failures.js";
import { isImapAuthFailure } from "./providers/imap-session.js";

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

/**
 * RFC 5530 response codes a server attaches to a refused LOGIN that is about the
 * moment, not the password (busy, rate limit, its own bug). imapflow marks every
 * refused LOGIN `authenticationFailed`, so these must not read as "revoked".
 */
const TRANSIENT_LOGIN_REFUSALS = new Set(["UNAVAILABLE", "LIMIT", "INUSE", "SERVERBUG"]);

/** A refused login that is about the credentials: only the user can fix it. */
export function isCredentialRefusal(err: unknown): boolean {
  if (!isImapAuthFailure(err)) return false;
  const code = (err as { serverResponseCode?: unknown } | null)?.serverResponseCode;
  return !(typeof code === "string" && TRANSIENT_LOGIN_REFUSALS.has(code.toUpperCase()));
}

/** The code for a failed IMAP poll (pollFailureKind: "auth", a library code, or "error"). */
export function imapSyncErrorCode(err: unknown): SyncErrorCode {
  if (isImapAuthFailure(err)) return isCredentialRefusal(err) ? "auth" : "throttled";
  const kind = pollFailureKind(err);
  if (UNREACHABLE_KINDS.has(kind)) return "unreachable";
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
    const name = (err as { name?: unknown } | null)?.name;
    console.warn(`[sync-status] could not record ${code} for row ${rowId} (${String(name)})`);
  }
}

/** The fields a successful poll writes alongside lastSyncedAt. */
export function syncSucceededFields(now: Date = new Date()) {
  return { lastSyncedAt: now, syncErrorCode: null, syncErrorAt: null };
}
