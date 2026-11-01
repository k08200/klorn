/**
 * Provenance for SentMessage rows the Sent-folder scan or the history import
 * CREATES (docs/design/attention-engine-v3.md §3(2)). Null means "the user
 * wrote it" and counts as relationship evidence, so mail Klorn sent on its own
 * before #1591 (unattended replies, mailto unsubscribes), or a Gmail-native
 * mailto unsubscribe, must not land as null.
 *
 * The rules mirror the legacy SQL backfill (migration
 * 20261101000000_sent_message_origin_backfill), checked in its order:
 *   approved     the gmailId is the messageId an executed send_email approval
 *                returned (ActionOutbox COMPLETED, PendingAction EXECUTED);
 *   auto_reply   an unattended-reply claim that did not fail, for a source mail
 *                whose "Re: <subject>" is the row's subject, addressed to the
 *                row's recipient, sent within [claim - 1 min, claim + 2 min];
 *   unsubscribe  the row's recipient is a stored mailto List-Unsubscribe target,
 *                with that target's subject, or an address that never sent the
 *                user mail (a person's address needs the exact subject).
 * Otherwise null. Never "user": nothing here proves a manual send.
 *
 * One deliberate difference: mailto targets go through parseMailtoTarget, the
 * function Klorn's own unsubscribe send uses, so a percent-encoded subject
 * matches here (the SQL compares the raw encoded text) and a target that
 * function rejects (no plausible address, oversized subject) never matches.
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
}

export interface ClaimNotification {
  dedupeKey: string | null;
  title: string;
  message: string;
  createdAt: Date;
}

/** What the rules read, loaded per batch by loadSentOriginEvidence. */
export interface SentOriginEvidence {
  /** `result` of the user's executed send_email approvals. */
  approvalResults: readonly (string | null)[];
  /** Unattended-reply claim notifications near the batch's send times. */
  claims: readonly ClaimNotification[];
  /** Subject of each claimed source mail, by gmailId. */
  sourceSubjects: ReadonlyMap<string, string>;
  /** Stored List-Unsubscribe mailto targets of the user's received mail. */
  unsubscribeMailtos: readonly (string | null)[];
  /** Mailto target addresses that also appear as a sender of the user's mail. */
  senderAddresses: ReadonlySet<string>;
}

const MESSAGE_ID_RE = /"messageId":"([^"]+)"/;
const CLAIM_KEY_RE = /^(?:auto-reply|auto-mode-reply):(.+)$/s;
const CLAIM_MESSAGE_ID_RE = /\[([^\]]+)\]\s*$/;
const CLAIM_RECIPIENT_RE = /(?:replied|reply) to (\S+)/;
const LEGACY_CLAIM_TITLE = "Auto-reply sent";
/** A failed claim sent nothing; every other claim state may have gone out. */
export const FAILED_CLAIM_TITLES = ["Auto-reply failed", "Auto-mode reply failed"];
const CLAIM_BEFORE_SEND_MS = 60_000;
const CLAIM_AFTER_SEND_MS = 2 * 60_000;

/** Postgres btrim(text): strips spaces only, not other whitespace. */
function btrim(text: string): string {
  return text.replace(/^ +| +$/g, "");
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

function isApproved(row: ClassifiableSentRow, ev: SentOriginEvidence): boolean {
  return ev.approvalResults.some((result) => extractApprovedMessageId(result) === row.gmailId);
}

function isAutoReply(row: ClassifiableSentRow, ev: SentOriginEvidence): boolean {
  const recipient = btrim(row.to).toLowerCase();
  const sent = row.sentAt.getTime();
  return ev.claims.some((claim) => {
    if (!isClaim(claim)) return false;
    const sourceId = claimSourceGmailId(claim.dedupeKey, claim.message);
    const sourceSubject = sourceId === null ? undefined : ev.sourceSubjects.get(sourceId);
    if (sourceSubject === undefined || row.subject !== `Re: ${sourceSubject}`) return false;
    if (claimRecipient(claim.message) !== recipient) return false;
    const at = claim.createdAt.getTime();
    return sent >= at - CLAIM_BEFORE_SEND_MS && sent <= at + CLAIM_AFTER_SEND_MS;
  });
}

function isUnsubscribe(row: ClassifiableSentRow, ev: SentOriginEvidence): boolean {
  const recipient = btrim(row.to).toLowerCase();
  if (recipient === "") return false;
  const subjects = ev.unsubscribeMailtos.flatMap((mailto) => {
    const target = mailto ? parseMailtoTarget(mailto) : null;
    return target && target.to === recipient ? [target.subject] : [];
  });
  if (subjects.length === 0) return false;
  return subjects.includes(row.subject) || !ev.senderAddresses.has(recipient);
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

/**
 * Claim createdAt ranges that can match the batch: sentAt in [claim - 1 min,
 * claim + 2 min] is createdAt in [sentAt - 2 min, sentAt + 1 min]. Merged
 * where they overlap, so the OR stays as small as the batch's spread.
 */
function claimWindows(rows: readonly ClassifiableSentRow[]): TimeWindow[] {
  const sorted = rows
    .map((r) => ({
      gte: r.sentAt.getTime() - CLAIM_AFTER_SEND_MS,
      lte: r.sentAt.getTime() + CLAIM_BEFORE_SEND_MS,
    }))
    .sort((a, b) => a.gte - b.gte);
  // Built locally, start-ordered: each window extends the last one it overlaps.
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

async function loadClaims(
  userId: string,
  rows: readonly ClassifiableSentRow[],
): Promise<{ claims: ClaimNotification[]; sourceSubjects: Map<string, string> }> {
  const claims = await prisma.notification.findMany({
    where: {
      userId,
      title: { notIn: FAILED_CLAIM_TITLES },
      AND: [
        { OR: [...REPLY_CLAIM_ROWS.OR, { dedupeKey: null, title: LEGACY_CLAIM_TITLE }] },
        { OR: claimWindows(rows).map((createdAt) => ({ createdAt })) },
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
  if (sourceIds.length === 0) return { claims, sourceSubjects: new Map() };
  const sources = await prisma.emailMessage.findMany({
    where: { userId, gmailId: { in: sourceIds } },
    select: { gmailId: true, subject: true },
  });
  return { claims, sourceSubjects: new Map(sources.map((s) => [s.gmailId, s.subject])) };
}

async function loadUnsubscribeEvidence(
  userId: string,
  rows: readonly ClassifiableSentRow[],
): Promise<{ unsubscribeMailtos: (string | null)[]; senderAddresses: Set<string> }> {
  const recipients = [...new Set(rows.map((r) => btrim(r.to).toLowerCase()))].filter(Boolean);
  if (recipients.length === 0) return { unsubscribeMailtos: [], senderAddresses: new Set() };
  const targets = await prisma.emailMessage.findMany({
    where: {
      userId,
      listUnsubscribeMailto: { not: null },
      OR: recipients.map((addr) => ({
        listUnsubscribeMailto: { contains: escapeLikePattern(addr), mode: "insensitive" as const },
      })),
    },
    distinct: ["listUnsubscribeMailto"],
    select: { listUnsubscribeMailto: true },
  });
  const unsubscribeMailtos = targets.map((t) => t.listUnsubscribeMailto);
  const wanted = new Set(recipients);
  const matched = [
    ...new Set(
      unsubscribeMailtos
        .map((m) => (m ? parseMailtoTarget(m)?.to : undefined))
        .filter((addr): addr is string => addr !== undefined && wanted.has(addr)),
    ),
  ];
  // One existence check per matched target address (usually none), never per row.
  const seen = await Promise.all(
    matched.map(async (addr) => {
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
  return { unsubscribeMailtos, senderAddresses: new Set(seen.flat()) };
}

/** Everything the rules need for one batch, in a fixed number of queries. */
export async function loadSentOriginEvidence(
  userId: string,
  rows: readonly ClassifiableSentRow[],
): Promise<SentOriginEvidence> {
  const [approvalResults, claimEvidence, unsubscribe] = await Promise.all([
    loadApprovalResults(userId, rows),
    loadClaims(userId, rows),
    loadUnsubscribeEvidence(userId, rows),
  ]);
  return { approvalResults, ...claimEvidence, ...unsubscribe };
}

/**
 * Labels for a batch of rows about to be created; only non-null labels are in
 * the map. Throws when the evidence cannot be read: the caller must then skip
 * the batch, since an unlabeled row would read as the user's own mail.
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
