/**
 * Rules DSL v1 input limits (docs/design/rules-dsl.md §8). Each one has its
 * own error code and its own test.
 */

export const RULES_DSL_LIMITS = {
  /** Whole text, UTF-8 bytes, checked before any parsing. */
  maxTextBytes: 64 * 1024,
  maxRules: 500,
  /** v1 has one condition kind (the sender), and one per rule. */
  maxConditionsPerRule: 1,
  maxNameChars: 120,
  maxNoteChars: 500,
  /** RFC 5321 forward-path limit; also bounds what the validators scan. */
  maxValueChars: 254,
  maxErrors: 50,
  /** How much user text an error message may quote back. */
  quoteChars: 40,
  /** How much of a stored name a read-only comment shows. */
  commentNameChars: 60,
} as const;
