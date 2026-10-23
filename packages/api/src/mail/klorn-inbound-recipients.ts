/**
 * Which recipients of a signed Resend `email.received` event are Klorn addresses
 * (step E1b of docs/providers/unified-platform-plan.md). Pure.
 *
 * - Every address in `to`, `cc`, `bcc` and `received_for` (a Bcc'd address is
 *   only in the last), deduplicated.
 * - Only addresses at the mailbox domain count, compared case-insensitively.
 * - Exact match, per the E1a security review: the whole address must be ASCII,
 *   and only A-Z is case-folded. No Unicode folding anywhere, so U+212A (KELVIN
 *   SIGN) never becomes `k`; `normalizeHandle` is for claims only.
 * - The local part must have a handle's shape (klorn-handle.ts). No plus tags
 *   (L2): `name+tag@` is an unknown address. The reserved list plays no part:
 *   the database row decides, so a later addition to the list never stops
 *   delivery to an existing owner, and a name reserved all along has no row.
 * - `postmaster` and `abuse` are system addresses (L18): forwarded, not stored.
 *
 * `dropped` counts the addresses at the domain that will never be delivered;
 * an address at another domain is not a Klorn recipient, so it is not counted.
 */

import { isWellFormedHandle } from "./klorn-handle.js";
import { asciiLower } from "./text-normalize.js";

/** Forwarded to the support inbox (L18); never a user's mailbox. */
export const KLORN_SYSTEM_HANDLES: ReadonlySet<string> = new Set(["postmaster", "abuse"]);

/**
 * The most handles one event is looked up for. Recipient lists come from the
 * sender's headers; a real message names a handful of Klorn addresses, and this
 * bounds the lookup a hostile one can cause. The rest are dropped and counted.
 */
export const MAX_INBOUND_RECIPIENTS = 100;

const RECIPIENT_FIELDS = ["to", "cc", "bcc", "received_for"] as const;
/** Printable ASCII without the space: what an exact address is made of. */
const ASCII_ADDRESS = /^[\x21-\x7e]+$/;
/** The address inside `Name <address>`; the last one, as a mail reader shows it. */
const ANGLE_ADDRESS = /<([^<>]*)>\s*$/;

export interface InboundRecipients {
  /** Handle-shaped local parts to look up, in first-seen order. */
  handles: string[];
  /** System handles (postmaster, abuse) to forward. */
  system: string[];
  /** Addresses at the domain that are dropped. */
  dropped: number;
}

function bareAddress(entry: string): string {
  const angle = ANGLE_ADDRESS.exec(entry);
  return (angle ? angle[1] : entry).trim();
}

/** The raw local part when `entry` is at `domain`, else null. */
function localPartAt(entry: string, domain: string): string | null {
  const address = bareAddress(entry);
  const at = address.lastIndexOf("@");
  if (at <= 0) return null;
  if (asciiLower(address.slice(at + 1)) !== domain) return null;
  return address.slice(0, at);
}

function entriesOf(data: Record<string, unknown>): string[] {
  return RECIPIENT_FIELDS.flatMap((field) => {
    const value = data[field];
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  });
}

/** `domain` must already be ASCII lowercase (config.ts normalizes it). */
export function inboundRecipients(
  data: Record<string, unknown>,
  domain: string,
): InboundRecipients {
  const locals = entriesOf(data)
    .map((entry) => localPartAt(entry, domain))
    .filter((local): local is string => local !== null);
  const ascii = locals.filter((local) => ASCII_ADDRESS.test(local));
  // A non-ASCII local part is never deduplicated: it has no exact form to compare by.
  const nonAscii = locals.length - ascii.length;
  const unique = [...new Set(ascii.map(asciiLower))];
  const system = unique.filter((handle) => KLORN_SYSTEM_HANDLES.has(handle));
  const shaped = unique.filter(
    (handle) => !KLORN_SYSTEM_HANDLES.has(handle) && isWellFormedHandle(handle),
  );
  const malformed = unique.length - system.length - shaped.length;
  const overflow = Math.max(0, shaped.length - MAX_INBOUND_RECIPIENTS);
  return {
    handles: shaped.slice(0, MAX_INBOUND_RECIPIENTS),
    system,
    dropped: nonAscii + malformed + overflow,
  };
}
