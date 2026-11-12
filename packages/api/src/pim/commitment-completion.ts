/**
 * Completion suggestions for the Commitment Ledger.
 *
 * Nothing detects that a promise was kept, so open rows pile up. The closest
 * honest signal is a later message in the promise's own thread:
 *   - owner USER ("I'll send the deck"): the user sent a reply in the thread
 *     after the promise → "likely done";
 *   - owner COUNTERPARTY ("Sarah will send it"): that counterparty wrote again
 *     in the thread after the promise → "likely delivered".
 * Either is only a suggestion. It stamps completionSuggestedAt (the evidence's
 * own time) and the user confirms DONE with one tap; nothing here sets DONE.
 *
 * Sources: the user's sends are SentMessage rows (the Sent-folder scan plus
 * Klorn's own sends; the Gmail-side stamps in mail/provider-replies.ts read
 * the same table). Klorn's autonomous sends (auto_reply, unsubscribe) are not
 * the user keeping a promise and never count. The counterparty's mail is the
 * EmailMessage mirror. Every match stays inside the source mail's thread AND
 * account — Gmail thread ids are per account — and the promise mail itself is
 * never its own evidence (a note the user mailed to themselves is both a
 * received mail and a send).
 *
 * Run by GET /api/commitments before it lists open rows (refresh on read, at
 * most once a minute per user): it covers sends from Klorn and from Gmail alike
 * without a hook in every send and sync path. Bounded: one read of the open,
 * unsuggested rows (at most SWEEP_LIMIT), then at most three capped reads and
 * MAX_STAMPS_PER_REFRESH writes, all scoped by userId. Never throws — the
 * ledger must list even when this fails.
 */

import type { CommitmentOwner } from "@prisma/client";
import { prisma } from "../db.js";
import { extractEmailAddress } from "../mail/email-address.js";
import { captureError } from "../sentry.js";

/** Open rows examined per read — the ledger's own list cap. */
const SWEEP_LIMIT = 200;
/** Thread messages read per kind per refresh (sends, the counterparties' mail). */
const EVIDENCE_READ_LIMIT = 1000;
/** Rows stamped per refresh; the rest are stamped on a later read. */
export const MAX_STAMPS_PER_REFRESH = 50;
const REFRESH_COOLDOWN_MS = 60_000;
/** Bound on the cooldown map: past it the map is reset (a few extra refreshes, no growth). */
const REFRESH_TRACKED_USERS_MAX = 10_000;
const lastRefreshAt = new Map<string, number>();
const PRIMARY_INBOX = "primary";
/** Sends that are the user's own: the Sent-folder scan (null), a manual send, an approved draft. */
const USER_SEND_ORIGINS = ["user", "approved"];

export interface CompletionCandidate {
  id: string;
  owner: "USER" | "COUNTERPARTY";
  threadId: string;
  /** "primary" or the LinkedInboxAccount id of the source mail. */
  inbox: string;
  /** The source mail's arrival: evidence must come strictly after it. */
  after: Date;
  sourceEmailId: string;
  sourceGmailId: string;
  /** Lowercased mailbox of the counterparty (owner COUNTERPARTY only). */
  counterpartyAddress: string | null;
}

export interface ThreadSend {
  threadId: string | null;
  inbox: string;
  sentAt: Date;
  gmailId: string;
}

export interface ThreadInbound {
  id: string;
  gmailId: string;
  threadId: string | null;
  inbox: string;
  receivedAt: Date;
  /** Lowercased sender mailbox. */
  fromAddress: string;
}

export interface CompletionSuggestion {
  id: string;
  at: Date;
}

export interface OpenCommitmentRow {
  id: string;
  owner: CommitmentOwner;
  threadId: string | null;
  sourceId: string | null;
  counterpartyEmail: string | null;
}

export interface SourceMailRow {
  id: string;
  gmailId: string;
  receivedAt: Date;
  linkedInboxAccountId: string | null;
}

const inboxOf = (linkedInboxAccountId: string | null): string =>
  linkedInboxAccountId ?? PRIMARY_INBOX;

/** The matching inputs for one open row, or null when it cannot be matched. Pure. */
export function toCompletionCandidate(
  row: OpenCommitmentRow,
  source: SourceMailRow | undefined,
): CompletionCandidate | null {
  if (row.owner !== "USER" && row.owner !== "COUNTERPARTY") return null;
  if (!row.threadId || !source) return null;
  const counterpartyAddress =
    row.owner === "COUNTERPARTY" && row.counterpartyEmail
      ? extractEmailAddress(row.counterpartyEmail) || null
      : null;
  return {
    id: row.id,
    owner: row.owner,
    threadId: row.threadId,
    inbox: inboxOf(source.linkedInboxAccountId),
    after: source.receivedAt,
    sourceEmailId: source.id,
    sourceGmailId: source.gmailId,
    counterpartyAddress,
  };
}

function earliest(times: readonly Date[]): Date | null {
  let first: Date | null = null;
  for (const at of times) if (!first || at.getTime() < first.getTime()) first = at;
  return first;
}

function evidenceFor(
  c: CompletionCandidate,
  sends: readonly ThreadSend[],
  inbound: readonly ThreadInbound[],
): Date | null {
  const inThread = (row: { threadId: string | null; inbox: string }) =>
    row.threadId === c.threadId && row.inbox === c.inbox;
  const afterPromise = (at: Date) => at.getTime() > c.after.getTime();
  if (c.owner === "USER") {
    return earliest(
      sends
        .filter((s) => inThread(s) && s.gmailId !== c.sourceGmailId && afterPromise(s.sentAt))
        .map((s) => s.sentAt),
    );
  }
  if (!c.counterpartyAddress) return null;
  return earliest(
    inbound
      .filter(
        (m) =>
          inThread(m) &&
          m.id !== c.sourceEmailId &&
          m.gmailId !== c.sourceGmailId &&
          m.fromAddress === c.counterpartyAddress &&
          afterPromise(m.receivedAt),
      )
      .map((m) => m.receivedAt),
  );
}

/** Each candidate with evidence, stamped with the earliest qualifying message. Pure. */
export function matchCompletionSuggestions(
  candidates: readonly CompletionCandidate[],
  sends: readonly ThreadSend[],
  inbound: readonly ThreadInbound[],
): CompletionSuggestion[] {
  return candidates.flatMap((c) => {
    const at = evidenceFor(c, sends, inbound);
    return at ? [{ id: c.id, at }] : [];
  });
}

async function loadCandidates(userId: string): Promise<CompletionCandidate[]> {
  const open = await prisma.commitment.findMany({
    where: {
      userId,
      status: "OPEN",
      completionSuggestedAt: null,
      sourceType: "EMAIL",
      owner: { in: ["USER", "COUNTERPARTY"] },
      threadId: { not: null },
      sourceId: { not: null },
    },
    select: { id: true, owner: true, threadId: true, sourceId: true, counterpartyEmail: true },
    // The ledger's own order (listCommitments): the rows the user sees first
    // are the rows checked first, so a backlog of unmatched rows can't starve them.
    orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }],
    take: SWEEP_LIMIT,
  });
  if (open.length === 0) return [];
  const sourceIds = [...new Set(open.flatMap((row) => (row.sourceId ? [row.sourceId] : [])))];
  const sources = await prisma.emailMessage.findMany({
    where: { userId, id: { in: sourceIds } },
    select: { id: true, gmailId: true, receivedAt: true, linkedInboxAccountId: true },
  });
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  return open.flatMap((row) => {
    const c = toCompletionCandidate(row, row.sourceId ? sourceById.get(row.sourceId) : undefined);
    return c ? [c] : [];
  });
}

interface EvidenceScope {
  userId: string;
  threadIds: string[];
  since: Date;
}

/** The user's own sends in the threads (oldest first; the earliest one is the evidence). */
function loadSends({ userId, threadIds, since }: EvidenceScope): Promise<ThreadSend[]> {
  return prisma.sentMessage.findMany({
    where: {
      userId,
      threadId: { in: threadIds },
      sentAt: { gt: since },
      OR: [{ origin: null }, { origin: { in: USER_SEND_ORIGINS } }],
    },
    select: { threadId: true, inbox: true, sentAt: true, gmailId: true },
    orderBy: { sentAt: "asc" },
    take: EVIDENCE_READ_LIMIT,
  });
}

/**
 * The counterparties' mail in the threads. Narrowed in the database to their
 * mailboxes; a row with no normalized address is kept and read from its From
 * header, so older mirror rows still count.
 */
async function loadInbound(
  { userId, threadIds, since }: EvidenceScope,
  addresses: string[],
): Promise<ThreadInbound[]> {
  const rows = await prisma.emailMessage.findMany({
    where: {
      userId,
      threadId: { in: threadIds },
      receivedAt: { gt: since },
      NOT: { labels: { has: "SENT" } },
      OR: [{ fromAddress: { in: addresses } }, { fromAddress: null }],
    },
    select: {
      id: true,
      gmailId: true,
      threadId: true,
      receivedAt: true,
      linkedInboxAccountId: true,
      from: true,
      fromAddress: true,
    },
    orderBy: { receivedAt: "asc" },
    take: EVIDENCE_READ_LIMIT,
  });
  return rows.map((m) => ({
    id: m.id,
    gmailId: m.gmailId,
    threadId: m.threadId,
    inbox: inboxOf(m.linkedInboxAccountId),
    receivedAt: m.receivedAt,
    fromAddress: (m.fromAddress ?? extractEmailAddress(m.from)).toLowerCase(),
  }));
}

async function loadEvidence(
  userId: string,
  candidates: readonly CompletionCandidate[],
): Promise<{ sends: ThreadSend[]; inbound: ThreadInbound[] }> {
  const scope: EvidenceScope = {
    userId,
    threadIds: [...new Set(candidates.map((c) => c.threadId))],
    since: new Date(Math.min(...candidates.map((c) => c.after.getTime()))),
  };
  const addresses = [
    ...new Set(
      candidates.flatMap((c) =>
        c.owner === "COUNTERPARTY" && c.counterpartyAddress ? [c.counterpartyAddress] : [],
      ),
    ),
  ];
  const wantsSends = candidates.some((c) => c.owner === "USER");
  const [sends, inbound] = await Promise.all([
    wantsSends ? loadSends(scope) : Promise.resolve([]),
    addresses.length > 0 ? loadInbound(scope, addresses) : Promise.resolve([]),
  ]);
  return { sends, inbound };
}

/**
 * Stamp completionSuggestedAt on the user's open rows that a later reply in
 * their thread suggests were kept. Only the ledger row changes: the stamp is a
 * hint for the user, not a lane change. At most MAX_STAMPS_PER_REFRESH per
 * call; the rest follow on the next read. Returns how many were stamped.
 */
export async function refreshCompletionSuggestions(userId: string): Promise<number> {
  try {
    const candidates = await loadCandidates(userId);
    if (candidates.length === 0) return 0;
    const { sends, inbound } = await loadEvidence(userId, candidates);
    const suggestions = matchCompletionSuggestions(candidates, sends, inbound).slice(
      0,
      MAX_STAMPS_PER_REFRESH,
    );
    let stamped = 0;
    for (const suggestion of suggestions) {
      // Scoped by owner and still-open-and-unsuggested, so a row settled in
      // the meantime (or another user's id) is left alone.
      const { count } = await prisma.commitment.updateMany({
        where: { id: suggestion.id, userId, status: "OPEN", completionSuggestedAt: null },
        data: { completionSuggestedAt: suggestion.at },
      });
      stamped += count;
    }
    return stamped;
  } catch (err) {
    captureError(err, { tags: { scope: "commitment.completion_suggest" }, extra: { userId } });
    return 0;
  }
}

/**
 * refreshCompletionSuggestions at most once per user per cooldown: the list is
 * re-read on every window focus, and a reply minutes old is fresh enough for a
 * hint. Per process (the API runs one instance); the map is bounded.
 */
export async function maybeRefreshCompletionSuggestions(
  userId: string,
  now = Date.now(),
): Promise<number> {
  const last = lastRefreshAt.get(userId);
  if (last !== undefined && now - last < REFRESH_COOLDOWN_MS) return 0;
  if (lastRefreshAt.size >= REFRESH_TRACKED_USERS_MAX) lastRefreshAt.clear();
  lastRefreshAt.set(userId, now);
  return refreshCompletionSuggestions(userId);
}
