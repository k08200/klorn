/**
 * How a user's reply threads into the mail it answers: the original's thread id,
 * In-Reply-To / References from its live RFC 822 headers, and, for a provider that
 * threads by the original's own id (OUTLOOK), that id. One definition for both
 * user-initiated reply sends, so they cannot drift:
 *   - POST /api/email/:id/reply (routes/email-replies.ts);
 *   - POST /api/email/send with `inReplyToEmailId` (routes/email-mutations.ts, the
 *     web AI-draft reply).
 *
 * `original` must be a row the server resolved for the caller (their own
 * EmailMessage), never ids from a request body. Every value here rides outside the
 * send receipt's v1 hash (send-receipt.ts): it changes where the message threads,
 * never the recipient, subject or body the user confirmed.
 */

import { replyTargetFor } from "./providers/reply-target.js";
import type { MailProviderActions, ReplyTarget, ReplyThreadingHeaders } from "./providers/types.js";

export interface ReplyOriginal {
  gmailId: string;
  threadId: string | null;
  linkedInboxAccountId: string | null;
}

export interface ReplyThreading extends ReplyThreadingHeaders, ReplyTarget {
  threadId: string | null;
}

/**
 * Read the original's threading headers on the account it lives on.
 * `getReplyHeaders` is best-effort by contract: missing headers mean the reply
 * threads by thread id only, never a failed send.
 */
export async function resolveReplyThreading(
  actions: Pick<MailProviderActions, "getReplyHeaders" | "nativeReply">,
  userId: string,
  original: ReplyOriginal,
): Promise<ReplyThreading> {
  const { messageId, references } = await actions.getReplyHeaders(
    userId,
    original.gmailId,
    original.linkedInboxAccountId,
  );
  // References = the original's chain + the original's Message-ID (RFC 5322).
  const referencesChain = [references, messageId].filter(Boolean).join(" ") || undefined;
  return {
    threadId: original.threadId,
    inReplyTo: messageId,
    references: referencesChain,
    ...replyTargetFor(actions, original.gmailId),
  };
}
