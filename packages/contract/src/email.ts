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

import type { LiveTier, TrustWire } from "./firewall.js";

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
  /**
   * Firewall lane for this message, normalized server-side — retired v1
   * values never reach the wire (AUTO folds to QUEUE, CALL to PUSH). null =
   * not judged yet; clients render no chip, never a guessed lane.
   */
  tier: LiveTier | null;
  /**
   * Why the message sits in its lane, resolved in the user's notification
   * language (a static reason key is localized; free text passes through).
   * Display-only, never a trust signal. null = no stored reason.
   */
  tierReason?: string | null;
  /**
   * Messages of this row's thread inside the requested view. Set only on a
   * thread-grouped page (`threads=1` with a lane), where the row is the
   * thread's newest message in the view; absent otherwise.
   */
  threadCount?: number;
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

/**
 * `GET /api/email` — the paged inbox list. With the opt-in `hideHandled=1`
 * (or `true`) it leaves out mail whose attention item is DISMISSED (Done) or
 * SNOOZED with a wake-up time still ahead (Later); `total` then counts the
 * same rows. Absent, the list is unchanged. `filter=candidates` cannot be
 * combined with it (400).
 *
 * With the opt-in `threads=1` (or `true`) together with a lane (`tier`, ALL
 * included, while lane reads are on) the page holds one row per thread — the
 * thread's newest message in the view, carrying `threadCount` — and `total`
 * counts threads. Without a lane `threads` is ignored.
 */
export interface EmailListResponse {
  emails: EmailListItem[];
  /** "gmail" = the real DB-backed inbox (any connected source, IMAP included). */
  source: "gmail" | "demo";
  /**
   * true when the user has no connected mail source at all (no Google token,
   * no linked or IMAP inbox). The answer is then empty — never demo mail.
   * `source` stays "demo" alongside it for older clients; absent otherwise.
   */
  needsConnection?: true;
  total: number;
  unread: number;
  page: number;
}

/** Mail in one lane: every message, and the unread ones among them. */
export interface EmailLaneCount {
  total: number;
  unread: number;
  /** Distinct threads in the lane (a thread's messages may span several stored tiers; counted once per folded lane). */
  threads: number;
}

/** One entry per live lane — retired values are folded server-side. */
export type EmailLaneCounts = Record<LiveTier, EmailLaneCount>;

/**
 * `GET /api/email/lane-counts?inbox=` — feeds Mail's lane control (MAIL_V2).
 * `inbox` scopes it to one connected account exactly as on the list.
 */
export interface EmailLaneCountsResponse {
  counts: EmailLaneCounts;
  source: "gmail" | "demo";
  /**
   * true when the user has no connected mail source at all (no Google token,
   * no linked or IMAP inbox). The answer is then empty — never demo mail.
   * `source` stays "demo" alongside it for older clients; absent otherwise.
   */
  needsConnection?: true;
}

/** A category the user can pin on a sender (`PUT /api/email/sender-labels`). */
export type SenderLabelCategory =
  | "internal"
  | "customer"
  | "investor"
  | "system"
  | "billing"
  | "promotions";

/** What a sender label covers: one address, or everyone at a domain. */
export type SenderLabelScope = "sender" | "domain";

/** Every category a row's relationship label can show (RowSignalWire). */
export type SenderLabelShown = SenderLabelCategory | "social" | "updates" | "forums";

/**
 * The reader's sender label: what a correction would target and what the
 * row shows now. The server derives `address` and `domain` — a client never
 * builds the domain itself.
 */
export interface ReaderSenderLabel {
  /** The lowercase address a "this address" correction targets. */
  address: string;
  /** The domain a "whole domain" correction targets; null for a public mail provider. */
  domain: string | null;
  /** The relationship label the row shows; null when it shows none. */
  current: SenderLabelShown | null;
  /** Which of the user's own corrections set `current`; null = derived from evidence. */
  correction: SenderLabelScope | null;
}

/**
 * `GET /api/email/:id/reader-context?tier=&inbox=&filter=&search=` — what the
 * Mail v2 reader header shows beyond the mail itself (MAIL_V2): the lane and
 * why, the account, the relationship facts that left the list row, and the
 * mail's neighbours in the list view it was opened from.
 */
export interface EmailReaderContextResponse {
  /** The recorded lane; null = not judged yet (never a guessed lane). */
  tier: LiveTier | null;
  /** Why that lane, in the user's notification language; null when none is recorded. */
  tierReason: string | null;
  /** null = the primary account; a string = the linked inbox it arrived in. */
  linkedInboxAccountId: string | null;
  /**
   * True only as a recorded fact: no reply history with this sender and no
   * category claim (a newsletter is never a "first contact").
   */
  firstContact: boolean;
  /** How many times the user has written to this sender; null when unknown. */
  repliedCount: number | null;
  /** The sender label and its correction targets; null when the From has no address (or demo mail). */
  senderLabel: ReaderSenderLabel | null;
  /** The mail just above this one in that view (newer); null at the top. */
  newerId: string | null;
  /** The mail just below this one in that view (older); null at the end. */
  olderId: string | null;
}

/**
 * Which mail service a connected inbox lives on. Mirrors the API's
 * InboxProviderName (Phase 1 of the multi-provider plan). Clients must treat
 * unknown values as "a provider without a full action surface" — new
 * providers may appear before every client updates.
 */
// KLORN: the Klorn address (step E1a of the unified platform plan).
export type InboxProvider = "GOOGLE" | "NAVER" | "ICLOUD" | "OUTLOOK" | "IMAP" | "KLORN";

/**
 * A mailbox the user can scope the list to. `id === null` is the primary
 * Google inbox; a string id is a linked secondary inbox.
 */
/** What a mailbox is FOR — declared by the user, never inferred. Feeds the
 *  analysis prompts (a personal inbox must not be scored as a work inbox). */
export type InboxPurpose = "work" | "personal" | "mixed";

export interface InboxOption {
  id: string | null;
  email: string | null;
  kind: "primary" | "linked";
  needsReconnect: boolean;
  provider: InboxProvider;
  /** Null until the user answers. */
  purpose: InboxPurpose | null;
}

/** `GET /api/email/inboxes` — the caller's mailboxes for the inbox selector. */
export interface InboxesResponse {
  inboxes: InboxOption[];
  /** The user's declared company email domains (lowercase hostnames) — a
   *  sender on one is 회사 as a recorded fact. Empty until declared. */
  companyDomains: string[];
  /** The user's own words about what matters ("investor mail first"),
   *  read by the lane judge and the analysis preamble. Null until set. */
  priorities: string | null;
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
  /**
   * true when the user has no connected mail source at all (no Google token,
   * no linked or IMAP inbox). The answer is then empty — never demo mail.
   * `source` stays "demo" alongside it for older clients; absent otherwise.
   */
  needsConnection?: true;
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

/** One thread I am waiting on — the latest thing I sent, unanswered. */
export interface WaitingOnItemWire {
  gmailId: string;
  threadId: string;
  to: string;
  subject: string;
  /** ISO — when I sent it. */
  sentAt: string;
  daysWaiting: number;
  /** "primary" | linked inbox id — where the live read must go. */
  inbox: string;
}

/** `GET /api/email/waiting-on?days=` — oldest wait first. */
export interface WaitingOnResponse {
  items: WaitingOnItemWire[];
  /** The floor that was applied (the request's `days`, or the default). */
  minDays: number;
}

/** How an unsubscribe is carried out, most automatic first. */
export type EmailUnsubscribeMethod = "one-click" | "mailto" | "link";

/**
 * `POST /api/email/:id/unsubscribe` — success payload. `done` is true when
 * Klorn unsubscribed on the user's behalf (RFC 8058 one-click POST, or a mailto
 * sent from the user's own account); `link` means nothing automatic worked and
 * `url` is the list's own page for the user to open.
 */
export type EmailUnsubscribeResponse =
  | { method: "one-click" | "mailto"; done: true }
  | { method: "link"; done: false; url: string };

/** One sender that mails the user through a list, in ONE connected account. */
export interface EmailSubscriptionWire {
  /** Normalized sender address (lowercased, display name stripped). */
  sender: string;
  /** Display name from the sender's From header, or null. */
  displayName: string | null;
  /** Linked inbox id; null = the primary account. Never merged across accounts. */
  linkedInboxAccountId: string | null;
  /** The account's address, when known. */
  accountLabel: string | null;
  /** Mail from this sender in this account, within the window. */
  count: number;
  unreadCount: number;
  /** ISO — newest mail from this sender in this account. */
  lastReceivedAt: string;
  /** The most automatic method any of this sender's mail offers. */
  method: EmailUnsubscribeMethod;
}

/** `GET /api/email/subscriptions` — senders by mail count, most first. */
export interface EmailSubscriptionsResponse {
  subscriptions: EmailSubscriptionWire[];
  /** The look-back window applied, in days. */
  windowDays: number;
}

/** `POST /api/email/subscriptions/unsubscribe` — success payload. */
export type EmailSubscriptionUnsubscribeResponse = EmailUnsubscribeResponse & {
  /** Messages archived (0 unless `archive` was requested). */
  archived: number;
  /** Messages whose archive failed. */
  archiveFailed: number;
};

/**
 * `POST /api/email/send` body — a brand-new message (not a reply).
 * `linkedInboxAccountId` picks the account it leaves from: absent / null /
 * "primary" = the primary inbox (as before the field existed); otherwise the id
 * of one of the caller's linked inboxes. An id that is not the caller's is 404
 * (never a silent primary send), a non-id value 400, and a linked mailbox whose
 * provider cannot send from Klorn 501.
 */
export interface SendEmailRequest {
  to: string;
  subject: string;
  body: string;
  linkedInboxAccountId?: string | null;
}

/**
 * The deterministic-floor receipt of a user-initiated send, added to the
 * success response of `POST /api/email/send` and `POST /api/email/:id/reply`
 * while MANUAL_SEND_RECEIPTS_ENABLED is on (absent otherwise). `payloadHash` is
 * `sendEmailPayloadHash({ to, subject, body })` (packages/api
 * judge/attention-floor.ts, schema `v`) over the bytes the provider received —
 * a client that hashes what its confirm sheet showed gets the same hex. `id` is
 * the server's SendReceipt row. No recipient or content is echoed.
 */
export interface SendReceiptWire {
  id: string;
  v: "v1";
  action: "send_email";
  payloadHash: string;
  /** ISO time the receipt was minted (the send's approval). */
  approvedAt: string;
}
