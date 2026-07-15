/**
 * Inbox Command Center summary types — `GET /api/inbox/summary`.
 *
 * The wire shapes now live in @klorn/contract, imported by BOTH the server
 * (packages/api/src/pim/inbox-summary.ts) and this client — the old
 * hand-mirrored copy behind a "keep in sync" comment is gone, so a contract
 * drift fails to compile instead of failing in production. Type-only re-export;
 * existing `@/lib/inbox-summary` importers are unchanged.
 */

export type {
  AttentionItem,
  DecisionDetails,
  DecisionEvidenceFact,
  EventItem,
  InboxSummary,
  TaskItem,
  TodaySection,
} from "@klorn/contract";

/**
 * Reply-needed email row — `GET /api/email` (reply-needed filter). Still a
 * local shape: its server side lives in the email routes and moves to
 * @klorn/contract in a later contract slice.
 */
export interface ReplyNeededEmail {
  id: string;
  subject: string;
  from: string;
  snippet: string | null;
  needsReplyReason: string | null;
  needsReplyConfidence: number;
  receivedAt: string;
}
