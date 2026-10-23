/**
 * From/To/Cc header values of the Klorn mailbox with RFC 2047 encoded-words in
 * their display names decoded (step E1b of docs/providers/unified-platform-plan.md).
 *
 * Only the display name is decoded, after the RAW value was parsed (quote- and
 * comment-aware, parseAddress): decoding the whole value first let an encoded
 * comment or name supply `"<jane@klorn.ai>"` that the parser then read as the
 * mailbox, so the stored sender differed from the real one (security
 * re-verification N1). Then:
 * - the value is rebuilt from the decoded name and the raw mailbox, the name
 *   quoted whenever it holds a character that would change how a mailbox or a
 *   list is read;
 * - as a guard, a rebuilt value whose mailbox is not the raw one is not used;
 * - control characters are removed (folding unfolded, others become a space).
 * A value without an angle-addr, without an encoded name, or whose mailbox the
 * parser refuses (two angle-addrs) is kept as it came, controls removed.
 */

import {
  displayNameOf,
  extractEmailAddress,
  formatMailbox,
  isPlainAddress,
  parseAddress,
  splitAddressList,
} from "./email-address.js";
import { decodeEncodedWords } from "./encoded-words.js";

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

function rebuild(name: string, address: string): string {
  if (!LIST_SPECIALS.test(name)) return formatMailbox(name, address);
  if (!isPlainAddress(address)) return address;
  return `"${name.replace(/["\\]/g, "\\$&")}" <${address}>`;
}

/** One mailbox (a From value, or one entry of a list). */
export function decodedMailbox(raw: string): string {
  // Controls carry no meaning in a mailbox: parse the value without them, still undecoded.
  const kept = stripControls(raw).trim();
  const address = parseAddress(kept).trim();
  const name = displayNameOf(kept);
  if (!address || !name?.includes("=?")) return kept;
  const decodedName = stripControls(decodeEncodedWords(name)).trim();
  const rebuilt = rebuild(decodedName, address);
  return extractEmailAddress(rebuilt) === address.toLowerCase() ? rebuilt : kept;
}

/** An address list (To, Cc): each mailbox decoded on its own, joined with ", ". */
export function decodedAddressList(raw: string): string {
  return splitAddressList(raw).map(decodedMailbox).join(", ");
}
