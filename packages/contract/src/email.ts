/**
 * Wire contract for the mail list surface under `/api/email` — the inbox
 * list, thread view, mailbox selector, bulk actions, and undoable row
 * actions. Built by packages/api/src/routes/email.ts (+ email-bulk.ts,
 * email-mutations.ts); rendered by the web inbox (app/email/page.tsx).
 * Both sides import these types, so a shape change that would desync
 * server and client fails to compile instead of failing in production.
 *
 * Drift this contract caught on arrival: the server's thread rows never
 * included `summary` on the real (Gmail) path — the web list had been
 * declaring and rendering a field only demo mode sent.
 */

import type { TrustWire } from "./firewall.js";

export type EmailPriority = "URGENT" | "NORMAL" | "LOW";

/** Candidate-intake pipeline status (résumé / profile emails). */
export type CandidateIntakeStatus =
  | "NEEDS_ANALYSIS"
  | "NEEDS_INFO"
  | "READY_TO_REVIEW"
  | "REVIEWING"
  | "CONTACTED"
  | "SHORTLISTED"
  | "REJECTED"
  | "ARCHIVED";

export interface CandidateIntakeEvidenceFile {
  filename: string;
  category: string | null;
  summary: string | null;
  analysisStatus: string | null;
  needsManualReview: boolean;
  reviewReason: string | null;
}

/** A candidate-intake row as serialized on the wire (dates are ISO strings). */
export interface CandidateIntakeWire {
  id: string;
  emailId: string;
  status: CandidateIntakeStatus;
  name: string | null;
  role: string | null;
  contact: string | null;
  emailAddress: string | null;
  phone: string | null;
  summary: string;
  confidence: number;
  missingFields: string[];
  evidenceFiles: CandidateIntakeEvidenceFile[];
  notes: string | null;
  lastDetectedAt: string;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  duplicateKey: string | null;
  duplicateCount: number;
  duplicateEmailIds: string[];
  duplicateReasons: string[];
}

/** Compact candidate preview attached to list rows (full row: candidateIntake). */
export interface CandidateProfilePreview {
  name: string | null;
  role: string | null;
  contact: string | null;
  summary: string;
  missingFields: string[];
  confidence: number;
  evidenceCount: number;
  intakeStatus: string | null;
}

export interface EmailListItem {
  id: string;
  gmailId: string;
  threadId: string | null;
  /**
   * null = the primary Google inbox; a string = the linked secondary inbox
   * this message arrived in. Clients map this to a per-message inbox badge.
   */
  linkedInboxAccountId: string | null;
  from: string;
  senderEmail: string | null;
  trust: TrustWire | null;
  to: string;
  subject: string;
  snippet: string | null;
  date: string;
  labels: string[];
  isRead: boolean;
  isStarred: boolean;
  priority: EmailPriority;
  category: string | null;
  summary: string | null;
  keyPoints: string[];
  actionItems: string[];
  sentiment: string | null;
  needsReply: boolean;
  attachmentCount: number;
  attachmentCandidateCount: number;
  attachmentPendingCount: number;
  attachmentFallbackCount: number;
  attachmentUnsupportedCount: number;
  attachmentCategories: string[];
  candidateProfilePreview: CandidateProfilePreview | null;
  candidateIntake: CandidateIntakeWire | null;
}

/** `GET /api/email` — the paged inbox list. */
export interface EmailListResponse {
  emails: EmailListItem[];
  source: "gmail" | "demo";
  total: number;
  unread: number;
  page: number;
}

/**
 * A mailbox the user can scope the list to. `id === null` is the primary
 * Google inbox; a string id is a linked secondary inbox.
 */
export interface InboxOption {
  id: string | null;
  email: string | null;
  kind: "primary" | "linked";
  needsReconnect: boolean;
}

/** `GET /api/email/inboxes` — the caller's mailboxes for the inbox selector. */
export interface InboxesResponse {
  inboxes: InboxOption[];
}

export interface EmailThreadRow {
  threadId: string;
  subject: string;
  participants: string[];
  messageCount: number;
  hasUnread: boolean;
  latestPriority: EmailPriority;
  /** AI summary of the latest message in the thread. */
  summary: string | null;
  lastMessage: {
    id: string;
    from: string;
    snippet: string | null;
    receivedAt: string;
    isRead: boolean;
  };
}

/** `GET /api/email/threads` — the grouped thread view. */
export interface EmailThreadListResponse {
  threads: EmailThreadRow[];
  source: "gmail" | "demo";
  total: number;
  page: number;
}

/** `POST /api/email/bulk` — success payload (errors are `{ error }` with 4xx). */
export interface EmailBulkActionResponse {
  success: boolean;
  updatedCount: number;
  failed: Array<{ id: string; error: string }>;
}

/** `POST /api/email/:id/{archive,delete}/undo` — success payload. */
export interface EmailUndoActionResponse {
  success: boolean;
  gmailId: string;
  emailId: string;
}
