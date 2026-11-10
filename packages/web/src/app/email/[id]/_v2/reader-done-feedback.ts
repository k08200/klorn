/**
 * The Mail v2 header's Done (archive) also records the reply-needed judgment
 * the "Reply state" menu's Done used to send before #1483 moved Done to the
 * header: POST /api/email/:id/reply-needed/feedback { choice: "done" }, which
 * the API stores as the DISMISSED signal. The pure half — no React, no DOM —
 * so the api vitest suite pins it
 * (packages/api/src/__tests__/web-reader-done-feedback.test.ts).
 */

/** The reply state the header's Done stands for. */
export const HEADER_DONE_CHOICE = "done";

/**
 * Reply states the header itself owns (Later ⌄ and Done). A stored "later"
 * does not stop Done: in the old menu, picking Done after Later replaced it.
 */
const HEADER_OWNED_STATES: ReadonlySet<string> = new Set(["later"]);

export interface ReplyStateSeen {
  emailId: string;
  /** The latest reply state the menu loaded or saved for that mail. */
  choice: string;
}

export interface DoneFeedbackInput {
  /** The mail being archived (its canonical id, not a Gmail id). */
  emailId: string;
  /** The reply-needed judgment the menu (and so the old Done) was shown for. */
  needsReply: boolean;
  /** What the reply-state menu last knew, for whichever mail it was on. */
  replyState: ReplyStateSeen | null;
  /** The mail a Done feedback was already sent for in this view, if any. */
  sentFor: string | null;
}

export interface DoneFeedbackRequest {
  path: string;
  body: { choice: typeof HEADER_DONE_CHOICE };
}

/**
 * The feedback request a header Done sends, or null when it sends none:
 * - the mail was never judged reply-needed (the old Done was not on screen);
 * - a Done feedback already went out for this mail (no double-send);
 * - the user already chose a reply state in the menu ("needed", "waiting on
 *   them", …) or a Done is already stored — that explicit choice stands.
 */
export function doneFeedbackRequest(input: DoneFeedbackInput): DoneFeedbackRequest | null {
  if (!input.needsReply) return null;
  if (input.sentFor === input.emailId) return null;
  const seen = input.replyState?.emailId === input.emailId ? input.replyState.choice : null;
  if (seen !== null && !HEADER_OWNED_STATES.has(seen)) return null;
  return {
    path: `/api/email/${encodeURIComponent(input.emailId)}/reply-needed/feedback`,
    body: { choice: HEADER_DONE_CHOICE },
  };
}
