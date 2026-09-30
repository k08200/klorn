/**
 * Where an MCP agent's reply draft goes and what it is called (step A4 of
 * docs/providers/unified-platform-plan.md).
 *
 * The recipient is chosen HERE, from headers the original sender wrote, never
 * from anything the agent passes in. Those headers are untrusted, so this module
 * PARSES one bare address and refuses everything else, instead of cleaning free
 * text: no display name, comment, group, second address or line break can reach
 * the draft's To line. The parser is one linear pass with no backtracking regex on
 * the raw header, and it refuses anything over the length bound before it looks
 * at a single character.
 *
 * Subjects follow the same rule. An agent-supplied subject is checked, not
 * repaired (a line break is an error, not something to strip); a subject derived
 * from the original mail is flattened to one line, because the original is data
 * we did not choose.
 */

/** RFC 5322 section 2.1.1 hard limit for one header line. Longer is not an address header. */
export const MAX_ADDRESS_HEADER_LENGTH = 998;
/** RFC 5321 limit for one mailbox. */
const MAX_ADDRESS_LENGTH = 254;
const MAX_LOCAL_PART_LENGTH = 64;
const MAX_DOMAIN_LABEL_LENGTH = 63;
/** Longest subject, agent-supplied or derived. Proposed value, generous for real mail. */
export const MAX_SUBJECT_LENGTH = 300;

const REPLY_PREFIX = "Re:";
const REPLY_PREFIX_PATTERN = /^re\s*:/i;
const DOMAIN_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
/** RFC 5322 atext: what one dot-separated piece of a local part may hold. */
const LOCAL_ATOM_CHARS: ReadonlySet<string> = new Set(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&'*+/=?^_`{|}~-",
);

const C0_LIMIT = 0x1f;
const DEL = 0x7f;
const NEL = 0x85;
const LINE_SEPARATOR = 0x2028;
const PARAGRAPH_SEPARATOR = 0x2029;

/** Every control character, plus the Unicode line breaks: none may sit in a header. */
function isHeaderBreaker(code: number): boolean {
  return (
    code <= C0_LIMIT ||
    code === DEL ||
    code === NEL ||
    code === LINE_SEPARATOR ||
    code === PARAGRAPH_SEPARATOR
  );
}

function hasHeaderBreaker(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (isHeaderBreaker(text.charCodeAt(i))) return true;
  }
  return false;
}

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

/** Cut to `max` UTF-16 units without leaving half a surrogate pair at the end. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(max - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return splitsPair ? cut.slice(0, -1) : cut;
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
  /** Index of the one `<` and the one `>` outside quotes; -1 for a bare address. */
  open: number;
  close: number;
  hasQuotedString: boolean;
}

interface ScanState {
  open: number;
  close: number;
  hasQuotedString: boolean;
  inQuote: boolean;
  escaped: boolean;
}

const INITIAL_SCAN: ScanState = {
  open: -1,
  close: -1,
  hasQuotedString: false,
  inQuote: false,
  escaped: false,
};

/** Outside a quoted string these mean several recipients, a group or a comment. */
const NOT_ONE_MAILBOX: ReadonlySet<string> = new Set([",", ";", "(", ")"]);

/** One character inside a quoted string, where commas, brackets and `@` are just text. */
function stepInsideQuote(state: ScanState, ch: string): ScanState {
  if (state.escaped) return { ...state, escaped: false };
  if (ch === "\\") return { ...state, escaped: true };
  return ch === '"' ? { ...state, inQuote: false } : state;
}

/** One character outside a quoted string; null when it breaks the one-mailbox shape. */
function stepOutsideQuote(state: ScanState, ch: string, index: number): ScanState | null {
  if (ch === '"') return { ...state, inQuote: true, hasQuotedString: true };
  if (NOT_ONE_MAILBOX.has(ch)) return null;
  if (ch === "<") return state.open === -1 ? { ...state, open: index } : null;
  if (ch === ">")
    return state.open !== -1 && state.close === -1 ? { ...state, close: index } : null;
  return state;
}

/**
 * One pass over the header: where the single angle group is, and whether the
 * structure is one mailbox at all. Quoted strings are skipped (a display name may
 * hold commas, brackets and even another address); outside them a comma or
 * semicolon means several recipients or a group, parentheses mean a comment, and a
 * second bracket means a second mailbox. Null for anything that is not one mailbox.
 */
function scanShape(value: string): AddressShape | null {
  let state = INITIAL_SCAN;
  for (let i = 0; i < value.length; i++) {
    const next = state.inQuote
      ? stepInsideQuote(state, value[i])
      : stepOutsideQuote(state, value[i], i);
    if (next === null) return null;
    state = next;
  }
  if (state.inQuote || (state.open === -1) !== (state.close === -1)) return null;
  return { open: state.open, close: state.close, hasQuotedString: state.hasQuotedString };
}

/** The address part of a one-mailbox header, or null when the shape is not one mailbox. */
function addressPart(value: string): string | null {
  const shape = scanShape(value);
  if (!shape) return null;
  if (shape.open === -1) return shape.hasQuotedString ? null : value;
  if (shape.close < shape.open || trimBlanks(value.slice(shape.close + 1)) !== "") return null;
  return value.slice(shape.open + 1, shape.close);
}

/**
 * The ONE bare address a header value names, or null. Accepts `a@b.co`,
 * `Name <a@b.co>` and `"Doe, John" <a@b.co>`; refuses a second address, a group, a
 * comment, a line break or control character, a non-ASCII address, anything
 * over-long and anything that is not a string. The display name is dropped.
 */
export function parseSingleAddress(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > MAX_ADDRESS_HEADER_LENGTH) return null;
  const value = trimBlanks(raw);
  if (value.length === 0 || hasHeaderBreaker(value)) return null;
  const addr = addressPart(value);
  return addr !== null && isValidAddrSpec(addr) ? addr : null;
}

export interface ReplyAddressSource {
  /** The original message's From header. */
  from: string;
  /** Its Reply-To header, when a provider supplies one. Untrusted like From. */
  replyTo?: unknown;
}

/**
 * The reply address: Reply-To when it is one valid address, otherwise From (also
 * when Reply-To lists several addresses or is malformed). Null when neither holds
 * one valid address. The agent has no say in this.
 */
export function pickReplyAddress({ from, replyTo }: ReplyAddressSource): string | null {
  return parseSingleAddress(replyTo) ?? parseSingleAddress(from);
}

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
 * with no second `Re:` when it already starts with one (any case, with or without
 * a space). Always one line and never over MAX_SUBJECT_LENGTH.
 */
export function replySubject(original: string | null | undefined): string {
  const oneLine = flattenToOneLine(truncate(original ?? "", MAX_SUBJECT_LENGTH)).trim();
  if (REPLY_PREFIX_PATTERN.test(oneLine)) return oneLine;
  return truncate(
    oneLine.length === 0 ? REPLY_PREFIX : `${REPLY_PREFIX} ${oneLine}`,
    MAX_SUBJECT_LENGTH,
  );
}

/**
 * An agent-supplied subject, checked and never repaired: any control character or
 * line break is an error, and it is tested BEFORE trimming so a trailing newline
 * cannot be quietly dropped. Null when the subject is not acceptable.
 */
export function checkedSubject(raw: string): string | null {
  if (hasHeaderBreaker(raw)) return null;
  const subject = raw.trim();
  return subject.length === 0 || subject.length > MAX_SUBJECT_LENGTH ? null : subject;
}
