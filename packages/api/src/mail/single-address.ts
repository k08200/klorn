/**
 * Parse ONE bare address out of an address header (step A4 of
 * docs/providers/unified-platform-plan.md).
 *
 * The header is untrusted: it is whatever the sender wrote. So this module PARSES
 * one mailbox and refuses everything else, instead of cleaning free text: no
 * display name, second address, group, control character or line break can reach a
 * draft's To line. It is one linear pass with no backtracking regex on the raw
 * header, and it refuses anything over the length bound before it looks at a
 * single character.
 *
 * Accepted: `a@b.co`, `Name <a@b.co>`, `"Doe, John" <a@b.co>` and a parenthesised
 * comment in the display name before the one angle group, `Jane (Acme) <a@b.co>`.
 * A comment is skipped, never read, and may not nest or hold `< > " \`; it is
 * refused anywhere else (beside a bare address, after or inside the angle group).
 */

import { hasHeaderBreaker } from "./header-text.js";

/** RFC 5322 section 2.1.1 hard limit for one header line. Longer is not an address header. */
export const MAX_ADDRESS_HEADER_LENGTH = 998;
/** RFC 5321 limit for one mailbox. */
const MAX_ADDRESS_LENGTH = 254;
const MAX_LOCAL_PART_LENGTH = 64;
const MAX_DOMAIN_LABEL_LENGTH = 63;

const DOMAIN_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
/** RFC 5322 atext: what one dot-separated piece of a local part may hold. */
const LOCAL_ATOM_CHARS: ReadonlySet<string> = new Set(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&'*+/=?^_`{|}~-",
);

/**
 * Strip only spaces and tabs from both ends. Not `String.trim()`: that also removes
 * CR, LF and the Unicode line separators, which would hide a line break at the edge
 * of a header value instead of refusing it.
 */
function trimBlanks(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && (text[start] === " " || text[start] === "\t")) start++;
  while (end > start && (text[end - 1] === " " || text[end - 1] === "\t")) end--;
  return text.slice(start, end);
}

function isValidLocalPart(local: string): boolean {
  if (local.length === 0 || local.length > MAX_LOCAL_PART_LENGTH) return false;
  return local.split(".").every((atom) => {
    if (atom.length === 0) return false;
    for (const ch of atom) if (!LOCAL_ATOM_CHARS.has(ch)) return false;
    return true;
  });
}

function isValidDomain(domain: string): boolean {
  const labels = domain.split(".");
  return (
    labels.length >= 2 &&
    labels.every(
      (label) => label.length <= MAX_DOMAIN_LABEL_LENGTH && DOMAIN_LABEL_PATTERN.test(label),
    )
  );
}

/** A plain ASCII `local@domain`: no quoted local part, no comment, no IDN. */
function isValidAddrSpec(addr: string): boolean {
  if (addr.length === 0 || addr.length > MAX_ADDRESS_LENGTH) return false;
  const at = addr.indexOf("@");
  if (at <= 0 || at !== addr.lastIndexOf("@")) return false;
  return isValidLocalPart(addr.slice(0, at)) && isValidDomain(addr.slice(at + 1));
}

interface AddressShape {
  /** Index of the one `<` and the one `>` outside quotes and comments; -1 for a bare address. */
  open: number;
  close: number;
  hasQuotedString: boolean;
  hasComment: boolean;
}

interface ScanState extends AddressShape {
  inQuote: boolean;
  escaped: boolean;
  inComment: boolean;
}

const INITIAL_SCAN: ScanState = {
  open: -1,
  close: -1,
  hasQuotedString: false,
  hasComment: false,
  inQuote: false,
  escaped: false,
  inComment: false,
};

/** Outside a quoted string or comment these mean several recipients or a group. */
const NOT_ONE_MAILBOX: ReadonlySet<string> = new Set([",", ";"]);
/** Inside a comment these make the structure ambiguous, so the header is refused. */
const FORBIDDEN_IN_COMMENT: ReadonlySet<string> = new Set(["(", "<", ">", '"', "\\"]);

/** One character inside a quoted string, where commas, brackets and `@` are just text. */
function stepInsideQuote(state: ScanState, ch: string): ScanState {
  if (state.escaped) return { ...state, escaped: false };
  if (ch === "\\") return { ...state, escaped: true };
  return ch === '"' ? { ...state, inQuote: false } : state;
}

/** One character inside a comment; null for one that could make the structure ambiguous. */
function stepInsideComment(state: ScanState, ch: string): ScanState | null {
  if (ch === ")") return { ...state, inComment: false };
  return FORBIDDEN_IN_COMMENT.has(ch) ? null : state;
}

/** One character outside quotes and comments; null when it breaks the one-mailbox shape. */
function stepOutside(state: ScanState, ch: string, index: number): ScanState | null {
  if (ch === '"') return { ...state, inQuote: true, hasQuotedString: true };
  // A comment anywhere but the display name fails later: one after the `>` leaves
  // text behind the angle group, one inside it is not part of a valid addr-spec.
  if (ch === "(") return { ...state, inComment: true, hasComment: true };
  if (ch === ")" || NOT_ONE_MAILBOX.has(ch)) return null;
  if (ch === "<") return state.open === -1 ? { ...state, open: index } : null;
  if (ch === ">")
    return state.open !== -1 && state.close === -1 ? { ...state, close: index } : null;
  return state;
}

function step(state: ScanState, ch: string, index: number): ScanState | null {
  if (state.inQuote) return stepInsideQuote(state, ch);
  if (state.inComment) return stepInsideComment(state, ch);
  return stepOutside(state, ch, index);
}

/**
 * One pass over the header: where the single angle group is, and whether the
 * structure is one mailbox at all. Null for anything that is not one mailbox.
 */
function scanShape(value: string): AddressShape | null {
  let state = INITIAL_SCAN;
  for (let i = 0; i < value.length; i++) {
    const next = step(state, value[i], i);
    if (next === null) return null;
    state = next;
  }
  if (state.inQuote || state.inComment || (state.open === -1) !== (state.close === -1)) return null;
  return state;
}

/** The address part of a one-mailbox header, or null when the shape is not one mailbox. */
function addressPart(value: string): string | null {
  const shape = scanShape(value);
  if (!shape) return null;
  if (shape.open === -1) return shape.hasQuotedString || shape.hasComment ? null : value;
  if (shape.close < shape.open || trimBlanks(value.slice(shape.close + 1)) !== "") return null;
  return value.slice(shape.open + 1, shape.close);
}

/**
 * The ONE bare address a header value names, or null. The display name and any
 * comment are dropped. Refuses a second address, a group, a control character or
 * line break, a non-ASCII address, anything over-long and anything that is not a
 * string.
 */
export function parseSingleAddress(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > MAX_ADDRESS_HEADER_LENGTH) return null;
  const value = trimBlanks(raw);
  if (value.length === 0 || hasHeaderBreaker(value)) return null;
  const addr = addressPart(value);
  return addr !== null && isValidAddrSpec(addr) ? addr : null;
}
