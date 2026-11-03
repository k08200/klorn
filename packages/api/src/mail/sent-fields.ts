/**
 * Bounds on the SentMessage text fields. `to` and `subject` come from mail
 * headers (an auto-reply's subject echoes a stranger's), so every write stores
 * at most SENT_FIELD_MAX characters, and the provenance classifier reads the
 * same truncated text the legacy SQL backfill would read from the table.
 */

export const SENT_FIELD_MAX = 1024;

/** At most SENT_FIELD_MAX UTF-16 units, never ending in half a surrogate pair. */
export function clampSentField(text: string): string {
  if (text.length <= SENT_FIELD_MAX) return text;
  const last = text.charCodeAt(SENT_FIELD_MAX - 1);
  const highSurrogate = last >= 0xd800 && last <= 0xdbff;
  return text.slice(0, highSurrogate ? SENT_FIELD_MAX - 1 : SENT_FIELD_MAX);
}
