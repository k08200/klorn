/**
 * Type definitions shared between page.tsx and its sibling components
 * (atoms.tsx, toolbar.tsx, etc.). Pulled out 2026-05-19 so each
 * extracted component can import the exact slice of the email-detail
 * domain it needs without going through page.tsx.
 *
 * Nothing here imports React or any runtime — pure types only.
 */

export type EmailPriority = "URGENT" | "NORMAL" | "LOW";

export interface EmailAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number | null;
  summary: string | null;
  textPreview: string | null;
  keyPoints: string[];
  extractedFields: Record<string, string | number | boolean | null>;
  category: string | null;
  analysisStatus: string;
  analysisError: string | null;
}

export interface AttachmentCandidateProfile {
  detected: boolean;
  pipelineStatus: "ready_to_review" | "needs_info" | "needs_analysis";
  nextAction: string;
  name: string | null;
  role: string | null;
  contact: string | null;
  email: string | null;
  phone: string | null;
  age: string | null;
  height: string | null;
  skills: string[];
  links: string[];
  summary: string;
  evidenceFiles: Array<{
    filename: string;
    category: string | null;
    summary: string | null;
    analysisStatus: string;
    needsManualReview: boolean;
    reviewReason: string | null;
  }>;
  manualReviewFiles: Array<{
    filename: string;
    status: string;
    reason: string;
  }>;
  missingFields: string[];
  confidence: number;
}

export type CandidateIntakeStatus =
  | "NEEDS_ANALYSIS"
  | "NEEDS_INFO"
  | "READY_TO_REVIEW"
  | "REVIEWING"
  | "CONTACTED"
  | "SHORTLISTED"
  | "REJECTED"
  | "ARCHIVED";

export interface CandidateIntake {
  id: string;
  emailId: string;
  status: CandidateIntakeStatus;
  notes: string | null;
  updatedAt: string;
}

export interface ReplyDraft {
  to: string;
  subject: string;
  body: string;
  candidateProfile: AttachmentCandidateProfile | null;
}

export interface UndoActionResponse {
  success: boolean;
  gmailId: string;
  emailId: string;
}

/**
 * EmailDetail is the response shape from GET /api/email/:id. Several
 * fields are server-derived (`attachments`, `candidateProfile`,
 * `candidateIntake`) and arrive only when the email actually has them.
 */
export interface EmailDetail {
  id: string;
  gmailId: string;
  threadId?: string | null;
  from: string;
  to: string;
  cc: string | null;
  subject: string;
  body: string | null;
  snippet: string | null;
  date: string;
  priority: EmailPriority;
  category: string | null;
  summary: string | null;
  keyPoints: string[];
  actionItems: string[];
  sentiment: string | null;
  isRead?: boolean;
  isStarred?: boolean;
  needsReply?: boolean;
  attachmentCount?: number;
  attachments?: EmailAttachment[];
  candidateProfile?: AttachmentCandidateProfile | null;
  candidateIntake?: CandidateIntake | null;
}

export type UndoableEmailAction = "archive" | "delete";

export interface UndoNotice {
  action: UndoableEmailAction;
  gmailId: string;
  subject: string | null;
}

export type EmailReminderKey = "later-today" | "tomorrow" | "next-week";

export interface EmailReminderOption {
  key: EmailReminderKey;
  label: string;
}

export const EMAIL_REMINDER_OPTIONS: EmailReminderOption[] = [
  { key: "later-today", label: "Later today" },
  { key: "tomorrow", label: "Tomorrow" },
  { key: "next-week", label: "Next week" },
];

export interface NextEmailSummary {
  id: string;
  from: string;
  subject: string;
  date: string;
  isRead: boolean;
  priority: EmailPriority;
  needsReply: boolean;
}
