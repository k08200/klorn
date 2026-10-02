/**
 * What an IMAP message looks like from its envelope, and whether two sightings of
 * it are the same message (step B2 of docs/providers/unified-platform-plan.md).
 *
 * A UID is only a stable name under an unchanged UIDVALIDITY, and even the stored
 * validity cannot prove that a UID Klorn remembers still names the message Klorn
 * has a row for (a row that predates a renumbering keeps its old UID, and the
 * stored value can be set to the live one again by a relink). So before an action MOVES a message, it fetches
 * the envelope of the UID and compares it with what Klorn knows: Message-ID when
 * both sides have one, otherwise subject and date. A mismatch refuses the action.
 *
 * `envelopeSubject` is the ONE place the subject a poll stores is derived, so the
 * value stored and the value compared cannot drift.
 */

export const NO_SUBJECT = "(no subject)";

/**
 * What an envelope may put in a stored row. An ENVELOPE can be megabytes (imapflow
 * accepts up to its literal cap), and these two fields are stored whole. The subject
 * limit is RFC 5322's line limit, far above a real subject; a cc list of 4 000
 * characters is dozens of addresses. Anything shorter is stored exactly as before.
 */
export const MAX_STORED_SUBJECT_LENGTH = 1_000;
export const MAX_STORED_CC_LENGTH = 4_000;

/** `text` cut to `max` UTF-16 units without leaving half a surrogate pair at the end. */
export function capStored(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * The subject exactly as the poller stores it: trimmed, capped, and a placeholder when
 * empty. The cap lives here, where the stored and the compared value are both derived,
 * so an over-long subject cannot make them differ.
 */
export function envelopeSubject(raw: string | null | undefined): string {
  const trimmed = raw?.trim();
  return trimmed ? capStored(trimmed, MAX_STORED_SUBJECT_LENGTH) : NO_SUBJECT;
}

export interface EnvelopeFacts {
  /** The RFC 5322 Message-ID as the server reported it (with its angle brackets). */
  messageId: string | null;
  subject: string;
  /** The Date header; null when the message has none (or it does not parse). */
  date: Date | null;
}

interface RawEnvelope {
  messageId?: string | null;
  subject?: string | null;
  date?: Date | null;
}

/** The facts of an imapflow envelope. */
export function envelopeFacts(envelope: RawEnvelope | null | undefined): EnvelopeFacts {
  const date = envelope?.date;
  return {
    messageId: envelope?.messageId?.trim() || null,
    subject: envelopeSubject(envelope?.subject),
    date: date instanceof Date && !Number.isNaN(date.getTime()) ? date : null,
  };
}

/**
 * Is `seen` the message `expected` describes? Message-ID decides when both sides
 * have one. Otherwise the subjects must be equal, and so must the dates when both
 * sides have one (a message without a Date header cannot be compared on date; the
 * poller stores the time it saw such a message, which is not a date to compare).
 */
export function envelopeMatches(expected: EnvelopeFacts, seen: EnvelopeFacts): boolean {
  if (expected.messageId && seen.messageId) return expected.messageId === seen.messageId;
  if (expected.subject !== seen.subject) return false;
  if (expected.date && seen.date) return expected.date.getTime() === seen.date.getTime();
  return true;
}
