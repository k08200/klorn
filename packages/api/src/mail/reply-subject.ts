/**
 * The subject of a reply draft (step A4 of docs/providers/unified-platform-plan.md).
 *
 * Two sources, two rules. A subject DERIVED from the original mail is data we did
 * not choose, so it is flattened to one line and stripped of invisible characters.
 * A subject an agent SUPPLIES is checked, never repaired: a line break or control
 * character is an error, not something to cut out. Both are capped in code points,
 * the unit the tool schema's `maxLength` counts in.
 */

import {
  exceedsCodePoints,
  hasHeaderBreaker,
  isHeaderBreaker,
  stripInvisibleControls,
  truncateCodePoints,
} from "./header-text.js";

/** Longest subject, agent-supplied or derived, in code points. Proposed value, generous for real mail. */
export const MAX_SUBJECT_LENGTH = 300;

const REPLY_PREFIX = "Re:";
const REPLY_PREFIX_PATTERN = /^re\s*:/i;

/** Replace every run of header-breaking characters with one space, dropping a trailing run. */
function flattenToOneLine(text: string): string {
  let out = "";
  let pendingSpace = false;
  for (const ch of text) {
    if (isHeaderBreaker(ch.codePointAt(0) ?? 0)) {
      pendingSpace = true;
      continue;
    }
    out += pendingSpace ? ` ${ch}` : ch;
    pendingSpace = false;
  }
  return out;
}

/**
 * The subject of a reply to a mail whose subject is `original`: `Re: <original>`,
 * with no second `Re:` when it already starts with one (any case, with or without a
 * space). One line, no invisible controls, never over MAX_SUBJECT_LENGTH, and
 * trimmed AFTER the cut so a cap that lands after a space leaves no trailing one.
 */
export function replySubject(original: string | null | undefined): string {
  const capped = truncateCodePoints(original ?? "", MAX_SUBJECT_LENGTH);
  const oneLine = flattenToOneLine(stripInvisibleControls(capped)).trim();
  if (REPLY_PREFIX_PATTERN.test(oneLine)) return oneLine;
  const prefixed = oneLine.length === 0 ? REPLY_PREFIX : `${REPLY_PREFIX} ${oneLine}`;
  return truncateCodePoints(prefixed, MAX_SUBJECT_LENGTH).trimEnd();
}

/**
 * An agent-supplied subject: any control character or line break is an error, and
 * it is tested BEFORE trimming so a trailing newline cannot be quietly dropped.
 * Bidi and zero-width controls are stripped. Null when the subject is not acceptable
 * (empty once stripped and trimmed, or over MAX_SUBJECT_LENGTH code points).
 */
export function checkedSubject(raw: string): string | null {
  if (hasHeaderBreaker(raw)) return null;
  const subject = stripInvisibleControls(raw).trim();
  return subject.length === 0 || exceedsCodePoints(subject, MAX_SUBJECT_LENGTH) ? null : subject;
}
