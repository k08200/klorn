/**
 * IMAP flag changes and the STORE + read-back that confirms them (step B1 of
 * docs/providers/unified-platform-plan.md).
 *
 * One call covers a whole RUN of UIDs that want the same change: a single
 * `UID STORE` for the set, then a single `UID FETCH (FLAGS)` for the set. STORE
 * alone proves nothing — imapflow resolves `true` for a UID that no longer
 * exists, and a server may accept a flag it does not keep — so success is only
 * ever derived from what the read-back shows.
 */

import type { ImapFlow } from "imapflow";

const FLAG_SEEN = "\\Seen";
const FLAG_FLAGGED = "\\Flagged";

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

function holdsFlag(flags: Set<string> | string[], flag: string): boolean {
  return Array.isArray(flags) ? flags.includes(flag) : flags.has(flag);
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

/**
 * Apply one change to every UID in `uids` (INBOX must already be selected) and
 * report, per UID, what the server actually holds afterwards.
 */
export async function applyFlagRun(
  client: ImapFlow,
  uids: readonly number[],
  change: FlagChange,
): Promise<Map<number, ServerOutcome>> {
  const unique = [...new Set(uids)];
  const range = unique.join(",");
  const stored = change.set
    ? await client.messageFlagsAdd(range, [change.flag], { uid: true })
    : await client.messageFlagsRemove(range, [change.flag], { uid: true });
  if (!stored) return new Map(unique.map((uid) => [uid, "refused" as const]));
  const seen = await readBackFlags(client, range);
  return new Map(unique.map((uid) => [uid, outcomeFor(seen, uid, change)]));
}
