/**
 * Cut notification text to a length without breaking what the user reads
 * (NT0, 2026-11-17). `value.slice(0, n)` could stop inside a word, split a
 * surrogate pair or an emoji cluster, or keep the opening “ of a quote and
 * drop its closing ”. clampText instead:
 *   - cuts between grapheme clusters (Intl.Segmenter), never inside one;
 *   - backs off to the last word boundary when that keeps most of the room
 *     (Latin text); a script without spaces (Hangul run, Han) cuts on a
 *     character;
 *   - ends with "…" and closes every quotation mark the kept part left open
 *     (“ ”, 「 」, and an odd count of ").
 * The result is never longer than `max` UTF-16 code units, the unit every
 * existing cap in the notify code (and APNs / FCM size math) counts in.
 */

const ELLIPSIS = "…";
/** A word boundary is used only when it keeps at least this share of the room. */
const WORD_BACKOFF_MIN_SHARE = 0.6;
/** How much of the input is segmented at all: a few times the room, never the whole text. */
const SCAN_FACTOR = 4;
const SCAN_SLACK = 16;
/** Re-cuts allowed while making room for closing quotes. */
const MAX_REFITS = 3;

const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["“", "”"],
  ["「", "」"],
];

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const words = new Intl.Segmenter(undefined, { granularity: "word" });

export function clampText(value: string, max: number): string {
  if (max <= 0) return "";
  if (value.length <= max) return value;
  const scan = value.slice(0, max * SCAN_FACTOR + SCAN_SLACK);
  let budget = max - ELLIPSIS.length;
  let kept = cutAt(scan, budget);
  let closers = closersFor(kept);
  for (let i = 0; i < MAX_REFITS && kept.length + ELLIPSIS.length + closers.length > max; i++) {
    budget = max - ELLIPSIS.length - closers.length;
    kept = cutAt(scan, budget);
    closers = closersFor(kept);
  }
  if (kept.length + ELLIPSIS.length + closers.length > max) return cutAt(scan, max);
  return `${kept}${ELLIPSIS}${closers}`;
}

/** The longest prefix of whole graphemes within `budget`, backed off to a word boundary when one is close. */
function cutAt(text: string, budget: number): string {
  if (budget <= 0) return "";
  let end = 0;
  for (const { index, segment } of graphemes.segment(text)) {
    if (index + segment.length > budget) break;
    end = index + segment.length;
  }
  const wordEnd = lastWordBoundary(text, end);
  const cut = wordEnd >= end * WORD_BACKOFF_MIN_SHARE && wordEnd > 0 ? wordEnd : end;
  return text.slice(0, cut).trimEnd();
}

/** The last word-segment start at or before `end` (0 when none). */
function lastWordBoundary(text: string, end: number): number {
  if (end >= text.length) return end;
  let boundary = 0;
  for (const { index } of words.segment(text.slice(0, end + 1))) {
    if (index > end) break;
    boundary = index;
  }
  return boundary;
}

/** The marks that close every quotation the text opened and did not close. */
function closersFor(text: string): string {
  let closers = "";
  for (const [open, close] of PAIRS) {
    const opened = text.split(open).length - text.split(close).length;
    if (opened > 0) closers = close.repeat(opened) + closers;
  }
  if ((text.split('"').length - 1) % 2 === 1) closers = `"${closers}`;
  return closers;
}
