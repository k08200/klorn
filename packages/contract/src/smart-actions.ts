/**
 * Smart actions (`/api/smart-actions`, SMART_ACTIONS_ENABLED; packages/api
 * routes/smart-actions.ts): "Draft reply → Send" and "Add to calendar" for one
 * of the user's own mails. Clients show them only while `user.smartActions` is
 * true on GET /api/auth/me.
 */

import type { SendReceiptWire } from "./email.js";

/** POST /emails/:id/reply-draft — never sends. Show `body` verbatim and editable. */
export interface SmartReplyDraftWire {
  /** The original sender; the reply goes nowhere else. */
  to: string;
  subject: string;
  body: string;
  /** "proactive": Klorn wrote it ahead of time; "generated": written on this tap. */
  source: "proactive" | "generated";
}

/**
 * POST /emails/:id/reply. `payloadHash` is sendEmailPayloadHash of the
 * { to, subject, body } on screen; any difference from what would go out
 * refuses the send with 412 before anything is written or sent. The same bytes
 * to the same mail within 10 minutes are a repeat: 409, not sent again (a 409
 * may also be the provider refusing the send).
 */
export interface SmartReplySendRequest {
  body: string;
  payloadHash: string;
}

export interface SmartReplySendResponse {
  success: true;
  to: string;
  threaded: boolean;
  receipt: SendReceiptWire;
}

/** What the confirm card must ask before Save; never a guessed value. */
export type SmartEventQuestionWire =
  | { kind: "meridiem"; am: string; pm: string }
  | { kind: "time" }
  | { kind: "date" }
  | { kind: "when" };

export interface SmartExistingEventWire {
  id: string;
  title: string;
  startTime: string;
  endTime: string;
}

/** POST /emails/:id/event-proposal — never writes. */
export interface SmartEventProposalWire {
  title: string;
  /** `YYYY-MM-DD` in `timeZone`; null = ask which day. */
  date: string | null;
  /** `HH:MM` 24h in `timeZone`; null = ask (see `question`). */
  time: string | null;
  durationMinutes: number;
  location: string | null;
  timeZone: string;
  /** The mail's sentence the date was read from, verbatim. */
  quote: string;
  question: SmartEventQuestionWire | null;
  existing: SmartExistingEventWire[];
}

export interface SmartEventProposalResponse {
  /** null: the mail names no date or time. */
  proposal: SmartEventProposalWire | null;
}

/** POST /emails/:id/event — the Save tap; date/time in the user's timezone. */
export interface SmartEventCreateRequest {
  title: string;
  date: string;
  time: string;
  durationMinutes: number;
  location?: string;
  /** 10, 30 or 60 minutes before. */
  reminderMinutes?: number;
  /** Add even though `existing` overlaps (409 otherwise). */
  allowDuplicate?: boolean;
}

export interface SmartEventCreateResponse {
  event: { id: string; title: string; startTime: string; endTime: string };
  /** False when no Google calendar carried the reminder. */
  reminderSet: boolean;
  timeZone: string;
}

/** 409 from POST /emails/:id/event: the overlapping events, nothing written. */
export interface SmartEventDuplicateResponse {
  error: string;
  existing: SmartExistingEventWire[];
}
