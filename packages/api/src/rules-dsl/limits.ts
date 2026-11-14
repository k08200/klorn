/**
 * Rules DSL v1 input limits (docs/design/rules-dsl.md §8). Each one has its
 * own error code and its own test.
 */

import { PIN_VALUE_MAX_CHARS } from "../mail/pin-validate.js";

export const RULES_DSL_LIMITS = {
  /** Whole text, UTF-8 bytes, checked before any parsing. */
  maxTextBytes: 64 * 1024,
  maxRules: 500,
  /** v1 has one condition kind (the sender), and one per rule. */
  maxConditionsPerRule: 1,
  maxNameChars: 120,
  maxNoteChars: 500,
  /** RFC 5321 forward-path limit; also bounds what the validators scan. */
  maxValueChars: PIN_VALUE_MAX_CHARS,
  maxErrors: 50,
  /** How much user text an error message may quote back. */
  quoteChars: 40,
  /** How much of a stored name a read-only comment shows. */
  commentNameChars: 60,
  /** Read-only comment lines in an export; the rest are counted, not listed. */
  maxReadOnlyLines: 100,
} as const;
