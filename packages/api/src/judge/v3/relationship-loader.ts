/**
 * Loads the rows behind a relationship snapshot (relationship.ts) for one
 * sender: the user's sent mail, the sender's mail in those threads, dismiss
 * count, PIN_TIER and sender label. Every query is scoped by userId and
 * bounded. A failed lookup degrades that field to null (unknown); it never
 * throws, because the snapshot is context for the shadow, not a gate.
 */

import { db } from "../../db.js";
import { parseAddress } from "../../mail/email-address.js";
import { senderLabelsFor } from "../../mail/sender-labels.js";
import { fetchPinnedTier } from "../judge-context.js";
import {
  buildRelationshipSnapshot,
  type InboundRow,
  type RelationshipSnapshot,
  type SentRow,
  writtenTo,
} from "./relationship.js";

/** Most recent sent rows scanned for one sender. */
export const SENT_SCAN_LIMIT = 300;
/** Threads whose inbound mail is read for reply latency. */
const LATENCY_THREAD_LIMIT = 100;
/** Inbound rows read across those threads. */
const INBOUND_SCAN_LIMIT = 500;

export interface InboundCandidate extends InboundRow {
  from: string;
  fromAddress: string | null;
}

export interface RelationshipLoaderDeps {
  hasAnySent(userId: string): Promise<boolean>;
  /** Sent rows whose To may contain the address (exact match happens in relationship.ts). */
  sentRowsMentioning(userId: string, address: string): Promise<SentRow[]>;
  inboundInThreads(userId: string, threadIds: string[]): Promise<InboundCandidate[]>;
  dismissCount(userId: string, address: string): Promise<number>;
  pinnedTier(userId: string, address: string): Promise<string | null>;
  senderCategory(userId: string, address: string): Promise<string | null>;
}

export const prismaRelationshipDeps: RelationshipLoaderDeps = {
  async hasAnySent(userId) {
    const row = await db.sentMessage.findFirst({ where: { userId }, select: { id: true } });
    return row !== null;
  },
  sentRowsMentioning(userId, address) {
    return db.sentMessage.findMany({
      where: { userId, to: { contains: address, mode: "insensitive" } },
      select: { sentAt: true, to: true, threadId: true },
      orderBy: { sentAt: "desc" },
      take: SENT_SCAN_LIMIT,
    });
  },
  inboundInThreads(userId, threadIds) {
    return db.emailMessage.findMany({
      where: { userId, threadId: { in: threadIds } },
      select: { threadId: true, receivedAt: true, from: true, fromAddress: true },
      orderBy: { receivedAt: "desc" },
      take: INBOUND_SCAN_LIMIT,
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
  pinnedTier: (userId, address) => fetchPinnedTier(userId, address),
  async senderCategory(userId, address) {
    return (await senderLabelsFor(userId, [address])).get(address) ?? null;
  },
};

export interface RelationshipLoadInput {
  userId: string;
  senderAddress: string;
  userAddresses: readonly string[];
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

function senderOf(row: InboundCandidate): string {
  return (row.fromAddress || parseAddress(row.from) || "").trim().toLowerCase();
}

async function loadSent(
  input: RelationshipLoadInput,
  sender: string,
  deps: RelationshipLoaderDeps,
): Promise<{ sent: SentRow[] | null; inbound: InboundRow[] }> {
  const hasSent = await settle(() => deps.hasAnySent(input.userId), "sent-sync");
  if (hasSent !== true) return { sent: null, inbound: [] };
  const rows = await settle(() => deps.sentRowsMentioning(input.userId, sender), "sent");
  if (rows === undefined) return { sent: null, inbound: [] };
  // The same exact rule the builder applies, so latency threads are only
  // those the user actually wrote to this sender in.
  const threadIds = [
    ...new Set(
      rows
        .filter((r) => writtenTo(r, sender))
        .map((r) => r.threadId)
        .filter((id): id is string => Boolean(id)),
    ),
  ].slice(0, LATENCY_THREAD_LIMIT);
  if (threadIds.length === 0) return { sent: rows, inbound: [] };
  const candidates =
    (await settle(() => deps.inboundInThreads(input.userId, threadIds), "inbound")) ?? [];
  return {
    sent: rows,
    inbound: candidates
      .filter((c) => senderOf(c) === sender)
      .map((c) => ({ threadId: c.threadId, receivedAt: c.receivedAt })),
  };
}

const UNKNOWN: RelationshipSnapshot = {
  sentCount: null,
  lastSentAt: null,
  medianReplyLatencyMs: null,
  sameOrgDomain: null,
  coAttendanceNext14d: null,
  pinned: null,
  vip: null,
  dismissCount: null,
};

export async function loadRelationshipSnapshot(
  input: RelationshipLoadInput,
  deps: RelationshipLoaderDeps = prismaRelationshipDeps,
): Promise<RelationshipSnapshot> {
  const sender = (parseAddress(input.senderAddress) || input.senderAddress).trim().toLowerCase();
  if (!sender.includes("@")) return { ...UNKNOWN };
  const [sentData, dismissCount, pinnedTier, senderCategory] = await Promise.all([
    loadSent(input, sender, deps),
    settle(() => deps.dismissCount(input.userId, sender), "dismiss"),
    settle(() => deps.pinnedTier(input.userId, sender), "pin"),
    settle(() => deps.senderCategory(input.userId, sender), "label"),
  ]);
  return buildRelationshipSnapshot({
    senderAddress: sender,
    userAddresses: input.userAddresses,
    sent: sentData.sent,
    inbound: sentData.inbound,
    dismissCount: dismissCount ?? null,
    pinnedTier,
    senderCategory,
  });
}
