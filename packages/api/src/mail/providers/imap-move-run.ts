/**
 * One coalesced run of IMAP MOVEs inside an action session (step B2 of
 * docs/providers/unified-platform-plan.md): every queued operation that wants the
 * same move, in one `UID MOVE`, with the split-retry B1 uses for flag changes.
 *
 * A run is either INBOX -> a role folder (trash, archive) or a parked folder ->
 * INBOX (undo). Before it moves anything it checks, in this order:
 *   1. the live UIDVALIDITY of the mailbox the UIDs belong to equals the stored
 *      one (INBOX: the poller's; a parked folder: the one recorded with the move,
 *      and for an undo the INBOX's too, since the message lands there);
 *   2. the destination is one the account can trust (imap-folders.ts), else the
 *      action is `unsupported` on this account;
 *   3. the server advertises MOVE. imapflow's `messageMove` without it falls back
 *      to COPY + `\Deleted` + EXPUNGE, which is delete_permanent and sits on the
 *      deterministic floor, so without MOVE nothing is sent and the answer is
 *      `unsupported`;
 *   4. each UID still names the message Klorn expects (imap-envelope.ts).
 *
 * Success is per UID and only when the server confirmed where the message went:
 * the COPYUID of the MOVE answer, or, when the server sends none, a search of the
 * destination for the message's own Message-ID that finds exactly one. Anything
 * else is `unconfirmed`.
 */

import type { ImapFlow } from "imapflow";

import { type EnvelopeFacts, envelopeFacts, envelopeMatches } from "../imap-envelope.js";
import type { ImapProviderConfig } from "../imap-providers.js";
import { canonicalUidValidity, checkLiveValidity, liveUidValidity } from "../imap-uidvalidity.js";
import { fail } from "./action-failure.js";
import { isValidUid } from "./imap-flags.js";
import type { FolderFinder, MoveRole } from "./imap-folders.js";
import type { MailboxSwitch } from "./imap-mailbox-switch.js";
import type { SessionAccount } from "./imap-session.js";
import type { MailActionFailure, MailActionUnsupported } from "./types.js";

/**
 * Upper bound on MOVE commands one run may issue while splitting (B1's rule for
 * STORE). Halving finds one refused UID among 100 in about 14 commands; a run the
 * server refuses wholesale stops here, and the UIDs not moved are `refused`.
 */
export const MAX_MOVE_COMMANDS_PER_RUN = 40;

const INBOX = "INBOX";

export interface ToRoleOp {
  kind: "to-role";
  uid: number;
  role: MoveRole;
  expected: EnvelopeFacts;
}

export interface RestoreOp {
  kind: "restore";
  uid: number;
  /** The parked folder and the UIDVALIDITY it had when the message was moved into it. */
  from: { path: string; uidValidity: string };
  expected: EnvelopeFacts;
}

export type MoveOp = ToRoleOp | RestoreOp;

export interface MovedTo {
  path: string;
  uid: number;
  uidValidity: string;
}

/** What the server did with one UID. */
export type MoveOutcome =
  | { status: "moved"; to: MovedTo; seen: EnvelopeFacts }
  | { status: "missing" | "mismatch" | "refused" | "unconfirmed" };

export type MoveOpResult = MoveOutcome | MailActionFailure | MailActionUnsupported;

/** What a run needs from its session. */
export interface RunContext {
  provider: ImapProviderConfig;
  account: SessionAccount;
  client: ImapFlow;
  mailboxes: MailboxSwitch;
  folders: FolderFinder;
}

/** Can two operations share one MOVE? Same source, same destination, same validity. */
export function sameMoveRun(a: MoveOp, b: MoveOp): boolean {
  if (a.kind === "to-role" && b.kind === "to-role") return a.role === b.role;
  if (a.kind === "restore" && b.kind === "restore") {
    return a.from.path === b.from.path && a.from.uidValidity === b.from.uidValidity;
  }
  return false;
}

const unsupported = (error: string): MailActionUnsupported => ({ unsupported: true, error });

const roleLabel = (role: MoveRole): string => (role === "\\Trash" ? "Trash" : "Archive");

function everyUid(uids: readonly number[], result: MoveOpResult): Map<number, MoveOpResult> {
  return new Map(uids.map((uid) => [uid, result]));
}

/** imapflow rejects with `responseStatus: "NO"` when the server refuses a command (no such folder). */
function isServerRefusal(err: unknown): boolean {
  return (err as { responseStatus?: unknown } | null)?.responseStatus === "NO";
}

/** Select the mailbox the run's UIDs belong to and check its UIDVALIDITY. Null = go on. */
async function openSource(ctx: RunContext, first: MoveOp): Promise<MailActionFailure | null> {
  const { account, mailboxes, client, provider } = ctx;
  if (first.kind === "to-role") {
    const live = await mailboxes.open(INBOX);
    return checkLiveValidity(ctx.provider, account.rowId, account.inboxUidValidity, live);
  }
  let live: string | null;
  try {
    live = await mailboxes.open(first.from.path);
  } catch (err) {
    if (!isServerRefusal(err)) throw err;
    return fail(`The folder this message was moved to no longer exists on ${provider.label}.`);
  }
  const parked = checkLiveValidity(
    ctx.provider,
    `${account.rowId}:${first.from.path}`,
    first.from.uidValidity,
    live,
  );
  if (parked) return parked;
  // The message lands in INBOX: its numbering must be the one Klorn's rows use.
  const status = await client.status(INBOX, { uidValidity: true });
  return checkLiveValidity(
    ctx.provider,
    account.rowId,
    account.inboxUidValidity,
    liveUidValidity({ uidValidity: status.uidValidity }),
  );
}

async function destinationFor(
  ctx: RunContext,
  first: MoveOp,
): Promise<{ path: string } | MailActionUnsupported> {
  if (first.kind === "restore") return { path: INBOX };
  const path = await ctx.folders.find(first.role);
  if (path) return { path };
  return unsupported(
    `${ctx.provider.label} does not report a ${roleLabel(first.role)} folder Klorn can trust for this mailbox.`,
  );
}

async function fetchEnvelopes(
  client: ImapFlow,
  uids: readonly number[],
): Promise<Map<number, EnvelopeFacts>> {
  const seen = new Map<number, EnvelopeFacts>();
  for await (const message of client.fetch(uids.join(","), { envelope: true }, { uid: true })) {
    seen.set(message.uid, envelopeFacts(message.envelope));
  }
  return seen;
}

interface MoveAnswer {
  uids: number[];
  uidMap?: Map<number, number>;
  uidValidity?: bigint;
}

interface MoveResults {
  answered: MoveAnswer[];
  refused: number[];
}

/** MOVE the set; if the server refuses it, halve and retry down to single UIDs. */
async function moveWithSplit(
  client: ImapFlow,
  uids: readonly number[],
  destination: string,
  budget: { left: number },
): Promise<MoveResults> {
  if (budget.left <= 0) return { answered: [], refused: [...uids] };
  budget.left -= 1;
  const result = await client.messageMove(uids.join(","), destination, { uid: true });
  if (result) {
    return {
      answered: [{ uids: [...uids], uidMap: result.uidMap, uidValidity: result.uidValidity }],
      refused: [],
    };
  }
  if (uids.length === 1) return { answered: [], refused: [...uids] };

  const middle = Math.ceil(uids.length / 2);
  const first = await moveWithSplit(client, uids.slice(0, middle), destination, budget);
  const second = await moveWithSplit(client, uids.slice(middle), destination, budget);
  return {
    answered: [...first.answered, ...second.answered],
    refused: [...first.refused, ...second.refused],
  };
}

/** Where a moved message is now, from the server's COPYUID answer. */
function fromCopyUid(answer: MoveAnswer, uid: number, destination: string): MovedTo | null {
  const newUid = answer.uidMap?.get(uid);
  const uidValidity = canonicalUidValidity(answer.uidValidity);
  if (newUid === undefined || !isValidUid(newUid) || !uidValidity) return null;
  return { path: destination, uid: newUid, uidValidity };
}

/** The destination as it was just before the MOVE: the next UID it would assign, and its UIDVALIDITY. */
interface DestinationBefore {
  uidNext: number;
  uidValidity: string;
}

/**
 * Ask for the destination's UIDNEXT and UIDVALIDITY before moving into it, so that
 * a read-back can tell the message that just arrived from a copy that was already
 * there. Null when the server does not answer usably; the read-back then accepts
 * only an unambiguous single hit.
 */
async function destinationBefore(
  client: ImapFlow,
  path: string,
): Promise<DestinationBefore | null> {
  try {
    const status = await client.status(path, { uidNext: true, uidValidity: true });
    const uidNext = Number(status.uidNext);
    const uidValidity = canonicalUidValidity(status.uidValidity);
    return isValidUid(uidNext) && uidValidity ? { uidNext, uidValidity } : null;
  } catch (err) {
    if (!isServerRefusal(err)) throw err;
    return null;
  }
}

/**
 * Where a moved message is now, found by searching the destination for its own
 * Message-ID. A destination can already hold a copy with the same Message-ID (an
 * earlier trash of the same message). UIDs only grow, so what the MOVE just added
 * is at or above the UIDNEXT seen before it; a hit below that is a copy that was
 * already there and is never taken for the moved message. If the destination was
 * renumbered in between, or more than one new hit remains, nothing is claimed.
 */
async function fromReadBack(
  ctx: RunContext,
  seen: EnvelopeFacts,
  destination: string,
  before: DestinationBefore | null,
): Promise<MovedTo | null> {
  if (!seen.messageId) return null;
  const uidValidity = await ctx.mailboxes.open(destination);
  if (!uidValidity || (before && before.uidValidity !== uidValidity)) return null;
  const hits = await ctx.client.search({ header: { "message-id": seen.messageId } }, { uid: true });
  if (!Array.isArray(hits)) return null;
  const candidates = before ? hits.filter((uid) => uid >= before.uidNext) : hits;
  if (candidates.length !== 1 || !isValidUid(candidates[0])) return null;
  return { path: destination, uid: candidates[0], uidValidity };
}

/** Per UID: did the server confirm where it went? COPYUID first, a read-back otherwise. */
async function confirm(
  ctx: RunContext,
  answers: readonly MoveAnswer[],
  seen: ReadonlyMap<number, EnvelopeFacts>,
  destination: string,
  before: DestinationBefore | null,
): Promise<Map<number, MoveOpResult>> {
  const results = new Map<number, MoveOpResult>();
  for (const answer of answers) {
    for (const uid of answer.uids) {
      const facts = seen.get(uid) as EnvelopeFacts;
      const to =
        fromCopyUid(answer, uid, destination) ??
        (await fromReadBack(ctx, facts, destination, before));
      results.set(uid, to ? { status: "moved", to, seen: facts } : { status: "unconfirmed" });
    }
  }
  return results;
}

/** UIDs that are gone, or that now name another message, are settled here and never moved. */
function screen(
  ops: readonly MoveOp[],
  seen: ReadonlyMap<number, EnvelopeFacts>,
): { candidates: number[]; settled: Map<number, MoveOpResult> } {
  const settled = new Map<number, MoveOpResult>();
  const candidates: number[] = [];
  for (const op of ops) {
    if (settled.has(op.uid) || candidates.includes(op.uid)) continue;
    const facts = seen.get(op.uid);
    if (!facts) settled.set(op.uid, { status: "missing" });
    else if (!envelopeMatches(op.expected, facts)) settled.set(op.uid, { status: "mismatch" });
    else candidates.push(op.uid);
  }
  return { candidates, settled };
}

/**
 * Run every operation in `ops` (all `sameMoveRun`), with its mailbox already the
 * session's current one or not: this selects what it needs. Resolves with one result
 * per UID; a failure that applies to the whole run is repeated for each.
 */
export async function runMoveRun(
  ctx: RunContext,
  ops: readonly MoveOp[],
): Promise<Map<number, MoveOpResult>> {
  const uids = [...new Set(ops.map((op) => op.uid))];
  if (!uids.every(isValidUid)) return everyUid(uids, { status: "refused" });
  const first = ops[0];

  const refusal = await openSource(ctx, first);
  if (refusal) return everyUid(uids, refusal);
  const destination = await destinationFor(ctx, first);
  if ("unsupported" in destination) return everyUid(uids, destination);
  if (!ctx.client.capabilities.has("MOVE")) {
    return everyUid(
      uids,
      unsupported(
        `${ctx.provider.label} does not offer the IMAP MOVE command, and Klorn never deletes to move.`,
      ),
    );
  }

  const seen = await fetchEnvelopes(ctx.client, uids);
  const { candidates, settled } = screen(ops, seen);
  if (candidates.length === 0) return settled;

  const before = await destinationBefore(ctx.client, destination.path);
  const { answered, refused } = await moveWithSplit(ctx.client, candidates, destination.path, {
    left: MAX_MOVE_COMMANDS_PER_RUN,
  });
  const confirmed = await confirm(ctx, answered, seen, destination.path, before);
  return new Map<number, MoveOpResult>([
    ...settled,
    ...refused.map((uid) => [uid, { status: "refused" } as const] as const),
    ...confirmed,
  ]);
}
