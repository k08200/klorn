/**
 * Relationship snapshot (docs/design/attention-engine-v3.md §3(2)): who the
 * sender is to the user, from data the product already has. No LLM.
 *
 * Pure over pre-fetched rows (the loader is relationship-loader.ts), so it can
 * be replayed and tested without a database. Every field is null when the data
 * to answer it does not exist, never 0: policy must be able to tell "unknown"
 * from "never".
 *
 * Per-user ego network only: every row read belongs to the one user, and one
 * user's mail never informs another's. Raw values only, no hand weights.
 *
 * coAttendanceNext14d is always null for now: CalendarEvent stores no
 * attendees (schema.prisma CalendarEvent), so co-attendance cannot be read from
 * data. interaction-graph.ts approximates it from email volume, which is not
 * what this field claims, so it is not reused here.
 */

import { isPlainAddress, parseAddress, splitAddressList } from "../../mail/email-address.js";
import { isPublicMailboxDomain } from "../../mail/public-mailbox-domains.js";
import {
  medianReplyLatencyMs,
  replyThreadCounts,
  userInitiatedThreadCount,
} from "./relationship-threads.js";

export { MAX_REPLY_LATENCY_MS, medianReplyLatencyMs } from "./relationship-threads.js";

export interface RelationshipSnapshot {
  /** Times the user wrote to the sender (within the scanned window). */
  sentCount: number | null;
  /** Last time the user wrote to the sender, ISO-8601 UTC. */
  lastSentAt: string | null;
  /** Median time from the sender's unanswered mail to the user's reply. */
  medianReplyLatencyMs: number | null;
  /** Sender shares a non-public mail domain with the user AND this mail passed
   * DMARC; null when the domain matches but authentication is unknown. */
  sameOrgDomain: boolean | null;
  /** Calendar events with the sender in the next 14 days. */
  coAttendanceNext14d: number | null;
  /** A PIN_TIER rule applies to the sender (address or domain). */
  pinned: boolean | null;
  /** Labelled investor/customer, or pinned to PUSH. */
  vip: boolean | null;
  /** Times the user dismissed the sender's items. */
  dismissCount: number | null;
  /** Mails from the sender (within the scanned window). */
  inboundCount: number | null;
  /** Threads holding the sender's mail. */
  inboundThreadCount: number | null;
  /** Of those, threads where the user wrote after the sender's first mail. Raw
   * count: the importance model smooths the rate, 1/1 is not "100%". */
  repliedThreadCount: number | null;
  /** Threads the user started with the sender. */
  userInitiatedThreadCount: number | null;
  /** First contact either way, ISO-8601 UTC (tenure; new-sender flag). */
  firstSeenAt: string | null;
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
  /** The sender's recent mail (any thread); null = lookup unavailable. */
  inbound: readonly InboundRow[] | null;
  /** The user's sends (to anyone) in the sender's threads, for the reply rate. */
  userSentInSenderThreads: readonly { sentAt: Date; threadId: string | null }[] | null;
  /** Earliest mail from the sender / to the sender; null = none, undefined = unknown. */
  firstInboundAt: Date | null | undefined;
  firstSentAt: Date | null | undefined;
  /** This mail passed DMARC (or aligned SPF+DKIM); null = unknown. */
  senderAuthenticated: boolean | null;
  dismissCount: number | null;
  /** PIN_TIER for the sender: a tier, null = none, undefined = unknown. */
  pinnedTier: string | null | undefined;
  /** SenderLabel category: a category, null = none, undefined = unknown. */
  senderCategory: string | null | undefined;
}

const VIP_CATEGORIES = new Set(["investor", "customer"]);

/** The bare lower-case mailbox of a header value, or "" when it has none. */
export function senderMailbox(value: string): string {
  const address = parseAddress(value).trim().toLowerCase();
  return isPlainAddress(address) ? address : "";
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(at + 1) : "";
}

/** True when `sender` (a bare lower-case address) is one of the row's To mailboxes. */
export function writtenTo(row: Pick<SentRow, "to">, sender: string): boolean {
  return splitAddressList(row.to).some((entry) => senderMailbox(entry) === sender);
}

/**
 * Same organisation only when it is not a public mailbox domain and this mail
 * is authenticated: a lookalike or spoofed same-org sender must not be lifted
 * (CEO fraud). Unauthenticated same-domain mail is unknown (null), not false.
 */
function sameOrg(
  sender: string,
  userAddresses: readonly string[],
  authenticated: boolean | null,
): boolean | null {
  if (userAddresses.length === 0) return null;
  const domain = domainOf(sender);
  if (!domain || isPublicMailboxDomain(domain)) return false;
  const shared = userAddresses.some((a) => domainOf(senderMailbox(a)) === domain);
  if (!shared) return false;
  return authenticated === true ? true : null;
}

function earliestIso(...dates: (Date | null | undefined)[]): string | null {
  const known = dates.filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()));
  if (known.length === 0) return null;
  return new Date(Math.min(...known.map((d) => d.getTime()))).toISOString();
}

const timedSent = (rows: readonly { sentAt: Date; threadId: string | null }[]) =>
  rows.map((r) => ({ at: r.sentAt, threadId: r.threadId }));
const timedIn = (rows: readonly InboundRow[]) =>
  rows.map((r) => ({ at: r.receivedAt, threadId: r.threadId }));

function sentFields(toSender: SentRow[] | null, inbound: readonly InboundRow[] | null) {
  if (!toSender) {
    return {
      sentCount: null,
      lastSentAt: null,
      medianReplyLatencyMs: null,
      userInitiatedThreadCount: null,
    };
  }
  const last = toSender.reduce<Date | null>(
    (l, r) => (l === null || r.sentAt > l ? r.sentAt : l),
    null,
  );
  return {
    sentCount: toSender.length,
    lastSentAt: last ? last.toISOString() : null,
    medianReplyLatencyMs: medianReplyLatencyMs(timedSent(toSender), timedIn(inbound ?? [])),
    userInitiatedThreadCount: inbound
      ? userInitiatedThreadCount(timedSent(toSender), timedIn(inbound))
      : null,
  };
}

function inboundFields(input: RelationshipInput) {
  if (!input.inbound) {
    return { inboundCount: null, inboundThreadCount: null, repliedThreadCount: null };
  }
  const counts = input.userSentInSenderThreads
    ? replyThreadCounts(timedIn(input.inbound), timedSent(input.userSentInSenderThreads))
    : { inboundThreadCount: null, repliedThreadCount: null };
  return { inboundCount: input.inbound.length, ...counts };
}

export function buildRelationshipSnapshot(input: RelationshipInput): RelationshipSnapshot {
  const sender = senderMailbox(input.senderAddress);
  if (!sender) return { ...UNKNOWN_RELATIONSHIP };
  const toSender = input.sent ? input.sent.filter((row) => writtenTo(row, sender)) : null;
  const vip =
    input.senderCategory === undefined && input.pinnedTier === undefined
      ? null
      : VIP_CATEGORIES.has(input.senderCategory ?? "") || input.pinnedTier === "PUSH";
  return {
    ...sentFields(toSender, input.inbound),
    sameOrgDomain: sameOrg(sender, input.userAddresses, input.senderAuthenticated),
    coAttendanceNext14d: null,
    pinned: input.pinnedTier === undefined ? null : input.pinnedTier !== null,
    vip,
    dismissCount: input.dismissCount,
    ...inboundFields(input),
    firstSeenAt: earliestIso(input.firstInboundAt, input.firstSentAt),
  };
}

export const UNKNOWN_RELATIONSHIP: RelationshipSnapshot = {
  sentCount: null,
  lastSentAt: null,
  medianReplyLatencyMs: null,
  sameOrgDomain: null,
  coAttendanceNext14d: null,
  pinned: null,
  vip: null,
  dismissCount: null,
  inboundCount: null,
  inboundThreadCount: null,
  repliedThreadCount: null,
  userInitiatedThreadCount: null,
  firstSeenAt: null,
};

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function isNullableNumber(v: unknown): v is number | null {
  return v === null || (typeof v === "number" && Number.isFinite(v));
}

function isNullableBoolean(v: unknown): v is boolean | null {
  return v === null || typeof v === "boolean";
}

const NUMBER_FIELDS = [
  "sentCount",
  "medianReplyLatencyMs",
  "coAttendanceNext14d",
  "dismissCount",
  "inboundCount",
  "inboundThreadCount",
  "repliedThreadCount",
  "userInitiatedThreadCount",
] as const;
const BOOLEAN_FIELDS = ["sameOrgDomain", "pinned", "vip"] as const;
const DATE_FIELDS = ["lastSentAt", "firstSeenAt"] as const;

/** Read a stored snapshot back; null when the JSON is not a valid snapshot.
 * Fields added after a row was written read as null (unknown). */
export function parseRelationshipSnapshot(raw: unknown): RelationshipSnapshot | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const get = (k: string) => (r[k] === undefined ? null : r[k]);
  const ok =
    NUMBER_FIELDS.every((k) => isNullableNumber(get(k))) &&
    BOOLEAN_FIELDS.every((k) => isNullableBoolean(get(k))) &&
    DATE_FIELDS.every((k) => {
      const v = get(k);
      return v === null || (typeof v === "string" && ISO_UTC_RE.test(v));
    });
  if (!ok) return null;
  const out: Record<string, unknown> = {};
  for (const k of [...NUMBER_FIELDS, ...BOOLEAN_FIELDS, ...DATE_FIELDS]) out[k] = get(k);
  return out as unknown as RelationshipSnapshot;
}
