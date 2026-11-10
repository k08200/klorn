const REPLACEMENT_CHARACTER = "\ufffd";
const MAX_CODE_POINT = 0x10ffff;
const SURROGATE_MIN = 0xd800;
const SURROGATE_MAX = 0xdfff;

/**
 * The character a numeric character reference (`&#…;` / `&#x…;`) stands for.
 *
 * Follows the HTML tokenizer's numeric-character-reference end state for the
 * invalid cases: zero, anything past U+10FFFF and the UTF-16 surrogate range
 * all become U+FFFD. Without this, `String.fromCodePoint` throws a RangeError
 * past U+10FFFF and returns a lone surrogate inside the range. A digit string
 * too long for a double parses to Infinity and lands in the past-U+10FFFF
 * case. (The tokenizer's Windows-1252 remap of 0x80-0x9F is not applied.)
 */
export function charFromCodePoint(code: number): string {
  if (!Number.isInteger(code) || code <= 0 || code > MAX_CODE_POINT) {
    return REPLACEMENT_CHARACTER;
  }
  if (code >= SURROGATE_MIN && code <= SURROGATE_MAX) return REPLACEMENT_CHARACTER;
  return String.fromCodePoint(code);
}
