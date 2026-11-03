/**
 * Provenance for SentMessage rows the Sent-folder scan or the history import
 * CREATES (docs/design/attention-engine-v3.md §3(2)). Null means "no proof
 * that Klorn sent it", which counts as the user's own mail, so mail Klorn sent
 * on its own before #1591 (unattended replies), and mailto unsubscribe
 * requests (Klorn's or Gmail's own), must not land as null.
 *
 * The rules mirror the legacy SQL backfill (migration
 * 20261101000000_sent_message_origin_backfill), checked in its order:
 *   approved     the gmailId is the messageId an executed send_email approval
 *                returned (ActionOutbox COMPLETED, PendingAction EXECUTED);
 *   auto_reply   an unattended-reply claim that did not fail, for a source mail
 *                whose "Re: <subject>" is the row's subject, addressed to the
 *                row's recipient, sent within [claim - 1 min, claim + 2 min],
 *                and no earlier sent row with that recipient and subject in the
 *                same window: one row per claim, so a manual reply right after
 *                stays null;
 *   unsubscribe  the row's recipient is the mailto List-Unsubscribe target of
 *                a mail received in the same inbox before the send, and either
 *                the subject is that target's subject, or the target subject is
 *                a per-mail token (16+ ASCII letters/digits), the row's subject
 *                has the same shape, and the address never sent the user mail.
 * Otherwise null. Never "user": nothing here proves a manual send.
 *
 * Two deliberate differences from the SQL, both from running in the app:
 *   - mailto targets go through parseMailtoTarget, the function Klorn's own
 *     unsubscribe send uses and the SQL emulates: it also decodes non-ASCII
 *     %XX escapes and rejects a target with no plausible address or an
 *     oversized subject or body;
 *   - "earlier" among rows with the same sentAt: the SQL compares random row
 *     ids; here a row already recorded counts as earlier, then gmailId order.
 *
 * Callers label rows on create only (SentMessageInput.inferredOrigin), so a
 * label recorded at send time is never overwritten.
 */

import { REPLY_CLAIM_ROWS } from "../agentcore/auto-reply-ledger-keys.js";
import { prisma } from "../db.js";
import { escapeLikePattern } from "../db-like.js";
import { parseMailtoTarget } from "./list-unsubscribe.js";
import type { SentOrigin } from "./sent-messages.js";

export interface ClassifiableSentRow {
  gmailId: string;
  to: string;
  subject: string;
  sentAt: Date;
  /** "primary" or a LinkedInboxAccount id. */
  inbox: string;
}

export interface ClaimNotification {
  dedupeKey: string | null;
  title: string;
  message: string;
  createdAt: Date;
}

/** A sent row that may be "earlier" for the one-row-per-claim rule. */
export interface SentNeighbour {
  gmailId: string;
  to: string;
  subject: string;
  sentAt: Date;
  /** Already in SentMessage (vs. created in this batch). */
  recorded: boolean;
}

/** A stored mailto target, with the first time it reached that inbox. */
export interface UnsubscribeCarrier {
  mailto: string;
  inbox: string;
  firstReceivedAt: Date;
}

/** What the rules read, loaded per batch by loadSentOriginEvidence. */
export interface SentOriginEvidence {
  /** `result` of the user's executed send_email approvals. */
  approvalResults: readonly (string | null)[];
  /** Unattended-reply claim notifications near the batch's send times. */
  claims: readonly ClaimNotification[];
  /** Subject of each claimed source mail, by gmailId. */
  sourceSubjects: ReadonlyMap<string, string>;
  /** Recorded rows inside the claims' windows, plus the batch itself. */
  sentNeighbours: readonly SentNeighbour[];
  /** List-Unsubscribe mailto targets of the user's received mail. */
  unsubscribeCarriers: readonly UnsubscribeCarrier[];
  /** Target addresses that also appear as a sender of the user's mail. */
  senderAddresses: ReadonlySet<string>;
}

const MESSAGE_ID_RE = /"messageId":"([^"]+)"/;
const CLAIM_KEY_RE = /^(?:auto-reply|auto-mode-reply):(.+)$/s;
const CLAIM_MESSAGE_ID_RE = /\[([^\]]+)\]\s*$/;
const CLAIM_RECIPIENT_RE = /(?:replied|reply) to (\S+)/;
const ALNUM_RE = /[A-Za-z0-9]/g;
const LEGACY_CLAIM_TITLE = "Auto-reply sent";
/** A failed claim sent nothing; every other claim state may have gone out. */
export const FAILED_CLAIM_TITLES = ["Auto-reply failed", "Auto-mode reply failed"];
const CLAIM_BEFORE_SEND_MS = 60_000;
const CLAIM_AFTER_SEND_MS = 2 * 60_000;
/** Letters and digits that make a mailto subject a per-mail token. */
const TOKEN_MIN_ALNUM = 16;

/** Postgres btrim(text): strips spaces only, not other whitespace. */
function btrim(text: string): string {
  return text.replace(/^ +| +$/g, "");
}

function recipientKey(to: string): string {
  return btrim(to).toLowerCase();
}

/** The SQL's substring(result from '"messageId":"([^"]+)"'): the first match. */
export function extractApprovedMessageId(result: string | null): string | null {
  return result ? (MESSAGE_ID_RE.exec(result)?.[1] ?? null) : null;
}

/** COALESCE(id from the claim key, trailing "[id]" of the message). */
export function claimSourceGmailId(dedupeKey: string | null, message: string): string | null {
  const fromKey = dedupeKey ? CLAIM_KEY_RE.exec(dedupeKey)?.[1] : undefined;
  return fromKey ?? CLAIM_MESSAGE_ID_RE.exec(message)?.[1] ?? null;
}

/** The address after "replied to " / "reply to " in a claim message, lowercased. */
export function claimRecipient(message: string): string | null {
  return CLAIM_RECIPIENT_RE.exec(message)?.[1]?.toLowerCase() ?? null;
}

function isClaim(n: ClaimNotification): boolean {
  if (FAILED_CLAIM_TITLES.includes(n.title)) return false;
  const key = n.dedupeKey;
  if (key === null) return n.title === LEGACY_CLAIM_TITLE;
  return key.startsWith("auto-reply:") || key.startsWith("auto-mode-reply:");
}

function inClaimWindow(sentAt: Date, claim: ClaimNotification): boolean {
  const at = claim.createdAt.getTime();
  const sent = sentAt.getTime();
  return sent >= at - CLAIM_BEFORE_SEND_MS && sent <= at + CLAIM_AFTER_SEND_MS;
}

function isApproved(row: ClassifiableSentRow, ev: SentOriginEvidence): boolean {
  return ev.approvalResults.some((result) => extractApprovedMessageId(result) === row.gmailId);
}

function claimMatches(
  row: ClassifiableSentRow,
  claim: ClaimNotification,
  ev: SentOriginEvidence,
): boolean {
  if (!isClaim(claim) || !inClaimWindow(row.sentAt, claim)) return false;
  const sourceId = claimSourceGmailId(claim.dedupeKey, claim.message);
  const sourceSubject = sourceId === null ? undefined : ev.sourceSubjects.get(sourceId);
  if (sourceSubject === undefined || row.subject !== `Re: ${sourceSubject}`) return false;
  return claimRecipient(claim.message) === recipientKey(row.to);
}

/** Another row with the same recipient and subject, sent before this one in the claim's window. */
function isEarlierInWindow(
  other: SentNeighbour,
  row: ClassifiableSentRow,
  claim: ClaimNotification,
): boolean {
  if (other.gmailId === row.gmailId || other.subject !== row.subject) return false;
  if (recipientKey(other.to) !== recipientKey(row.to) || !inClaimWindow(other.sentAt, claim)) {
    return false;
  }
  const a = other.sentAt.getTime();
  const b = row.sentAt.getTime();
  return a < b || (a === b && (other.recorded || other.gmailId < row.gmailId));
}

function isAutoReply(row: ClassifiableSentRow, ev: SentOriginEvidence): boolean {
  return ev.claims.some(
    (claim) =>
      claimMatches(row, claim, ev) &&
      !ev.sentNeighbours.some((other) => isEarlierInWindow(other, row, claim)),
  );
}

function alnumCount(text: string): number {
  return text.match(ALNUM_RE)?.length ?? 0;
}

function subjectShape(text: string): string {
  return text.replace(ALNUM_RE, "x");
}

function isUnsubscribe(row: ClassifiableSentRow, ev: SentOriginEvidence): boolean {
  const recipient = recipientKey(row.to);
  if (recipient === "") return false;
  return ev.unsubscribeCarriers.some((carrier) => {
    if (carrier.inbox !== row.inbox || row.sentAt < carrier.firstReceivedAt) return false;
    const target = parseMailtoTarget(carrier.mailto);
    if (!target || target.to !== recipient) return false;
    if (row.subject === target.subject) return true;
    return (
      alnumCount(target.subject) >= TOKEN_MIN_ALNUM &&
      subjectShape(row.subject) === subjectShape(target.subject) &&
      !ev.senderAddresses.has(recipient)
    );
  });
}

/** The pure rule: who sent a row the scan or import is about to create. */
export function classifySentOrigin(
  row: ClassifiableSentRow,
  evidence: SentOriginEvidence,
): SentOrigin | null {
  if (isApproved(row, evidence)) return "approved";
  if (isAutoReply(row, evidence)) return "auto_reply";
  if (isUnsubscribe(row, evidence)) return "unsubscribe";
  return null;
}

interface TimeWindow {
  gte: Date;
  lte: Date;
}

/** Ranges merged where they overlap, so an OR of them stays small. */
function mergeWindows(ranges: { gte: number; lte: number }[]): TimeWindow[] {
  const sorted = [...ranges].sort((a, b) => a.gte - b.gte);
  // Built locally, start-ordered: each range extends the last one it overlaps.
  const merged: { gte: number; lte: number }[] = [];
  for (const w of sorted) {
    const last = merged.at(-1);
    if (last && w.gte <= last.lte) {
      merged[merged.length - 1] = { gte: last.gte, lte: Math.max(last.lte, w.lte) };
    } else {
      merged.push(w);
    }
  }
  return merged.map((w) => ({ gte: new Date(w.gte), lte: new Date(w.lte) }));
}

async function loadApprovalResults(
  userId: string,
  rows: readonly ClassifiableSentRow[],
): Promise<(string | null)[]> {
  const idFilters = rows.map((r) => ({
    result: { contains: escapeLikePattern(`"messageId":"${r.gmailId}"`) },
  }));
  const [outbox, pending] = await Promise.all([
    prisma.actionOutbox.findMany({
      where: { userId, toolName: "send_email", status: "COMPLETED", OR: idFilters },
      select: { result: true },
    }),
    prisma.pendingAction.findMany({
      where: { userId, toolName: "send_email", status: "EXECUTED", OR: idFilters },
      select: { result: true },
    }),
  ]);
  return [...outbox, ...pending].map((r) => r.result);
}

type ClaimEvidence = Pick<SentOriginEvidence, "claims" | "sourceSubjects" | "sentNeighbours">;

/**
 * Claims that can match the batch (sentAt in [claim - 1 min, claim + 2 min] is
 * createdAt in [sentAt - 2 min, sentAt + 1 min]), their source subjects, and
 * the recorded rows inside those claims' windows.
 */
async function loadClaimEvidence(
  userId: string,
  rows: readonly ClassifiableSentRow[],
): Promise<ClaimEvidence> {
  const batch = rows.map((r) => ({ ...r, recorded: false }));
  const claimWindows = mergeWindows(
    rows.map((r) => ({
      gte: r.sentAt.getTime() - CLAIM_AFTER_SEND_MS,
      lte: r.sentAt.getTime() + CLAIM_BEFORE_SEND_MS,
    })),
  );
  const claims = await prisma.notification.findMany({
    where: {
      userId,
      title: { notIn: FAILED_CLAIM_TITLES },
      AND: [
        { OR: [...REPLY_CLAIM_ROWS.OR, { dedupeKey: null, title: LEGACY_CLAIM_TITLE }] },
        { OR: claimWindows.map((createdAt) => ({ createdAt })) },
      ],
    },
    select: { dedupeKey: true, title: true, message: true, createdAt: true },
  });
  const sourceIds = [
    ...new Set(
      claims
        .map((c) => claimSourceGmailId(c.dedupeKey, c.message))
        .filter((id): id is string => id !== null),
    ),
  ];
  if (sourceIds.length === 0) {
    return { claims, sourceSubjects: new Map(), sentNeighbours: batch };
  }
  const sendWindows = mergeWindows(
    claims.map((c) => ({
      gte: c.createdAt.getTime() - CLAIM_BEFORE_SEND_MS,
      lte: c.createdAt.getTime() + CLAIM_AFTER_SEND_MS,
    })),
  );
  const [sources, recorded] = await Promise.all([
    prisma.emailMessage.findMany({
      where: { userId, gmailId: { in: sourceIds } },
      select: { gmailId: true, subject: true },
    }),
    prisma.sentMessage.findMany({
      where: { userId, OR: sendWindows.map((sentAt) => ({ sentAt })) },
      select: { gmailId: true, to: true, subject: true, sentAt: true },
    }),
  ]);
  return {
    claims,
    sourceSubjects: new Map(sources.map((s) => [s.gmailId, s.subject])),
    sentNeighbours: [...recorded.map((r) => ({ ...r, recorded: true })), ...batch],
  };
}

type UnsubscribeEvidence = Pick<SentOriginEvidence, "unsubscribeCarriers" | "senderAddresses">;

async function loadUnsubscribeEvidence(
  userId: string,
  rows: readonly ClassifiableSentRow[],
): Promise<UnsubscribeEvidence> {
  const recipients = [...new Set(rows.map((r) => recipientKey(r.to)))].filter(Boolean);
  if (recipients.length === 0) return { unsubscribeCarriers: [], senderAddresses: new Set() };
  // One row per (target, inbox) with its first arrival: "received before the
  // send" only needs the earliest.
  const groups = await prisma.emailMessage.groupBy({
    by: ["listUnsubscribeMailto", "linkedInboxAccountId"],
    where: {
      userId,
      listUnsubscribeMailto: { not: null },
      OR: recipients.map((addr) => ({
        listUnsubscribeMailto: { contains: escapeLikePattern(addr), mode: "insensitive" as const },
      })),
    },
    _min: { receivedAt: true },
  });
  const unsubscribeCarriers = groups.flatMap((g) =>
    g.listUnsubscribeMailto && g._min.receivedAt
      ? [
          {
            mailto: g.listUnsubscribeMailto,
            inbox: g.linkedInboxAccountId ?? "primary",
            firstReceivedAt: g._min.receivedAt,
          },
        ]
      : [],
  );
  // The sender check only matters for a token subject; one query per such
  // target address (usually none), never one per row.
  const wanted = new Set(recipients);
  const tokenTargets = [
    ...new Set(
      unsubscribeCarriers.flatMap((c) => {
        const target = parseMailtoTarget(c.mailto);
        return target && wanted.has(target.to) && alnumCount(target.subject) >= TOKEN_MIN_ALNUM
          ? [target.to]
          : [];
      }),
    ),
  ];
  const seen = await Promise.all(
    tokenTargets.map(async (addr) => {
      const sender = await prisma.emailMessage.findFirst({
        where: {
          userId,
          OR: [
            { fromAddress: addr },
            { from: { contains: escapeLikePattern(addr), mode: "insensitive" } },
          ],
        },
        select: { id: true },
      });
      return sender ? [addr] : [];
    }),
  );
  return { unsubscribeCarriers, senderAddresses: new Set(seen.flat()) };
}

/** Everything the rules need for one batch, in a bounded number of queries. */
export async function loadSentOriginEvidence(
  userId: string,
  rows: readonly ClassifiableSentRow[],
): Promise<SentOriginEvidence> {
  const [approvalResults, claimEvidence, unsubscribe] = await Promise.all([
    loadApprovalResults(userId, rows),
    loadClaimEvidence(userId, rows),
    loadUnsubscribeEvidence(userId, rows),
  ]);
  return { approvalResults, ...claimEvidence, ...unsubscribe };
}

/**
 * Labels for a batch of rows about to be created; only non-null labels are in
 * the map. Throws when the evidence cannot be read: the caller must then skip
 * the batch, since an unlabeled row would count as the user's own mail.
 */
export async function classifySentRows(
  userId: string,
  rows: readonly ClassifiableSentRow[],
): Promise<Map<string, SentOrigin>> {
  if (rows.length === 0) return new Map();
  const evidence = await loadSentOriginEvidence(userId, rows);
  return new Map(
    rows.flatMap((row) => {
      const origin = classifySentOrigin(row, evidence);
      return origin ? [[row.gmailId, origin] as const] : [];
    }),
  );
}
