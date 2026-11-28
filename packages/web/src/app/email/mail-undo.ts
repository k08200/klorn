/**
 * The undo of a trash or archive, shared by the legacy list, Mail v2 and the
 * reader (docs/design/mail-cleanup-actions.md, PR1).
 *
 * The undo runs after the mail's row is gone, so the server cannot look up its
 * account: the client names it. Without that, a mail of a linked Gmail or Outlook
 * account was restored against the primary inbox and the undo failed. Primary
 * mail sends no account, exactly as before.
 */

export type UndoableMailAction = "archive" | "delete";

export interface UndoTarget {
  action: UndoableMailAction;
  gmailId: string;
  /** null = the primary account. */
  linkedInboxAccountId: string | null;
}

export interface UndoRequest {
  path: string;
  body: { gmailId: string; linkedInboxAccountId?: string };
}

export function undoRequest(target: UndoTarget): UndoRequest {
  return {
    path: `/api/email/${encodeURIComponent(target.gmailId)}/${target.action}/undo`,
    body: target.linkedInboxAccountId
      ? { gmailId: target.gmailId, linkedInboxAccountId: target.linkedInboxAccountId }
      : { gmailId: target.gmailId },
  };
}

/** The reader → list hand-off's URL parameter for the account (beside undoGmailId). */
export const UNDO_ACCOUNT_PARAM = "undoAccount";

/** Add the account to an undo hand-off. Primary mail adds nothing. */
export function writeUndoAccount(
  params: URLSearchParams,
  linkedInboxAccountId: string | null | undefined,
): void {
  if (linkedInboxAccountId) params.set(UNDO_ACCOUNT_PARAM, linkedInboxAccountId);
}

/** The account an undo hand-off names; null (the primary) when it names none. */
export function readUndoAccount(
  params: Pick<URLSearchParams, "get"> | null | undefined,
): string | null {
  return params?.get(UNDO_ACCOUNT_PARAM)?.trim() || null;
}

/**
 * Split a bulk action's rows by the server's `failed` list: the rows that left
 * (and keep their undo) and the rows that go back to the list. Order is kept.
 */
export function splitBulkOutcome<T extends { id: string }>(
  rows: readonly T[],
  failed: ReadonlyArray<{ id: string }>,
): { succeeded: T[]; failed: T[] } {
  const failedIds = new Set(failed.map((item) => item.id));
  return {
    succeeded: rows.filter((row) => !failedIds.has(row.id)),
    failed: rows.filter((row) => failedIds.has(row.id)),
  };
}
