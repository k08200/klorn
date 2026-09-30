/**
 * Text helpers for values that end up in a mail header or a reply draft, shared by
 * `single-address.ts` and `reply-subject.ts`: what may never sit in a header, which
 * invisible characters are stripped, and limits measured in code points (the unit a
 * JSON-schema `maxLength` counts in, so the published bound and the enforced one
 * agree). All linear, none backtracking.
 */

const C0_LIMIT = 0x1f;
const DEL = 0x7f;
const NEL = 0x85;
const LINE_SEPARATOR = 0x2028;
const PARAGRAPH_SEPARATOR = 0x2029;

/** Zero-width and bidirectional-formatting controls: invisible, and able to reorder visible text. */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];

/** Every control character, plus the Unicode line breaks: none may sit in a header. */
export function isHeaderBreaker(code: number): boolean {
  return (
    code <= C0_LIMIT ||
    code === DEL ||
    code === NEL ||
    code === LINE_SEPARATOR ||
    code === PARAGRAPH_SEPARATOR
  );
}

export function hasHeaderBreaker(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (isHeaderBreaker(text.charCodeAt(i))) return true;
  }
  return false;
}

function isInvisibleControl(code: number): boolean {
  return INVISIBLE_RANGES.some(([from, to]) => code >= from && code <= to);
}

/** `text` without zero-width and bidi controls (U+200B-200F, U+202A-202E, U+2066-2069). */
export function stripInvisibleControls(text: string): string {
  let out = "";
  for (const ch of text) {
    if (!isInvisibleControl(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return out;
}

/** Whether `text` holds more than `max` code points, without counting past the answer. */
export function exceedsCodePoints(text: string, max: number): boolean {
  // A code point is one or two UTF-16 units, so the unit count brackets the answer.
  if (text.length <= max) return false;
  if (text.length > max * 2) return true;
  let count = 0;
  for (const _codePoint of text) {
    count += 1;
    if (count > max) return true;
  }
  return false;
}

/** The first `max` code points of `text`; never splits a surrogate pair. */
export function truncateCodePoints(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = 0;
  let count = 0;
  for (const codePoint of text) {
    if (count === max) break;
    end += codePoint.length;
    count += 1;
  }
  return text.slice(0, end);
}
