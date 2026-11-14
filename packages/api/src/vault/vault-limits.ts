/**
 * Bounds of one Klorn Vault export. The archive streams as it is built and
 * is never stored, so these bound what one request can cost the server (DB
 * reads, CPU, time) and what the user downloads. When a mail limit is hit the
 * export stops adding mail notes, finishes the index notes and says in
 * Klorn/_klorn.md that it is partial, so the archive is always complete and
 * valid; the newest mails come first.
 */

export interface VaultLimits {
  /** Mail notes per export, newest first. */
  maxMailNotes: number;
  /** UTF-8 bytes of mail notes (bodies included) per export. */
  maxMailBytes: number;
  /** Characters of one mail's text, when mail text is asked for. */
  maxBodyChars: number;
  /** Commitments per list (active, done). */
  maxCommitments: number;
  /** Sender traits (what Klorn learned about senders). */
  maxSenderTraits: number;
  /** Time spent adding mail notes before the export finishes what it has. */
  timeBudgetMs: number;
  /** Mails read per query page. */
  pageSize: number;
}

export const VAULT_LIMITS: VaultLimits = {
  maxMailNotes: 5_000,
  maxMailBytes: 64 * 1024 * 1024,
  maxBodyChars: 50_000,
  maxCommitments: 2_000,
  maxSenderTraits: 5_000,
  timeBudgetMs: 60_000,
  pageSize: 200,
};

// Generous per-line upper bounds of the index notes: two links (path ≤ 240
// bytes, alias ≤ 80 characters of up to 4 bytes) and their separators; a
// trait line carries an address and an evidence quote (≤ 500 characters,
// escaped); a commitment line a title, a due text and two links.
const MAIL_REF_LINE_BYTES = 1_300;
const TRAIT_LINE_BYTES = 5_000;
const COMMITMENT_LINE_BYTES = 6_000;
const NOTE_HEAD_BYTES = 4_000;
const ZIP_ENTRY_OVERHEAD_BYTES = 30 + 46 + 2 * 240;
const FIXED_NOTES = 1 + 5 + 2;

/**
 * An upper bound of the archive size under `limits`: mail notes, every
 * mail listed in its lane and its sender note, sender traits, both
 * commitment lists, the index, and the ZIP headers (an entry is stored when
 * deflate would grow it, so data never exceeds its text).
 */
export function worstCaseArchiveBytes(limits: VaultLimits): number {
  const senderNotes = limits.maxMailNotes + limits.maxSenderTraits;
  const entries = limits.maxMailNotes + senderNotes + FIXED_NOTES;
  return (
    limits.maxMailBytes +
    2 * limits.maxMailNotes * MAIL_REF_LINE_BYTES +
    limits.maxSenderTraits * TRAIT_LINE_BYTES +
    2 * limits.maxCommitments * COMMITMENT_LINE_BYTES +
    (senderNotes + FIXED_NOTES) * NOTE_HEAD_BYTES +
    entries * ZIP_ENTRY_OVERHEAD_BYTES
  );
}
