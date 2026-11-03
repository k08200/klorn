/**
 * Loads the rows behind a relationship snapshot (relationship.ts) for one
 * sender: the user's sent mail, the sender's mail, the user's sends in the
 * sender's threads, first contact, dismiss count, PIN_TIER and sender label.
 * Every query is scoped by userId (one user's ego network, never a cross-user
 * graph) and bounded. A failed lookup degrades that field to null (unknown);
 * it never throws, because the snapshot is context for the shadow, not a gate.
 */

import { calendarCoattendanceEnabled } from "../../config.js";
import { db } from "../../db.js";
import { escapeLikePattern } from "../../db-like.js";
import { senderLabelsFor } from "../../mail/sender-labels.js";
import type { SentOrigin } from "../../mail/sent-messages.js";
import { isSenderAddressIndexEnabled, lookupPinnedTier } from "../judge-context.js";
import {
  buildRelationshipSnapshot,
  type CoAttendanceView,
  type InboundRow,
  type RelationshipSnapshot,
  type SentRow,
  senderMailbox,
  UNKNOWN_RELATIONSHIP,
  writtenTo,
} from "./relationship.js";

/**
 * Sends that count as "the user wrote to them" (doc §3(2), #1591/#1592):
 * the user's own sends in Klorn ("user"), bytes the user approved ("approved"),
 * and sends seen only by the Sent-folder scan (null: sent outside Klorn).
 * Klorn's unattended replies and mailto unsubscribes never count: an attacker
 * who triggers an auto-reply must not look like someone the user writes to.
 */
export const RELATIONSHIP_EVIDENCE_ORIGINS = [
  "user",
  "approved",
] as const satisfies readonly SentOrigin[];
export const SENT_EVIDENCE_WHERE = {
  OR: [{ origin: null }, { origin: { in: [...RELATIONSHIP_EVIDENCE_ORIGINS] } }],
};

/** Most recent sent rows scanned for one sender. */
export const SENT_SCAN_LIMIT = 300;
/** Most recent mails from the sender scanned. */
export const INBOUND_SCAN_LIMIT = 500;
/** Threads read for latency / reply rate. */
const THREAD_LIMIT = 100;

export interface InboundCandidate extends InboundRow {
  from: string;
  fromAddress: string | null;
}

export interface RelationshipLoaderDeps {
  hasAnySent(userId: string): Promise<boolean>;
  /** Sent rows whose To may contain the address, newest first (exact match after). */
  sentRowsMentioning(userId: string, address: string): Promise<SentRow[]>;
  /** The sender's mail, newest first (exact match after), minus the mail being judged. */
  inboundFrom(
    userId: string,
    address: string,
    excludeEmailId?: string,
  ): Promise<InboundCandidate[]>;
  /** The user's sends in these threads, to anyone. */
  sentInThreads(
    userId: string,
    threadIds: string[],
  ): Promise<{ sentAt: Date; threadId: string | null }[]>;
  dismissCount(userId: string, address: string): Promise<number>;
  /** Throws on a lookup failure (unknown), returns null for "no pin". */
  pinnedTier(userId: string, address: string): Promise<string | null>;
  senderCategory(userId: string, address: string): Promise<string | null>;
  /** Stored past co-attendance; undefined = unknown (see latestObservedSince). */
  coAttendance(userId: string, address: string): Promise<CoAttendanceView | undefined>;
}

/**
 * The window co-attendance counts cover: the latest observed-since marker,
 * only when EVERY Google calendar source has one (otherwise a contact seen
 * only in an unobserved calendar would read as 0). null = unknown.
 */
export function latestObservedSince(sources: readonly (Date | null)[]): Date | null {
  if (sources.length === 0 || sources.some((s) => s === null)) return null;
  return new Date(Math.max(...(sources as Date[]).map((s) => s.getTime())));
}

async function loadCoAttendance(
  userId: string,
  address: string,
): Promise<CoAttendanceView | undefined> {
  if (!calendarCoattendanceEnabled()) return undefined;
  const [token, linked] = await Promise.all([
    db.userToken.findUnique({
      where: { userId_provider: { userId, provider: "google" } },
      select: { coAttendanceObservedSince: true },
    }),
    db.linkedCalendarAccount.findMany({
      where: { userId, provider: "GOOGLE" },
      select: { coAttendanceObservedSince: true, needsReconnect: true },
    }),
  ]);
  // A calendar awaiting reconnect has stopped being counted: not observed now.
  const observedSince = latestObservedSince([
    ...(token ? [token.coAttendanceObservedSince] : []),
    ...linked.map((l) => (l.needsReconnect ? null : l.coAttendanceObservedSince)),
  ]);
  if (!observedSince) return undefined;
  const row = await db.contactCoAttendance.findUnique({
    where: { userId_contactEmail: { userId, contactEmail: address } },
    select: { meetingCount: true, smallMeetingCount: true, lastMetAt: true },
  });
  return { observedSince, row };
}

export const prismaRelationshipDeps: RelationshipLoaderDeps = {
  async hasAnySent(userId) {
    const row = await db.sentMessage.findFirst({
      where: { userId, ...SENT_EVIDENCE_WHERE },
      select: { id: true },
    });
    return row !== null;
  },
  sentRowsMentioning(userId, address) {
    // SentMessage has no recipient index: this filters the user's sent rows
    // (small today; a recipient-address column is the fix once sent history
    // is backfilled). Escaped so "_" and "%" match literally.
    return db.sentMessage.findMany({
      where: {
        userId,
        to: { contains: escapeLikePattern(address), mode: "insensitive" },
        ...SENT_EVIDENCE_WHERE,
      },
      select: { sentAt: true, to: true, threadId: true },
      orderBy: { sentAt: "desc" },
      take: SENT_SCAN_LIMIT,
    });
  },
  inboundFrom(userId, address, excludeEmailId) {
    // The same gate the judge's sender history uses: equality on the indexed,
    // normalised fromAddress once it is backfilled; the legacy substring scan
    // until then (an unbackfilled row has fromAddress = null).
    const where = isSenderAddressIndexEnabled()
      ? { userId, fromAddress: address }
      : { userId, from: { contains: escapeLikePattern(address), mode: "insensitive" as const } };
    return db.emailMessage.findMany({
      where: { ...where, ...(excludeEmailId ? { id: { not: excludeEmailId } } : {}) },
      select: { threadId: true, receivedAt: true, from: true, fromAddress: true },
      orderBy: { receivedAt: "desc" },
      take: INBOUND_SCAN_LIMIT,
    });
  },
  sentInThreads(userId, threadIds) {
    return db.sentMessage.findMany({
      where: { userId, threadId: { in: threadIds }, ...SENT_EVIDENCE_WHERE },
      select: { sentAt: true, threadId: true },
      take: SENT_SCAN_LIMIT,
    });
  },
  async dismissCount(userId, address) {
    const row = await db.contactEngagementScore.findUnique({
      where: { userId_contactEmail: { userId, contactEmail: address } },
      select: { dismissCount: true },
    });
    // Dismisses are recorded unconditionally (attention-dismiss.ts): no row = none.
    return row?.dismissCount ?? 0;
  },
  pinnedTier: (userId, address) => lookupPinnedTier(userId, address),
  async senderCategory(userId, address) {
    return (await senderLabelsFor(userId, [address])).get(address) ?? null;
  },
  coAttendance: loadCoAttendance,
};

export interface RelationshipLoadInput {
  userId: string;
  senderAddress: string;
  userAddresses: readonly string[];
  /** This mail passed DMARC (or aligned SPF+DKIM); null = unknown. */
  senderAuthenticated?: boolean | null;
  /** The mail being judged: excluded so a first-time sender reads as never seen. */
  excludeEmailId?: string;
}

/** undefined when the lookup failed: the snapshot then reports the field as null. */
async function settle<T>(p: () => Promise<T>, what: string): Promise<T | undefined> {
  try {
    return await p();
  } catch (err) {
    console.warn(
      `[judge-v3] relationship ${what} lookup failed:`,
      err instanceof Error ? err.name : "unknown",
    );
    return undefined;
  }
}

const fromSender = (sender: string) => (c: InboundCandidate) =>
  senderMailbox(c.fromAddress || c.from) === sender;

const threadIdsOf = (rows: readonly { threadId: string | null }[]) =>
  [...new Set(rows.map((r) => r.threadId).filter((id): id is string => Boolean(id)))].slice(
    0,
    THREAD_LIMIT,
  );

const earliest = (dates: Date[]): Date | null =>
  dates.length === 0 ? null : new Date(Math.min(...dates.map((d) => d.getTime())));

/** First contact is the oldest row within the scanned window (approximate for
 * senders past the scan limit, whose tenure is long either way). */
async function loadSent(userId: string, sender: string, deps: RelationshipLoaderDeps) {
  const rows = await settle(() => deps.sentRowsMentioning(userId, sender), "sent");
  if (rows === undefined) return { sent: null, firstSentAt: undefined };
  // No candidate rows: "never wrote to them" only if sent mail is synced at all.
  if (rows.length === 0 && (await settle(() => deps.hasAnySent(userId), "sent-sync")) !== true) {
    return { sent: null, firstSentAt: undefined };
  }
  return {
    sent: rows,
    firstSentAt: earliest(rows.filter((r) => writtenTo(r, sender)).map((r) => r.sentAt)),
  };
}

async function loadInbound(
  userId: string,
  sender: string,
  deps: RelationshipLoaderDeps,
  excludeEmailId?: string,
) {
  const rows = await settle(() => deps.inboundFrom(userId, sender, excludeEmailId), "inbound");
  if (rows === undefined) return { inbound: null, firstInboundAt: undefined };
  const inbound = rows
    .filter(fromSender(sender))
    .map((r) => ({ threadId: r.threadId, receivedAt: r.receivedAt }));
  return { inbound, firstInboundAt: earliest(inbound.map((r) => r.receivedAt)) };
}

/** The user's sends in the sender's threads; null when sent mail is not synced. */
async function loadThreadSends(
  userId: string,
  sentSynced: boolean,
  threads: string[],
  deps: RelationshipLoaderDeps,
) {
  if (!sentSynced) return null;
  if (threads.length === 0) return [];
  return (await settle(() => deps.sentInThreads(userId, threads), "thread-sends")) ?? null;
}

export async function loadRelationshipSnapshot(
  input: RelationshipLoadInput,
  deps: RelationshipLoaderDeps = prismaRelationshipDeps,
): Promise<RelationshipSnapshot> {
  const sender = senderMailbox(input.senderAddress);
  if (!sender) return { ...UNKNOWN_RELATIONSHIP };
  const { userId } = input;
  const [sentData, inboundData, dismissCount, pinnedTier, senderCategory, coAttendance] =
    await Promise.all([
      loadSent(userId, sender, deps),
      loadInbound(userId, sender, deps, input.excludeEmailId),
      settle(() => deps.dismissCount(userId, sender), "dismiss"),
      settle(() => deps.pinnedTier(userId, sender), "pin"),
      settle(() => deps.senderCategory(userId, sender), "label"),
      settle(() => deps.coAttendance(userId, sender), "co-attendance"),
    ]);
  const userSent = await loadThreadSends(
    userId,
    sentData.sent !== null,
    threadIdsOf(inboundData.inbound ?? []),
    deps,
  );
  return buildRelationshipSnapshot({
    senderAddress: sender,
    userAddresses: input.userAddresses,
    sent: sentData.sent,
    inbound: inboundData.inbound,
    userSentInSenderThreads: userSent,
    firstInboundAt: inboundData.firstInboundAt,
    firstSentAt: sentData.firstSentAt,
    senderAuthenticated: input.senderAuthenticated ?? null,
    dismissCount: dismissCount ?? null,
    pinnedTier,
    senderCategory,
    coAttendance,
  });
}
