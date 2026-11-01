/**
 * Input types for policy v3 (docs/design/attention-engine-v3.md §3(1), §3(2)).
 *
 * Facts schema v1 is owned by the P2 extractor (`facts-schema.ts`) and
 * re-exported here so the policy modules have one import site.
 *
 * `RelationshipSnapshot` mirrors §3(2) field for field until the P2 store
 * (`relationship.ts`, #1589) merges; then this mirror is replaced by that
 * import. `null` means unknown, never zero.
 */

export {
  ADDRESSED_TO,
  type AddressedTo,
  ASK_KINDS,
  type AskKind,
  type FactAsk,
  type FactEvent,
  type FactsV1,
  type FactTransaction,
  MAIL_KINDS,
  type MailKind,
  RISKS,
  type Risk,
  THREAD_TURNS,
  type ThreadTurn,
  TRANSACTION_KINDS,
  type TransactionKind,
} from "./facts-schema.js";

/** Relationship snapshot (§3(2)). `null` means unknown, never zero. */
export interface RelationshipSnapshot {
  sentCount: number | null;
  /** ISO 8601. */
  lastSentAt: string | null;
  medianReplyLatencyMs: number | null;
  sameOrgDomain: boolean | null;
  coAttendanceNext14d: number | null;
  pinned: boolean | null;
  vip: boolean | null;
  dismissCount: number | null;
}
