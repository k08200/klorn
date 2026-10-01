/**
 * Tombstones: what an IMAP UIDVALIDITY repair leaves behind (step B2b of
 * docs/providers/unified-platform-plan.md).
 *
 * A row's id is `<idPrefix>:<email>:<uid>`, and a UID names a message only under the
 * mailbox's UIDVALIDITY. When the server renumbers the mailbox, every row of the old
 * numbering is stale: its id now names a different message or none. The repair does
 * not delete those rows (they carry summaries, stars, reply state, attachments,
 * candidate intakes and commitments); it RE-KEYS them, appending
 * `#uv<old value>.<repair epoch ms>` to `EmailMessage.gmailId`. The repair time makes
 * every repair's suffix unique: a server that goes A -> B -> A -> B would otherwise
 * re-key a row of the second A numbering onto the tombstone the first repair made,
 * and every later repair would roll back on the unique key. Three things follow from
 * that one string:
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

/** Starts the suffix; the UIDVALIDITY the row was written under and the repair time follow. */
export const TOMBSTONE_MARKER = "#uv";

/**
 * A tombstone suffix, anchored at the END of the id. Anchored on purpose: an address
 * may itself contain `#uv` (`a#uv1.2@example.com` is a valid address), and an
 * unanchored test would take such a mailbox's live rows for tombstones. The same
 * pattern is bound as a parameter of the re-key's `!~` (POSIX regex in Postgres; this
 * pattern means the same there and in JavaScript).
 */
export const TOMBSTONE_PATTERN = "#uv[0-9]+\\.[0-9]+$";
const TOMBSTONE_RE = new RegExp(TOMBSTONE_PATTERN);

/** `#uv<old value>.<repair epoch ms>`: the suffix one repair appends to every stale id. */
export function tombstoneSuffix(oldValidity: string, repairedAt: Date): string {
  return `${TOMBSTONE_MARKER}${oldValidity}.${repairedAt.getTime()}`;
}

/** True when `gmailId` ends in a tombstone suffix. Nothing but the repair writes one. */
export function isTombstonedId(gmailId: string): boolean {
  return TOMBSTONE_RE.test(gmailId);
}

export interface RekeyArgs {
  userId: string;
  /** `<idPrefix>:<email>:`, exactly as `formatImapMessageId` writes it. */
  prefix: string;
  /** `tombstoneSuffix(old value, repair time)`. */
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
 *   - `!~ TOMBSTONE_PATTERN` skips a row that already ends in a suffix (a tombstone of
 *     an earlier repair), so suffixes never stack, while a live row of an address that
 *     contains `#uv` is still re-keyed;
 *   - every row of the account is old-numbering: the poll ingests nothing while the
 *     mailbox is held (imap-poll-guards.ts), so no createdAt split is needed;
 *   - every value is a bound parameter; nothing is concatenated into the text.
 *
 * The test helper (helpers/fake-db.ts) emulates this exact text and parameter order
 * (suffix, now, userId, prefix, pattern); a changed statement stops matching there and
 * fails the tests instead of being emulated wrongly.
 */
export function tombstoneRekeyStatement(args: RekeyArgs): Prisma.Sql {
  return Prisma.sql`
    UPDATE "EmailMessage"
    SET "gmailId" = "gmailId" || ${args.suffix}::text, "updatedAt" = ${args.now}
    WHERE "userId" = ${args.userId}
      AND starts_with("gmailId", ${args.prefix}::text)
      AND "gmailId" !~ ${TOMBSTONE_PATTERN}::text`;
}
