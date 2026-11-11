/**
 * Bounds on the SentMessage text fields. `to` and `subject` come from mail
 * headers (an auto-reply's subject echoes a stranger's), so every write stores
 * at most SENT_FIELD_MAX characters, and the provenance classifier reads the
 * same text the legacy SQL backfill would read from the table.
 */

export const SENT_FIELD_MAX = 1024;

/** Postgres text cannot hold NUL. */
const NUL = String.fromCharCode(0);
/** Prisma rejects a lone surrogate in a write and in a LIKE filter. Fixed-width lookarounds: linear. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * The first SENT_FIELD_MAX UTF-16 units, without NUL or lone surrogates (a
 * pair split by the cut loses its half). Cut first, so the work is bounded
 * whatever the header's length.
 */
export function clampSentField(text: string): string {
  return text.slice(0, SENT_FIELD_MAX).replaceAll(NUL, "").replace(LONE_SURROGATE_RE, "");
}
