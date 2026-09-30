/**
 * MailProviderActions — the provider-agnostic action surface of a mailbox
 * (Phase 1 of docs/providers/multi-provider-plan.md).
 *
 * Result contract, in caller-priority order:
 *   - `{ unsupported: true }` — this provider has no implementation of the
 *     action. Routes map it to 501. It is deliberately NOT a plain `{ error }`:
 *     callers treat `{ error }` as "account not connected" and fall back to
 *     local-only writes, and doing that for an unsupported provider is the
 *     false-200/resurrection bug Phase 0b fixed.
 *   - `{ error }` — the provider tried and failed softly (not connected, bad
 *     address). Callers keep their existing fallback semantics.
 *   - `{ success: true, … }` — the action reached the real mailbox.
 * Hard failures (network, 5xx) still throw, as the Gmail module does today.
 */

import type { InboxProviderName } from "../inbox-credentials.js";

export type MailActionUnsupported = { unsupported: true; error: string };
export type MailActionFailure = { error: string };

export type SimpleMailActionResult = { success: true } | MailActionFailure | MailActionUnsupported;

export type SendMailResult =
  | {
      success: true;
      messageId?: string | null;
      threadId?: string | null;
      /**
       * True only when the provider itself threaded the message to its original
       * (OUTLOOK's native reply, step B0b). Absent otherwise: a header-path provider
       * reports threading through the headers it was given, not through this field.
       */
      threaded?: boolean;
    }
  | MailActionFailure
  | MailActionUnsupported;

export type CreateDraftResult =
  | { success: true; draftId?: string | null; messageId?: string | null; url: string }
  | MailActionFailure
  | MailActionUnsupported;

/** Best-effort by contract: `{}` when headers can't be read — never an error. */
export type ReplyHeadersResult = { messageId?: string; references?: string };

export interface MailAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

/**
 * RFC 5322 threading headers of a reply. Values are untrusted `Message-ID`
 * text. An implementation that writes them into a header must go through
 * `mail/reply-headers.ts`, which parses message ids and drops everything else.
 * Absent means "not a reply": the message carries no threading headers.
 */
export interface ReplyThreadingHeaders {
  inReplyTo?: string;
  references?: string;
}

/**
 * Names the message being answered, for a provider that threads a reply by the
 * original's own id instead of by header text (OUTLOOK, step B0b). The value is the
 * original's `EmailMessage.gmailId`, taken from a row the SERVER resolved for the
 * caller and their linked account: never from an agent, a request body or a URL.
 * Callers add it with `replyTargetFor` (reply-target.ts), which adds nothing for a
 * provider without `nativeReply`, so the options a Gmail or IMAP provider receives
 * are unchanged.
 */
export interface ReplyTarget {
  replyToProviderMessageId?: string;
}

export interface SendMailOptions extends ReplyThreadingHeaders, ReplyTarget {
  threadId?: string | null;
  linkedInboxAccountId?: string | null;
}

/** Everything `createDraft` needs besides the acting user. */
export interface CreateDraftInput extends ReplyTarget {
  to: string;
  subject: string;
  body: string;
  threadId?: string | null;
  attachments?: MailAttachment[];
  linkedInboxAccountId?: string | null;
  reply?: ReplyThreadingHeaders;
}

/**
 * `messageId` below is the provider-side message id stored in
 * `EmailMessage.gmailId` — Gmail's native id for GOOGLE, the synthetic
 * `<idPrefix>:<email>:<uid>` for IMAP providers (naver-imap:, icloud-imap:). `linkedInboxAccountId` stays an
 * explicit parameter (repo doctrine: thread the account id end-to-end, never
 * assume the primary).
 */
export interface MailProviderActions {
  readonly provider: InboxProviderName;
  /**
   * True when `sendEmail` and `createDraft` thread a reply natively from
   * `replyToProviderMessageId` (OUTLOOK). Such a provider answers `{}` from
   * `getReplyHeaders`: its threading does not go through headers. Absent for every
   * other provider.
   */
  readonly nativeReply?: boolean;
  sendEmail(
    userId: string,
    to: string,
    subject: string,
    body: string,
    attachments?: MailAttachment[],
    options?: SendMailOptions,
  ): Promise<SendMailResult>;
  createDraft(userId: string, draft: CreateDraftInput): Promise<CreateDraftResult>;
  getReplyHeaders(
    userId: string,
    messageId: string,
    linkedInboxAccountId?: string | null,
  ): Promise<ReplyHeadersResult>;
  markAsRead(
    userId: string,
    messageId: string,
    linkedInboxAccountId?: string | null,
  ): Promise<SimpleMailActionResult>;
  toggleRead(
    userId: string,
    messageId: string,
    isRead: boolean,
    linkedInboxAccountId?: string | null,
  ): Promise<SimpleMailActionResult>;
  toggleStar(
    userId: string,
    messageId: string,
    starred: boolean,
    linkedInboxAccountId?: string | null,
  ): Promise<SimpleMailActionResult>;
  trash(
    userId: string,
    messageId: string,
    linkedInboxAccountId?: string | null,
  ): Promise<SimpleMailActionResult>;
  untrash(
    userId: string,
    messageId: string,
    linkedInboxAccountId?: string | null,
  ): Promise<SimpleMailActionResult>;
  archive(
    userId: string,
    messageId: string,
    linkedInboxAccountId?: string | null,
  ): Promise<SimpleMailActionResult>;
  unarchive(
    userId: string,
    messageId: string,
    linkedInboxAccountId?: string | null,
  ): Promise<SimpleMailActionResult>;
}
