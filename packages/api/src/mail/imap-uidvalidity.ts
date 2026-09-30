/**
 * UIDVALIDITY rules for the IMAP actions and the poller (step B2 of
 * docs/providers/unified-platform-plan.md).
 *
 * RFC 3501 §2.3.1.1: a UID names a message only together with the mailbox's
 * UIDVALIDITY. When the value changes the server has renumbered the mailbox, so
 * a UID kept from before addresses a different message or none. Klorn keeps UIDs
 * in `EmailMessage.gmailId` (`<idPrefix>:<email>:<uid>`), so the poller stores
 * the INBOX value per linked account (`LinkedInboxAccount.inboxUidValidity`) and
 * every action compares the live value with it before it touches a UID.
 *
 * The value is an unsigned 32-bit integer, larger than a signed `Int` column, and
 * imapflow reports it as a `bigint` that `JSON.stringify` refuses. It is stored and
 * compared as its canonical decimal string, which is only ever compared for
 * equality.
 *
 * Everything here is pure except the once-per-change refusal log.
 */

import type { MailActionFailure } from "./providers/types.js";

/** RFC 3501: a UIDVALIDITY is a non-zero 32-bit unsigned integer. */
export const MAX_UID_VALIDITY = 4_294_967_295n;

const CANONICAL_DECIMAL = /^[1-9][0-9]{0,9}$/;

function withinBounds(value: bigint): boolean {
  return value >= 1n && value <= MAX_UID_VALIDITY;
}

/** The canonical decimal form of a UIDVALIDITY, or null when `value` is not one. */
export function canonicalUidValidity(value: unknown): string | null {
  if (typeof value === "bigint") return withinBounds(value) ? value.toString() : null;
  if (typeof value === "number") {
    return Number.isInteger(value) && withinBounds(BigInt(value)) ? String(value) : null;
  }
  if (typeof value === "string") {
    return CANONICAL_DECIMAL.test(value) && withinBounds(BigInt(value)) ? value : null;
  }
  return null;
}

/** The selected mailbox's live UIDVALIDITY (imapflow's `client.mailbox`), or null. */
export function liveUidValidity(mailbox: { uidValidity?: unknown } | false | null | undefined) {
  return mailbox ? canonicalUidValidity(mailbox.uidValidity) : null;
}

/**
 * How an action sees the stored and the live value. `unverified` covers a missing
 * value on either side: an action never proceeds on a UID it cannot vouch for.
 */
export type ValidityVerdict = "match" | "unverified" | "changed";

export function compareUidValidity(
  stored: string | null | undefined,
  live: string | null,
): ValidityVerdict {
  if (!stored || !live) return "unverified";
  return stored === live ? "match" : "changed";
}

/** What one poll cycle does with the value the server just reported. */
export type PollValidity = "unknown" | "baseline" | "same" | "reset";

export function classifyPollValidity(
  stored: string | null | undefined,
  live: string | null,
): PollValidity {
  if (!live) return "unknown";
  if (!stored) return "baseline";
  return stored === live ? "same" : "reset";
}

export function validityFailure(
  label: string,
  verdict: Exclude<ValidityVerdict, "match">,
): MailActionFailure {
  return {
    error:
      verdict === "unverified"
        ? `${label} mailbox has not been verified yet. Try again after the next sync.`
        : `${label} reset its mailbox numbering. Klorn will resync it; try again after the next sync.`,
  };
}

/** `${rowId}` -> the `stored->live` pair last logged for it. */
const lastLogged = new Map<string, string>();

/** Test hook: forget what was logged. */
export function resetUidValidityLogState(): void {
  lastLogged.clear();
}

/**
 * Log a refusal once per account and change, not once per call: a burst of a
 * hundred actions against a renumbered mailbox is one line. Only the row id and
 * the two validity numbers are written.
 */
export function logValidityRefusalOnce(
  logScope: string,
  rowId: string,
  verdict: Exclude<ValidityVerdict, "match">,
  stored: string | null | undefined,
  live: string | null,
): void {
  const change = `${verdict}:${stored ?? "none"}->${live ?? "none"}`;
  if (lastLogged.get(rowId) === change) return;
  lastLogged.set(rowId, change);
  console.warn(
    `[${logScope}] action refused for row ${rowId} — UIDVALIDITY ${verdict} (stored ${stored ?? "none"}, live ${live ?? "none"}); the next poll re-baselines`,
  );
}

/**
 * The check every action makes once it has selected a mailbox: compare the stored
 * value with the live one. Null when they match; otherwise the refusal to answer
 * (logged once per change). `key` names what the stored value belongs to: the row
 * id for INBOX, row id plus folder for a parked folder.
 */
export function checkLiveValidity(
  provider: { logScope: string; label: string },
  key: string,
  stored: string | null | undefined,
  live: string | null,
): MailActionFailure | null {
  const verdict = compareUidValidity(stored, live);
  if (verdict === "match") return null;
  logValidityRefusalOnce(provider.logScope, key, verdict, stored, live);
  return validityFailure(provider.label, verdict);
}
