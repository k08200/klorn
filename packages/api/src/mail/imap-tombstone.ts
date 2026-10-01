/**
 * Tombstones: what an IMAP UIDVALIDITY repair leaves behind (step B2b of
 * docs/providers/unified-platform-plan.md).
 *
 * A row's id is `<idPrefix>:<email>:<uid>`, and a UID names a message only under the
 * mailbox's UIDVALIDITY. When the server renumbers the mailbox, every row of the old
 * numbering is stale: its id now names a different message or none. The repair does
 * not delete those rows (they carry summaries, stars, reply state, attachments,
 * candidate intakes and commitments); it RE-KEYS them, appending `#uv<old value>` to
 * `EmailMessage.gmailId`. Three things follow from that one string:
 *   - the strict id parse (`parseImapMessageId`) refuses a suffixed id, so no IMAP
 *     action can address a tombstone, whatever screen still holds the id;
 *   - a NEW message that reuses the old UID no longer collides with the stale row on
 *     the `(userId, gmailId)` unique key, so it gets a row of its own;
 *   - the row id is untouched, so everything keyed by it survives.
 *
 * Tombstones stay visible as history: no list or count filters them out (decided
 * 2026-09-30, scope of B2b). After a repair the next poll ingests the INBOX window
 * under the new numbering, so a recent message can show twice, once as the tombstone
 * and once as the new row. That is the accepted limit.
 *
 * Only the Prisma type is imported here, so a test helper can load this module
 * without loading the database module.
 */

import { Prisma } from "@prisma/client";

/** Appended to `gmailId`, followed by the UIDVALIDITY the row was written under. */
export const TOMBSTONE_MARKER = "#uv";

/** `#uv<old value>`: the suffix a repair appends to every stale id. */
export function tombstoneSuffix(oldValidity: string): string {
  return `${TOMBSTONE_MARKER}${oldValidity}`;
}

/** True when `gmailId` is a tombstone. Nothing but the repair writes the marker. */
export function isTombstonedId(gmailId: string): boolean {
  return gmailId.includes(TOMBSTONE_MARKER);
}

export interface RekeyArgs {
  userId: string;
  /** `<idPrefix>:<email>:`, exactly as `formatImapMessageId` writes it. */
  prefix: string;
  /** `tombstoneSuffix(old value)`. */
  suffix: string;
  now: Date;
}

/**
 * The one statement that re-keys a mailbox's rows. Raw because Prisma cannot set a
 * column to an expression, and one statement is one round trip however many rows the
 * mailbox holds (a row-by-row update would outlast the transaction timeout).
 *
 *   - `starts_with`, not LIKE: an address may contain `_`, which LIKE would treat as
 *     a wildcard and so match another of the user's mailboxes;
 *   - `strpos(...) = 0` skips a row that already carries the marker (a tombstone of
 *     an earlier repair), so suffixes never stack;
 *   - every row of the account is old-numbering: the poll ingests nothing while the
 *     mailbox is held (imap-poll-guards.ts), so no createdAt split is needed;
 *   - every value is a bound parameter; nothing is concatenated into the text.
 *
 * The test helper (helpers/fake-db.ts) emulates this exact text and parameter order
 * (suffix, now, userId, prefix, marker); a changed statement stops matching there and
 * fails the tests instead of being emulated wrongly.
 */
export function tombstoneRekeyStatement(args: RekeyArgs): Prisma.Sql {
  return Prisma.sql`
    UPDATE "EmailMessage"
    SET "gmailId" = "gmailId" || ${args.suffix}::text, "updatedAt" = ${args.now}
    WHERE "userId" = ${args.userId}
      AND starts_with("gmailId", ${args.prefix}::text)
      AND strpos("gmailId", ${TOMBSTONE_MARKER}::text) = 0`;
}
