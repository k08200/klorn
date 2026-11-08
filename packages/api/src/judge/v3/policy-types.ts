/**
 * Input types for policy v3 (docs/design/attention-engine-v3.md §3(1), §3(2)),
 * re-exported from their P2 owners so the policy modules have one import site.
 * Facts schema v1 comes from the extractor (`facts-schema.ts`).
 *
 * `RelationshipSnapshot` comes from the P2 relationship layer
 * (`relationship.ts`, #1589). `null` means unknown, never zero.
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

export type { RelationshipSnapshot } from "./relationship.js";
