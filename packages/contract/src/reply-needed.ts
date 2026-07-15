/**
 * Wire contract for the reply-needed rail — `GET /api/inbox/reply-needed`.
 * Built by packages/api/src/routes/inbox.ts; rendered by the Command Center
 * sidebar. Both sides import these types, so a shape change that would
 * desync server and client fails to compile instead of failing in production.
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

export interface ReplyNeededResponse {
  emails: ReplyNeededEmail[];
}
