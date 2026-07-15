/**
 * Inbox Command Center summary types — `GET /api/inbox/summary`.
 *
 * The wire shapes now live in @klorn/contract, imported by BOTH the server
 * (packages/api/src/pim/inbox-summary.ts) and this client — the old
 * hand-mirrored copy behind a "keep in sync" comment is gone, so a contract
 * drift fails to compile instead of failing in production. Type-only re-export;
 * existing `@/lib/inbox-summary` importers are unchanged.
 */

// Reply-needed rail — `GET /api/inbox/reply-needed`. Same single-source deal.
export type {
  AttentionItem,
  DecisionDetails,
  DecisionEvidenceFact,
  EventItem,
  InboxSummary,
  ReplyNeededEmail,
  ReplyNeededResponse,
  TaskItem,
  TodaySection,
} from "@klorn/contract";
