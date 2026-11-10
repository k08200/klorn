/**
 * Provenance for SentMessage rows the Sent-folder scan or the history import
 * CREATES (docs/design/attention-engine-v3.md §3(2)). Null means "no proof
 * that Klorn sent it", which counts as the user's own mail, so mail Klorn sent
 * on its own before #1591 (unattended replies), and mailto unsubscribe
 * requests (Klorn's or Gmail's own), must not land as null.
 *
 * The rules are the legacy SQL backfill's (migration
 * 20261101000000_sent_message_origin_backfill), checked in its order, so the
 * backfill and the rows created since cannot disagree:
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
 * Mailto targets are derived by provenanceMailtoTarget, the SQL's own
 * derivation, not by parseMailtoTarget (whose send-side caps and decoding
 * would leave provable rows null). Two differences from the SQL:
 *   - among rows with the same sentAt, the SQL breaks the tie by random row
 *     id; here a row already recorded counts as earlier, then gmailId order;
 *   - both sides of every subject comparison are read as stored
 *     (clampSentField), so a subject over 1,024 characters still matches its
 *     source or mailto subject; the SQL compares the stored, truncated row
 *     with the untruncated text, so it never matches.
 *
 * Inputs are attacker-influenced (an auto-reply echoes a stranger's subject),
 * so `to` and `subject` are read as stored (SENT_FIELD_MAX) and every parse is
 * linear; mailto targets are indexed once per batch, so a row costs O(1)
 * lookups however many targets a sender crafted. Callers label rows on create only (SentMessageInput.inferredOrigin),
 * so a label recorded at send time is never overwritten.
 */

import { REPLY_CLAIM_ROWS } from "../agentcore/auto-reply-ledger-keys.js";
import { prisma } from "../db.js";
import { escapeLikePattern } from "../db-like.js";
import { clampSentField } from "./sent-fields.js";
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

/** A stored mailto target as the SQL derives it, with its first arrival in that inbox. */
export interface UnsubscribeTarget {
  addr: string;
  subject: string;
  inbox: string;
  firstReceivedAt: Date;
}

/**
 * Mailto targets indexed once per batch, so each row costs a couple of Map
 * lookups however many targets a sender crafted. Keys are (addr, inbox,
 * subject) and (addr, inbox, shape); each keeps the earliest arrival, which
 * is all "received before the send" needs. Subjects are read as stored
 * (clampSentField), the same as the row they are compared with.
 */
export interface UnsubscribeIndex {
  bySubject: ReadonlyMap<string, Date>;
  /** Token targets only (TOKEN_MIN_ALNUM+ letters/digits), by subject shape. */
  byTokenShape: ReadonlyMap<string, Date>;
  /** Addresses of token targets: the sender check runs only for these. */
  tokenAddrs: ReadonlySet<string>;
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
  /** List-Unsubscribe mailto targets of the user's received mail, indexed once. */
  unsubscribe: UnsubscribeIndex;
  /** Target addresses that also appear as a sender of the user's mail. */
  senderAddresses: ReadonlySet<string>;
}

const MESSAGE_ID_RE = /"messageId":"([^"]+)"/;
const CLAIM_KEY_RE = /^(?:auto-reply|auto-mode-reply):(.+)$/s;
const CLAIM_RECIPIENT_RE = /(?:replied|reply) to (\S+)/;
const ALNUM_RE = /[A-Za-z0-9]/g;
const MAILTO_PREFIX_RE = /^mailto:/i;
const MAILTO_SUBJECT_RE = /[?&]subject=([^&#]*)/;
const PERCENT_ESCAPE_RE = /%([0-9A-Fa-f]{2})/g;
const DEFAULT_MAILTO_SUBJECT = "unsubscribe";
const LEGACY_CLAIM_TITLE = "Auto-reply sent";
/** A failed claim sent nothing; every other claim state may have gone out. */
export const FAILED_CLAIM_TITLES = ["Auto-reply failed", "Auto-mode reply failed"];
const CLAIM_BEFORE_SEND_MS = 60_000;
const CLAIM_AFTER_SEND_MS = 2 * 60_000;
/** Letters and digits that make a mailto subject a per-mail token. */
const TOKEN_MIN_ALNUM = 16;

/** Trim the characters `isTrimmed` accepts from both ends, by index (linear). */
function trimBy(text: string, isTrimmed: (code: number) => boolean): string {
  let start = 0;
  let end = text.length;
  while (start < end && isTrimmed(text.charCodeAt(start))) start += 1;
  while (end > start && isTrimmed(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

const SPACE = 0x20;
/** Postgres btrim(text): strips spaces only, not other whitespace. */
export function sqlBtrim(text: string): string {
  return trimBy(text, (code) => code === SPACE);
}

/** The ASCII whitespace Postgres's \s matches: space, \t, \n, \v, \f, \r. */
function sqlTrimWhitespace(text: string): string {
  return trimBy(text, (code) => code === SPACE || (code >= 0x09 && code <= 0x0d));
}

function recipientKey(to: string): string {
  return sqlBtrim(to).toLowerCase();
}

/** Only %00-%7F (not %00) are decoded, like the SQL; anything else stays as written. */
function decodeAsciiEscapes(text: string): string {
  return text.replace(PERCENT_ESCAPE_RE, (whole, hex: string) => {
    const code = Number.parseInt(hex, 16);
    return code > 0 && code < 0x80 ? String.fromCharCode(code) : whole;
  });
}

/**
 * A mailto target exactly as the backfill SQL derives it:
 *   addr     lower(btrim(split_part(regexp_replace(m, '^mailto:', '', 'i'), '?', 1))),
 *            never decoded;
 *   subject  the first [?&]subject= value up to & or #, "+" as a space, ASCII
 *            %XX decoded (not %00), trimmed, "unsubscribe" when empty.
 * Every step is linear in the stored header.
 */
export function provenanceMailtoTarget(mailto: string): { addr: string; subject: string } {
  const rest = mailto.replace(MAILTO_PREFIX_RE, "");
  const query = rest.indexOf("?");
  const addr = sqlBtrim(query === -1 ? rest : rest.slice(0, query)).toLowerCase();
  const raw = MAILTO_SUBJECT_RE.exec(mailto)?.[1] ?? "";
  const subject = sqlTrimWhitespace(decodeAsciiEscapes(raw.replaceAll("+", " ")));
  return { addr, subject: subject || DEFAULT_MAILTO_SUBJECT };
}

/** The SQL's substring(result from '"messageId":"([^"]+)"'): the first match. */
export function extractApprovedMessageId(result: string | null): string | null {
  return result ? (MESSAGE_ID_RE.exec(result)?.[1] ?? null) : null;
}

/**
 * The SQL's substring(message from '\[([^\]]+)\]\s*$'), by index: the text
 * between the final "]" (only whitespace after it) and the first "[" after the
 * "]" before that. A backtracking regex here would be quadratic on many "[".
 */
function trailingBracketId(message: string): string | null {
  const body = message.trimEnd();
  if (!body.endsWith("]")) return null;
  const close = body.length - 1;
  const previousClose = body.lastIndexOf("]", close - 1);
  const open = body.indexOf("[", previousClose + 1);
  if (open === -1 || open >= close - 1) return null;
  return body.slice(open + 1, close);
}

/** COALESCE(id from the claim key, trailing "[id]" of the message). */
export function claimSourceGmailId(dedupeKey: string | null, message: string): string | null {
  const fromKey = dedupeKey ? CLAIM_KEY_RE.exec(dedupeKey)?.[1] : undefined;
  return fromKey ?? trailingBracketId(message);
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
  if (sourceSubject === undefined) return false;
  // Read as stored on both sides: the row's subject is clamped at write.
  if (row.subject !== clampSentField(`Re: ${sourceSubject}`)) return false;
  return claimRecipient(claim.message) === recipientKey(row.to);
}

/** Another row with the same recipient and subject, sent before this one in the claim's window. */
function isEarlierInWindow(
  other: SentNeighbour,
  row: ClassifiableSentRow,
  claim: ClaimNotification,
): boolean {
  if (other.gmailId === row.gmailId || clampSentField(other.subject) !== row.subject) return false;
  if (!inClaimWindow(other.sentAt, claim)) return false;
  if (recipientKey(clampSentField(other.to)) !== recipientKey(row.to)) return false;
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

const targetKey = (addr: string, inbox: string, text: string) =>
  JSON.stringify([addr, inbox, text]);

function keepEarliest(map: Map<string, Date>, key: string, at: Date): void {
  const known = map.get(key);
  if (!known || at < known) map.set(key, at);
}

/** Index the targets once: O(targets × SENT_FIELD_MAX), then O(1) per row. */
export function indexUnsubscribeTargets(targets: readonly UnsubscribeTarget[]): UnsubscribeIndex {
  const bySubject = new Map<string, Date>();
  const byTokenShape = new Map<string, Date>();
  const tokenAddrs = new Set<string>();
  for (const target of targets) {
    if (target.addr === "") continue;
    const subject = clampSentField(target.subject);
    keepEarliest(bySubject, targetKey(target.addr, target.inbox, subject), target.firstReceivedAt);
    if (alnumCount(subject) < TOKEN_MIN_ALNUM) continue;
    tokenAddrs.add(target.addr);
    const shapeKey = targetKey(target.addr, target.inbox, subjectShape(subject));
    keepEarliest(byTokenShape, shapeKey, target.firstReceivedAt);
  }
  return { bySubject, byTokenShape, tokenAddrs };
}

function isUnsubscribe(row: ClassifiableSentRow, ev: SentOriginEvidence): boolean {
  const recipient = recipientKey(row.to);
  if (recipient === "") return false;
  const { bySubject, byTokenShape } = ev.unsubscribe;
  const exact = bySubject.get(targetKey(recipient, row.inbox, row.subject));
  if (exact && row.sentAt >= exact) return true;
  if (ev.senderAddresses.has(recipient)) return false;
  const token = byTokenShape.get(targetKey(recipient, row.inbox, subjectShape(row.subject)));
  return token !== undefined && row.sentAt >= token;
}

/** `to` and `subject` as they are stored: what the SQL would read from the table. */
function asStored<T extends { to: string; subject: string }>(row: T): T {
  return { ...row, to: clampSentField(row.to), subject: clampSentField(row.subject) };
}

/** The pure rule: who sent a row the scan or import is about to create. */
export function classifySentOrigin(
  input: ClassifiableSentRow,
  evidence: SentOriginEvidence,
): SentOrigin | null {
  const row = asStored(input);
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
  const outbox = await prisma.actionOutbox.findMany({
    where: { userId, toolName: "send_email", status: "COMPLETED", OR: idFilters },
    select: { result: true },
  });
  const pending = await prisma.pendingAction.findMany({
    where: { userId, toolName: "send_email", status: "EXECUTED", OR: idFilters },
    select: { result: true },
  });
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
  const sources = await prisma.emailMessage.findMany({
    where: { userId, gmailId: { in: sourceIds } },
    select: { gmailId: true, subject: true },
  });
  const recorded = await prisma.sentMessage.findMany({
    where: { userId, OR: sendWindows.map((sentAt) => ({ sentAt })) },
    select: { gmailId: true, to: true, subject: true, sentAt: true },
  });
  return {
    claims,
    sourceSubjects: new Map(sources.map((s) => [s.gmailId, s.subject])),
    sentNeighbours: [...recorded.map((r) => ({ ...r, recorded: true })), ...batch],
  };
}

type UnsubscribeEvidence = Pick<SentOriginEvidence, "unsubscribe" | "senderAddresses">;

/**
 * Mailto targets that can match the batch, parsed once each: the database
 * keeps only stored targets whose raw text contains one of the batch's
 * recipients (the SQL's addr is never decoded, so it is always a substring),
 * one row per (target, inbox) with its first arrival, since "received before
 * the send" only needs the earliest. Then indexed once (indexUnsubscribeTargets).
 */
async function loadUnsubscribeEvidence(
  userId: string,
  rows: readonly ClassifiableSentRow[],
): Promise<UnsubscribeEvidence> {
  const recipients = [...new Set(rows.map((r) => recipientKey(r.to)))].filter(Boolean);
  if (recipients.length === 0) {
    return { unsubscribe: indexUnsubscribeTargets([]), senderAddresses: new Set() };
  }
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
  const wanted = new Set(recipients);
  const targets = groups.flatMap((g) => {
    if (!g.listUnsubscribeMailto || !g._min.receivedAt) return [];
    const target = provenanceMailtoTarget(g.listUnsubscribeMailto);
    if (!wanted.has(target.addr)) return [];
    const inbox = g.linkedInboxAccountId ?? "primary";
    return [{ ...target, inbox, firstReceivedAt: g._min.receivedAt }];
  });
  const unsubscribe = indexUnsubscribeTargets(targets);
  const senderAddresses = await knownSenders(userId, [...unsubscribe.tokenAddrs]);
  return { unsubscribe, senderAddresses };
}

/**
 * Which of these addresses ever sent the user mail, in one query: the SQL's
 * own test (fromAddress equality, or a substring of the lowercased From).
 */
async function knownSenders(userId: string, addrs: string[]): Promise<Set<string>> {
  if (addrs.length === 0) return new Set();
  const rows = await prisma.$queryRaw<{ addr: string }[]>`
    SELECT t.addr FROM unnest(${addrs}::text[]) AS t(addr)
    WHERE EXISTS (
      SELECT 1 FROM "EmailMessage" e
      WHERE e."userId" = ${userId}
        AND (e."fromAddress" = t.addr OR position(t.addr in lower(e."from")) > 0)
    )`;
  return new Set(rows.map((r) => r.addr));
}

/**
 * Everything the rules need for one batch, in a bounded number of queries run
 * one after another (the connection pool is small; this is background work).
 */
export async function loadSentOriginEvidence(
  userId: string,
  rows: readonly ClassifiableSentRow[],
): Promise<SentOriginEvidence> {
  const approvalResults = await loadApprovalResults(userId, rows);
  const claimEvidence = await loadClaimEvidence(userId, rows);
  const unsubscribe = await loadUnsubscribeEvidence(userId, rows);
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
  const stored = rows.map(asStored);
  const evidence = await loadSentOriginEvidence(userId, stored);
  return new Map(
    stored.flatMap((row) => {
      const origin = classifySentOrigin(row, evidence);
      return origin ? [[row.gmailId, origin] as const] : [];
    }),
  );
}
