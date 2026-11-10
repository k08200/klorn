/**
 * IMAP flag changes and the STORE + read-back that confirms them (step B1 of
 * docs/providers/unified-platform-plan.md).
 *
 * One call covers a whole RUN of UIDs that want the same change: a `UID STORE`
 * for the set, then a single `UID FETCH (FLAGS)` for what was stored. STORE
 * alone proves nothing — imapflow resolves `true` for a UID that no longer
 * exists, and a server may accept a flag it does not keep — so success is only
 * ever derived from what the read-back shows.
 *
 * If the server refuses a coalesced STORE, one vanished or rejected UID must
 * not fail the valid ones: the run is split in halves and retried, recursively
 * down to single UIDs, within MAX_STORE_COMMANDS_PER_RUN commands.
 */

import type { ImapFlow } from "imapflow";

import { MAX_IMAP_UID } from "../imap-message-id.js";

const FLAG_SEEN = "\\Seen";
const FLAG_FLAGGED = "\\Flagged";

/**
 * Upper bound on STORE commands one run may issue while splitting. Halving finds
 * one bad UID among 200 in about 17 commands; a run where everything is refused
 * (a flag the mailbox does not keep) stops here instead of walking the whole
 * tree. UIDs not stored when the budget runs out are reported `refused`.
 */
export const MAX_STORE_COMMANDS_PER_RUN = 40;

export interface FlagChange {
  flag: string;
  /** true = add the flag, false = remove it. */
  set: boolean;
  /** The EmailMessage columns that mirror it. */
  local: { isRead: boolean } | { isStarred: boolean };
}

export const readChange = (isRead: boolean): FlagChange => ({
  flag: FLAG_SEEN,
  set: isRead,
  local: { isRead },
});

export const starChange = (starred: boolean): FlagChange => ({
  flag: FLAG_FLAGGED,
  set: starred,
  local: { isStarred: starred },
});

export function sameChange(a: FlagChange, b: FlagChange): boolean {
  return a.flag === b.flag && a.set === b.set;
}

/** What the server said once the change was read back. */
export type ServerOutcome = "confirmed" | "refused" | "missing" | "unconfirmed";

type FlagSet = Set<string> | string[] | undefined;

/** IMAP system flags are case-insensitive (RFC 3501 §2.3.2): `\SEEN` is `\Seen`. */
function holdsFlag(flags: Set<string> | string[], flag: string): boolean {
  const wanted = flag.toLowerCase();
  return [...flags].some((held) => held.toLowerCase() === wanted);
}

function outcomeFor(
  seen: ReadonlyMap<number, FlagSet>,
  uid: number,
  change: FlagChange,
): ServerOutcome {
  if (!seen.has(uid)) return "missing";
  const flags = seen.get(uid);
  // A FETCH answer with no FLAGS item says nothing about the flag. Reading it
  // as "flag absent" would confirm every remove, so it is never a confirmation.
  if (flags === undefined) return "unconfirmed";
  return holdsFlag(flags, change.flag) === change.set ? "confirmed" : "unconfirmed";
}

async function readBackFlags(client: ImapFlow, range: string): Promise<Map<number, FlagSet>> {
  const seen = new Map<number, FlagSet>();
  for await (const message of client.fetch(range, { flags: true }, { uid: true })) {
    seen.set(message.uid, message.flags);
  }
  return seen;
}

/** A UID is a non-zero 32-bit unsigned integer (RFC 3501). */
export function isValidUid(uid: number): boolean {
  return Number.isInteger(uid) && uid >= 1 && uid <= MAX_IMAP_UID;
}

interface StoreResult {
  stored: number[];
  refused: number[];
}

/** Commands still allowed for one run; shared by the whole recursion. */
interface Budget {
  left: number;
}

async function issueStore(
  client: ImapFlow,
  uids: readonly number[],
  change: FlagChange,
): Promise<boolean> {
  // Only ever called with validated UIDs, so the set string is digits and commas.
  const range = uids.join(",");
  return change.set
    ? client.messageFlagsAdd(range, [change.flag], { uid: true })
    : client.messageFlagsRemove(range, [change.flag], { uid: true });
}

/** STORE the set; if refused, halve and retry down to single UIDs. */
async function storeWithSplit(
  client: ImapFlow,
  uids: readonly number[],
  change: FlagChange,
  budget: Budget,
): Promise<StoreResult> {
  if (budget.left <= 0) return { stored: [], refused: [...uids] };
  budget.left -= 1;
  if (await issueStore(client, uids, change)) return { stored: [...uids], refused: [] };
  if (uids.length === 1) return { stored: [], refused: [...uids] };

  const middle = Math.ceil(uids.length / 2);
  const first = await storeWithSplit(client, uids.slice(0, middle), change, budget);
  const second = await storeWithSplit(client, uids.slice(middle), change, budget);
  return {
    stored: [...first.stored, ...second.stored],
    refused: [...first.refused, ...second.refused],
  };
}

/**
 * Apply one change to every UID in `uids` (INBOX must already be selected) and
 * report, per UID, what the server actually holds afterwards. A UID outside
 * 1..4294967295 refuses the whole run before any command is sent.
 */
export async function applyFlagRun(
  client: ImapFlow,
  uids: readonly number[],
  change: FlagChange,
): Promise<Map<number, ServerOutcome>> {
  const unique = [...new Set(uids)];
  if (!unique.every(isValidUid)) return new Map(unique.map((uid) => [uid, "refused" as const]));

  const { stored, refused } = await storeWithSplit(client, unique, change, {
    left: MAX_STORE_COMMANDS_PER_RUN,
  });
  const seen = stored.length > 0 ? await readBackFlags(client, stored.join(",")) : new Map();
  return new Map<number, ServerOutcome>([
    ...refused.map((uid) => [uid, "refused" as const] as const),
    ...stored.map((uid) => [uid, outcomeFor(seen, uid, change)] as const),
  ]);
}
