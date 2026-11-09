/**
 * The request the reply-draft panel's Send makes. The user may edit the AI
 * draft's recipient and subject, so it goes through POST /api/email/send with
 * exactly the bytes they confirmed — not POST /:id/reply, which derives both
 * itself. `inReplyToEmailId` names the mail being answered so the API records
 * the reply the way /:id/reply does: the reply chip, REPLIED on the decision
 * ledger, the thread. The API checks the id is the caller's own mail. No account
 * is named: the API sends from the inbox that mail arrived in (a linked inbox's
 * mail is answered from that address, as POST /:id/reply does).
 *
 * The pure half — no React, no DOM — so the api vitest suite pins it
 * (packages/api/src/__tests__/web-reply-draft-send.test.ts).
 */

import type { SendEmailRequest } from "@klorn/contract";

export const SEND_PATH = "/api/email/send";

/** What the user confirmed in the draft panel. */
export interface ReplyDraftBytes {
  to: string;
  subject: string;
  body: string;
}

export interface ReplyDraftSendRequest {
  path: typeof SEND_PATH;
  body: SendEmailRequest & { inReplyToEmailId: string };
}

/** `emailId` is the answered mail's canonical id (EmailDetail.id), not a Gmail id. */
export function replyDraftSendRequest(
  emailId: string,
  draft: ReplyDraftBytes,
): ReplyDraftSendRequest {
  return {
    path: SEND_PATH,
    body: { to: draft.to, subject: draft.subject, body: draft.body, inReplyToEmailId: emailId },
  };
}
