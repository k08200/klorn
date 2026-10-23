/**
 * From/To/Cc header values of the Klorn mailbox as stored: each mailbox rebuilt
 * from its display name (RFC 2047 encoded-words decoded) and the mailbox the RAW
 * value parses to (step E1b of docs/providers/unified-platform-plan.md).
 *
 * The invariant: the stored value's mailbox (extractEmailAddress) is the raw
 * value's, or there is none. Two findings shaped this:
 * - N1: decoding the whole value before parsing let an encoded comment or name
 *   supply `"<jane@klorn.ai>"` that the parser then read as the mailbox. So the
 *   raw value is parsed first (quote- and comment-aware, parseAddress) and only
 *   the display name is decoded.
 * - A: a length cap applied after rebuilding cut inside a long quoted name, and
 *   the cut value parsed as the mailbox inside the name. So nothing is cut after
 *   composing: the display name is capped before (MAX_DISPLAY_NAME_CHARS), a
 *   mailbox over MAX_ADDRESS_CHARS is not stored, a raw value over
 *   MAX_RAW_HEADER_CHARS is parsed whole and keeps only its bare mailbox, and a
 *   list keeps whole entries only.
 * - The work is bounded too: a header over MAX_HEADER_CHARS is not parsed at
 *   all, and a list is scanned lazily, up to its budget or MAX_LIST_ENTRIES.
 * Every stored value is re-checked against the raw mailbox and falls back to the
 * bare mailbox, then to nothing. Comments are dropped; the name is quoted
 * whenever it holds a character that would change how a mailbox or a list reads;
 * control characters are removed (folding unfolded, others become a space).
 */

import {
  addressListEntries,
  displayNameOf,
  extractEmailAddress,
  formatMailbox,
  isPlainAddress,
  parseAddress,
  splitAddressList,
} from "./email-address.js";
import { decodeEncodedWords } from "./encoded-words.js";
import { capStored, MAX_STORED_CC_LENGTH } from "./imap-envelope.js";

/** A display name longer than this is cut, before the value is composed. */
export const MAX_DISPLAY_NAME_CHARS = 200;
/** RFC 5321's path limit: a longer mailbox is not stored at all. */
export const MAX_ADDRESS_CHARS = 254;
/** Past this a raw value keeps only its bare mailbox (parsed from the whole value). */
export const MAX_RAW_HEADER_CHARS = 16_000;
/**
 * The hard ceiling: a header longer than this is not parsed at all (a From has no
 * sender, a list has no entries). Headers come from Resend's GET response, which
 * has no size bound of its own; parsing 10 MB took most of a second on the event
 * loop. The caller reports such a header (`header-oversize`).
 */
export const MAX_HEADER_CHARS = 256 * 1024;
/** A stored list holds at most this many entries; the scan stops there. */
export const MAX_LIST_ENTRIES = 200;

/** What would change how a mailbox or a list reads, unquoted: RFC 5322 specials but ".". */
const LIST_SPECIALS = /["\\()<>,;:@[\]]/;
/** CRLF (or LF) before whitespace: header folding. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: unfolding CRLF is the point
const FOLDING = /\r?\n(?=[ \t])/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate control-character filter
const CONTROLS = /[\u0000-\u001f\u007f]+/g;

export function stripControls(value: string): string {
  return value.replace(FOLDING, "").replace(CONTROLS, " ");
}

function compose(name: string, address: string): string {
  if (!LIST_SPECIALS.test(name)) return formatMailbox(name, address);
  if (!isPlainAddress(address)) return address;
  return `"${name.replace(/["\\]/g, "\\$&")}" <${address}>`;
}

/** `candidate` when it names `address`, else the bare mailbox when that does, else "". */
function verified(candidate: string, address: string): string {
  const expected = address.toLowerCase();
  if (extractEmailAddress(candidate) === expected) return candidate;
  return extractEmailAddress(address) === expected ? address : "";
}

function storedName(clean: string): string {
  const raw = displayNameOf(clean);
  if (!raw) return "";
  const decoded = raw.includes("=?") ? stripControls(decodeEncodedWords(raw)) : raw;
  return capStored(decoded.trim(), MAX_DISPLAY_NAME_CHARS).trim();
}

/** One mailbox (a From value, or one entry of a list). */
export function decodedMailbox(raw: string): string {
  if (raw.length > MAX_HEADER_CHARS) return "";
  // Controls carry no meaning in a mailbox: parse the value without them, whole.
  const clean = stripControls(raw).trim();
  const address = parseAddress(clean).trim();
  if (!address || address.length > MAX_ADDRESS_CHARS) return "";
  if (raw.length > MAX_RAW_HEADER_CHARS) return verified(address, address);
  return verified(compose(storedName(clean), address), address);
}

/**
 * An address list (To, Cc): each mailbox decoded on its own and joined with ", ",
 * whole entries only, within the column's limit and at most MAX_LIST_ENTRIES
 * entries examined. An entry that would not read back as exactly itself (a
 * stray comma in a mailbox that is not an address) is left out.
 */
export function decodedAddressList(raw: string, max = MAX_STORED_CC_LENGTH): string {
  if (raw.length > MAX_HEADER_CHARS) return "";
  let stored = "";
  let examined = 0;
  // Lazy: the scan stops at the budget or the entry limit, and the entry after
  // the limit is never pulled from it.
  for (const entry of addressListEntries(raw)) {
    const mailbox = decodedMailbox(entry);
    const readBack = splitAddressList(mailbox);
    if (readBack.length === 1 && readBack[0] === mailbox) {
      const next = stored ? `${stored}, ${mailbox}` : mailbox;
      if (next.length > max) break;
      stored = next;
    }
    examined += 1;
    if (examined >= MAX_LIST_ENTRIES) break;
  }
  return stored;
}
