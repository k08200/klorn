/**
 * Relationship snapshot (docs/design/attention-engine-v3.md §3(2)): who the
 * sender is to the user, from data the product already has. No LLM.
 *
 * Pure over pre-fetched rows (the loader is relationship-loader.ts), so it can
 * be replayed and tested without a database. Every field is null when the data
 * to answer it does not exist, never 0: policy must be able to tell "unknown"
 * from "never".
 *
 * coAttendanceNext14d is always null for now: CalendarEvent stores no
 * attendees (schema.prisma CalendarEvent), so co-attendance cannot be read from
 * data. interaction-graph.ts approximates it from email volume, which is not
 * what this field claims, so it is not reused here.
 */

import { parseAddress, splitAddressList } from "../../mail/email-address.js";
import { isPublicMailboxDomain } from "../../mail/public-mailbox-domains.js";

export interface RelationshipSnapshot {
  /** Times the user wrote to the sender (within the scanned window). */
  sentCount: number | null;
  /** Last time the user wrote to the sender, ISO-8601 UTC. */
  lastSentAt: string | null;
  /** Median time from the sender's unanswered mail to the user's reply. */
  medianReplyLatencyMs: number | null;
  /** Sender shares a non-public mail domain with the user. */
  sameOrgDomain: boolean | null;
  /** Calendar events with the sender in the next 14 days. */
  coAttendanceNext14d: number | null;
  /** A PIN_TIER rule applies to the sender (address or domain). */
  pinned: boolean | null;
  /** Labelled investor/customer, or pinned to PUSH. */
  vip: boolean | null;
  /** Times the user dismissed the sender's items. */
  dismissCount: number | null;
}

export interface SentRow {
  sentAt: Date;
  to: string;
  threadId: string | null;
}

export interface InboundRow {
  receivedAt: Date;
  threadId: string | null;
}

export interface RelationshipInput {
  /** Raw From value or bare address. */
  senderAddress: string;
  userAddresses: readonly string[];
  /** The user's sent mail that may be to the sender; null = no sent-mail sync. */
  sent: readonly SentRow[] | null;
  /** The sender's mail in the threads of `sent`. */
  inbound: readonly InboundRow[];
  dismissCount: number | null;
  /** PIN_TIER for the sender: a tier, null = none, undefined = unknown. */
  pinnedTier: string | null | undefined;
  /** SenderLabel category: a category, null = none, undefined = unknown. */
  senderCategory: string | null | undefined;
}

const VIP_CATEGORIES = new Set(["investor", "customer"]);
/** A reply this long after the mail is not a reply-latency signal. */
export const MAX_REPLY_LATENCY_MS = 30 * 86_400_000;

function bareAddress(value: string): string {
  return (parseAddress(value) || value).trim().toLowerCase();
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(at + 1) : "";
}

/** True when `sender` (a bare lower-case address) is one of the row's To mailboxes. */
export function writtenTo(row: Pick<SentRow, "to">, sender: string): boolean {
  return splitAddressList(row.to).some((entry) => bareAddress(entry) === sender);
}

function sameOrg(sender: string, userAddresses: readonly string[]): boolean | null {
  if (userAddresses.length === 0) return null;
  const domain = domainOf(sender);
  if (!domain || isPublicMailboxDomain(domain)) return false;
  return userAddresses.some((a) => domainOf(bareAddress(a)) === domain);
}

type ThreadEvent = { at: number; kind: "in" | "out" };

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Per thread, walk the sender's mail and the user's replies in time order: a
 * reply answers the earliest inbound since the previous reply.
 */
export function medianReplyLatencyMs(
  sent: ReadonlyArray<{ sentAt: Date; threadId: string | null }>,
  inbound: readonly InboundRow[],
): number | null {
  const threads = new Map<string, ThreadEvent[]>();
  const add = (threadId: string | null, ev: ThreadEvent) => {
    if (!threadId) return;
    threads.set(threadId, [...(threads.get(threadId) ?? []), ev]);
  };
  for (const r of inbound) add(r.threadId, { at: r.receivedAt.getTime(), kind: "in" });
  for (const s of sent) add(s.threadId, { at: s.sentAt.getTime(), kind: "out" });

  const latencies: number[] = [];
  for (const events of threads.values()) {
    let waitingSince: number | null = null;
    for (const ev of [...events].sort((a, b) => a.at - b.at)) {
      if (ev.kind === "in") {
        waitingSince ??= ev.at;
        continue;
      }
      if (waitingSince !== null) {
        const gap = ev.at - waitingSince;
        if (gap <= MAX_REPLY_LATENCY_MS) latencies.push(gap);
      }
      waitingSince = null;
    }
  }
  return median(latencies);
}

export function buildRelationshipSnapshot(input: RelationshipInput): RelationshipSnapshot {
  const sender = bareAddress(input.senderAddress);
  const toSender = input.sent ? input.sent.filter((row) => writtenTo(row, sender)) : null;
  const lastSent = toSender?.reduce<Date | null>(
    (latest, row) => (latest === null || row.sentAt > latest ? row.sentAt : latest),
    null,
  );
  const pinned = input.pinnedTier === undefined ? null : input.pinnedTier !== null;
  const vip =
    input.senderCategory === undefined && input.pinnedTier === undefined
      ? null
      : VIP_CATEGORIES.has(input.senderCategory ?? "") || input.pinnedTier === "PUSH";
  return {
    sentCount: toSender ? toSender.length : null,
    lastSentAt: lastSent ? lastSent.toISOString() : null,
    medianReplyLatencyMs: toSender ? medianReplyLatencyMs(toSender, input.inbound) : null,
    sameOrgDomain: sameOrg(sender, input.userAddresses),
    coAttendanceNext14d: null,
    pinned,
    vip,
    dismissCount: input.dismissCount,
  };
}

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function isNullableNumber(v: unknown): v is number | null {
  return v === null || (typeof v === "number" && Number.isFinite(v));
}

function isNullableBoolean(v: unknown): v is boolean | null {
  return v === null || typeof v === "boolean";
}

/** Read a stored snapshot back; null when the JSON is not a valid snapshot. */
export function parseRelationshipSnapshot(raw: unknown): RelationshipSnapshot | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const lastSentAt = r.lastSentAt;
  const ok =
    isNullableNumber(r.sentCount) &&
    (lastSentAt === null || (typeof lastSentAt === "string" && ISO_UTC_RE.test(lastSentAt))) &&
    isNullableNumber(r.medianReplyLatencyMs) &&
    isNullableBoolean(r.sameOrgDomain) &&
    isNullableNumber(r.coAttendanceNext14d) &&
    isNullableBoolean(r.pinned) &&
    isNullableBoolean(r.vip) &&
    isNullableNumber(r.dismissCount);
  if (!ok) return null;
  return {
    sentCount: r.sentCount as number | null,
    lastSentAt: lastSentAt as string | null,
    medianReplyLatencyMs: r.medianReplyLatencyMs as number | null,
    sameOrgDomain: r.sameOrgDomain as boolean | null,
    coAttendanceNext14d: r.coAttendanceNext14d as number | null,
    pinned: r.pinned as boolean | null,
    vip: r.vip as boolean | null,
    dismissCount: r.dismissCount as number | null,
  };
}
