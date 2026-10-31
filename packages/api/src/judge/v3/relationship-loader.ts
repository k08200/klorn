/**
 * Loads the rows behind a relationship snapshot (relationship.ts) for one
 * sender: the user's sent mail, the sender's mail, the user's sends in the
 * sender's threads, first contact, dismiss count, PIN_TIER and sender label.
 * Every query is scoped by userId (one user's ego network, never a cross-user
 * graph) and bounded. A failed lookup degrades that field to null (unknown);
 * it never throws, because the snapshot is context for the shadow, not a gate.
 */

import { db } from "../../db.js";
import { escapeLikePattern } from "../../db-like.js";
import { senderLabelsFor } from "../../mail/sender-labels.js";
import { fetchPinnedTier } from "../judge-context.js";
import {
  buildRelationshipSnapshot,
  type InboundRow,
  type RelationshipSnapshot,
  type SentRow,
  senderMailbox,
  UNKNOWN_RELATIONSHIP,
  writtenTo,
} from "./relationship.js";

/** Most recent sent rows scanned for one sender. */
export const SENT_SCAN_LIMIT = 300;
/** Most recent mails from the sender scanned. */
export const INBOUND_SCAN_LIMIT = 500;
/** Threads read for latency / reply rate. */
const THREAD_LIMIT = 100;
/** Oldest candidates read for first contact (LIKE can over-match; exact filter after). */
const FIRST_CONTACT_CANDIDATES = 20;

export interface InboundCandidate extends InboundRow {
  from: string;
  fromAddress: string | null;
}

export interface RelationshipLoaderDeps {
  hasAnySent(userId: string): Promise<boolean>;
  /** Sent rows whose To may contain the address, newest first (exact match after). */
  sentRowsMentioning(userId: string, address: string, order: "asc" | "desc"): Promise<SentRow[]>;
  /** Mails whose From may contain the address, newest first (exact match after). */
  inboundMentioning(
    userId: string,
    address: string,
    order: "asc" | "desc",
  ): Promise<InboundCandidate[]>;
  /** The user's sends in these threads, to anyone. */
  sentInThreads(
    userId: string,
    threadIds: string[],
  ): Promise<{ sentAt: Date; threadId: string | null }[]>;
  dismissCount(userId: string, address: string): Promise<number>;
  pinnedTier(userId: string, address: string): Promise<string | null>;
  senderCategory(userId: string, address: string): Promise<string | null>;
}

export const prismaRelationshipDeps: RelationshipLoaderDeps = {
  async hasAnySent(userId) {
    const row = await db.sentMessage.findFirst({ where: { userId }, select: { id: true } });
    return row !== null;
  },
  sentRowsMentioning(userId, address, order) {
    return db.sentMessage.findMany({
      // Escaped so "_" and "%" match literally; the exact mailbox comparison
      // happens in relationship.ts either way.
      where: { userId, to: { contains: escapeLikePattern(address), mode: "insensitive" } },
      select: { sentAt: true, to: true, threadId: true },
      orderBy: { sentAt: order },
      take: order === "desc" ? SENT_SCAN_LIMIT : FIRST_CONTACT_CANDIDATES,
    });
  },
  async inboundMentioning(userId, address, order) {
    const rows = await db.emailMessage.findMany({
      where: { userId, from: { contains: escapeLikePattern(address), mode: "insensitive" } },
      select: { threadId: true, receivedAt: true, from: true, fromAddress: true },
      orderBy: { receivedAt: order },
      take: order === "desc" ? INBOUND_SCAN_LIMIT : FIRST_CONTACT_CANDIDATES,
    });
    return rows;
  },
  sentInThreads(userId, threadIds) {
    return db.sentMessage.findMany({
      where: { userId, threadId: { in: threadIds } },
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
  // fetchPinnedTier is fail-open: a failed lookup reads as "no pin" (false).
  pinnedTier: (userId, address) => fetchPinnedTier(userId, address),
  async senderCategory(userId, address) {
    return (await senderLabelsFor(userId, [address])).get(address) ?? null;
  },
};

export interface RelationshipLoadInput {
  userId: string;
  senderAddress: string;
  userAddresses: readonly string[];
  /** This mail passed DMARC (or aligned SPF+DKIM); null = unknown. */
  senderAuthenticated?: boolean | null;
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

async function loadSent(userId: string, sender: string, deps: RelationshipLoaderDeps) {
  if ((await settle(() => deps.hasAnySent(userId), "sent-sync")) !== true) {
    return { sent: null, firstSentAt: undefined };
  }
  const [recent, oldest] = await Promise.all([
    settle(() => deps.sentRowsMentioning(userId, sender, "desc"), "sent"),
    settle(() => deps.sentRowsMentioning(userId, sender, "asc"), "first-sent"),
  ]);
  const first = oldest?.find((r) => writtenTo(r, sender));
  return {
    sent: recent ?? null,
    firstSentAt: oldest === undefined ? undefined : (first?.sentAt ?? null),
  };
}

async function loadInbound(userId: string, sender: string, deps: RelationshipLoaderDeps) {
  const [recent, oldest] = await Promise.all([
    settle(() => deps.inboundMentioning(userId, sender, "desc"), "inbound"),
    settle(() => deps.inboundMentioning(userId, sender, "asc"), "first-inbound"),
  ]);
  const inbound = recent?.filter(fromSender(sender)) ?? null;
  const first = oldest?.find(fromSender(sender));
  return {
    inbound: inbound?.map((r) => ({ threadId: r.threadId, receivedAt: r.receivedAt })) ?? null,
    firstInboundAt: oldest === undefined ? undefined : (first?.receivedAt ?? null),
  };
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
  const [sentData, inboundData, dismissCount, pinnedTier, senderCategory] = await Promise.all([
    loadSent(userId, sender, deps),
    loadInbound(userId, sender, deps),
    settle(() => deps.dismissCount(userId, sender), "dismiss"),
    settle(() => deps.pinnedTier(userId, sender), "pin"),
    settle(() => deps.senderCategory(userId, sender), "label"),
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
  });
}
