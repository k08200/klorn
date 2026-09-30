/**
 * `create_draft` — an MCP agent drafts a reply to one email (step A4 of
 * docs/providers/unified-platform-plan.md). MCP-only: the definition lives here
 * and is NOT in ALL_TOOLS (that would hand it to the autonomous agent) or
 * CHAT_TOOL_NAMES (that would hand it to chat); mcp/tool-gate.ts adds it to the
 * write set and mcp/write-call.ts runs it, so the A2a gate, audit row and per-user
 * write cap apply unchanged (plus a lower cap of its own, in write-call.ts).
 *
 * What the agent can and cannot decide:
 *  - It decides the WORDS: `body` (plain text) and, optionally, `subject`.
 *  - It never decides where the draft goes. There is no recipient argument: the
 *    draft's To is the original message's From address, parsed and validated here
 *    (mail/single-address.ts), exactly as the human reply route does. Reply-To is
 *    deliberately NOT honoured: the sender controls it, so it could route an agent
 *    draft to a third party. A hostile mail that talks the agent into naming another
 *    recipient gets an INVALID_ARGUMENT, not a draft.
 *  - It never supplies threading. The reply headers are read from the provider for
 *    the original message (`getReplyHeaders`) and the thread id comes from the
 *    row. Any header-shaped argument is refused.
 *  - It never picks the account. The email row names its linked inbox account (or
 *    the primary, which is `null`), and that id is threaded through every call:
 *    a row that names another account is never drafted on the primary.
 *  - It never sends. This module holds no send call, and a draft is only ever
 *    written to the user's own Drafts folder, where a human reviews it.
 *
 * Asking again for the same draft (same email, body and subject) inside a short
 * window returns the first draft instead of creating another (mcp/draft-dedupe.ts).
 *
 * Outlook answers unsupported until B0b: a draft made through Graph's plain
 * message endpoint cannot carry In-Reply-To, so it would not thread. A provider
 * with no draft support answers its own unsupported result, unchanged.
 */

import { findUserEmail, MAX_EMAIL_ID_LENGTH, parseEmailIdArg } from "../mail/email-lookup.js";
import { exceedsCodePoints } from "../mail/header-text.js";
import type { InboxProviderName } from "../mail/inbox-credentials.js";
import { mailActionsFor } from "../mail/providers/dispatch.js";
import type { ReplyHeadersResult, ReplyThreadingHeaders } from "../mail/providers/types.js";
import { checkedSubject, MAX_SUBJECT_LENGTH, replySubject } from "../mail/reply-subject.js";
import { parseSingleAddress } from "../mail/single-address.js";
import { captureError } from "../sentry.js";
import { draftKey, findRecentDraft, type RememberedDraft, rememberDraft } from "./draft-dedupe.js";
import { auditIdOf, type DraftIdentity, sha256Hex } from "./write-audit.js";

export const CREATE_DRAFT_TOOL_NAME = "create_draft";

/** Longest draft body, in code points (what the schema's maxLength counts). Proposed value: a long reply, far below what a mailbox accepts. */
export const MAX_DRAFT_BODY_LENGTH = 20_000;

/** The only arguments the tool takes. Anything else is refused, so nothing can ride along. */
const ALLOWED_ARGUMENTS: ReadonlySet<string> = new Set(["email_id", "body", "subject"]);

/** Providers whose drafts cannot thread yet, so an agent draft there would not be a reply. */
const UNTHREADED_DRAFT_PROVIDERS: ReadonlySet<InboxProviderName> = new Set(["OUTLOOK"]);

export const CREATE_DRAFT_TOOL = {
  type: "function" as const,
  function: {
    name: CREATE_DRAFT_TOOL_NAME,
    description:
      "Save a reply DRAFT to one email, in the mailbox the email arrived in. The draft is never " +
      "sent: the user reviews and sends it. It always goes to the original sender and is threaded " +
      "to the original message by the server, so neither the recipient nor the reply headers can " +
      "be chosen. Plain text only, no attachments. Asking again for the same draft returns the " +
      "first one. Not available for Outlook mailboxes yet.",
    parameters: {
      type: "object",
      properties: {
        email_id: {
          type: "string",
          description: "The email to reply to, as returned by list_emails or read_email.",
        },
        body: {
          type: "string",
          minLength: 1,
          maxLength: MAX_DRAFT_BODY_LENGTH,
          description: "The reply text, plain text.",
        },
        subject: {
          type: "string",
          minLength: 1,
          maxLength: MAX_SUBJECT_LENGTH,
          description: 'Optional, one line. Defaults to "Re: " followed by the original subject.',
        },
      },
      required: ["email_id", "body"],
      additionalProperties: false,
    },
  },
};

/** The caller: the user whose mailbox the draft is written to. */
export interface CreateDraftContext {
  userId: string;
}

/** A validated call. There is deliberately no recipient, header, account or attachment field. */
export interface ReplyDraftInput {
  emailId: string;
  body: string;
  /** The agent's own subject, or null to derive `Re: <original>`. */
  subject: string | null;
}

type CreateDraftErrorCode = "INVALID_ARGUMENT" | "NOT_FOUND" | "NO_REPLY_ADDRESS" | "UNAVAILABLE";

const ARGUMENTS_ERROR = "create_draft takes email_id, body and optionally subject, as an object.";
const FIXED_FIELDS_ERROR =
  "create_draft accepts only email_id, body and subject. The recipient, the thread, the account " +
  "and the reply headers are always taken from the original email.";
const EMAIL_ID_ERROR = `email_id must be a non-empty string of at most ${MAX_EMAIL_ID_LENGTH} characters.`;
const BODY_ERROR = `body must be non-empty plain text of at most ${MAX_DRAFT_BODY_LENGTH} characters, with no NUL characters.`;
const SUBJECT_ERROR = `subject must be one line of 1 to ${MAX_SUBJECT_LENGTH} characters, with no line breaks or control characters.`;
const NOT_FOUND_ERROR = "No email with this id in your inbox.";
const NO_REPLY_ADDRESS_ERROR =
  "This email has no single valid sender address to reply to, so no draft was made.";
const UNSUPPORTED_THREADING_ERROR =
  "This mailbox's provider does not support threaded drafts from Klorn yet.";
const UNAVAILABLE_ERROR =
  "The draft could not be created. Check the Drafts folder before trying again.";

const fail = (code: CreateDraftErrorCode, error: string): string => JSON.stringify({ error, code });

type ParsedArgs = { ok: true; input: ReplyDraftInput } | { ok: false; error: string };

function isValidBody(raw: unknown): raw is string {
  return (
    typeof raw === "string" &&
    raw.trim().length > 0 &&
    !exceedsCodePoints(raw, MAX_DRAFT_BODY_LENGTH) &&
    !raw.includes("\u0000")
  );
}

/** Undefined or null means "derive it"; anything else must be an acceptable subject. */
function parseSubject(raw: unknown): { ok: true; subject: string | null } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, subject: null };
  const subject = typeof raw === "string" ? checkedSubject(raw) : null;
  return subject === null ? { ok: false } : { ok: true, subject };
}

function parseArgs(args: unknown): ParsedArgs {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { ok: false, error: ARGUMENTS_ERROR };
  }
  const given = args as Record<string, unknown>;
  if (Object.keys(given).some((key) => !ALLOWED_ARGUMENTS.has(key))) {
    return { ok: false, error: FIXED_FIELDS_ERROR };
  }
  const emailId = parseEmailIdArg(given.email_id);
  if (emailId === null) return { ok: false, error: EMAIL_ID_ERROR };
  if (!isValidBody(given.body)) return { ok: false, error: BODY_ERROR };
  const subject = parseSubject(given.subject);
  if (!subject.ok) return { ok: false, error: SUBJECT_ERROR };
  return { ok: true, input: { emailId, body: given.body, subject: subject.subject } };
}

const ORIGINAL_SELECT = {
  gmailId: true,
  threadId: true,
  from: true,
  subject: true,
  linkedInboxAccountId: true,
} as const;

/** The original message: the caller's own row, same id lookup as mark_read and set_tier. */
function findOriginal(userId: string, emailId: string) {
  return findUserEmail(userId, emailId, ORIGINAL_SELECT);
}

type Original = NonNullable<Awaited<ReturnType<typeof findOriginal>>>;

/**
 * Threading for the draft, built from what the provider said about the ORIGINAL
 * message: In-Reply-To is its Message-ID and References is its chain plus that id
 * (RFC 5322), the same shape the human reply route uses. Undefined when the
 * provider returned nothing, in which case the draft threads by thread id alone.
 */
function replyContextFrom(headers: ReplyHeadersResult): ReplyThreadingHeaders | undefined {
  const references = [headers.references, headers.messageId].filter(Boolean).join(" ");
  if (!headers.messageId && !references) return undefined;
  return {
    ...(headers.messageId ? { inReplyTo: headers.messageId } : {}),
    ...(references ? { references } : {}),
  };
}

interface DraftToWrite {
  to: string;
  subject: string;
  body: string;
}

const answer = (
  draft: RememberedDraft | { draftId: string | null; provider: string; to: string },
  extra = {},
) =>
  JSON.stringify({
    success: true,
    draft_id: draft.draftId,
    provider: draft.provider,
    to: draft.to,
    ...extra,
  });

/**
 * Write the draft on the row's own account, through the provider. The provider
 * decides whether it can: Outlook is refused here until B0b, and any other
 * `{unsupported}` or `{error}` comes back exactly as the provider said it.
 */
async function writeDraft(
  userId: string,
  original: Original,
  draft: DraftToWrite,
  key: string,
): Promise<string> {
  // The account is the row's: a linked inbox stays linked at every step below.
  const accountId = original.linkedInboxAccountId;
  const actions = await mailActionsFor(userId, accountId);
  if (UNTHREADED_DRAFT_PROVIDERS.has(actions.provider)) {
    return JSON.stringify({ unsupported: true, error: UNSUPPORTED_THREADING_ERROR });
  }

  const headers = await actions.getReplyHeaders(userId, original.gmailId, accountId);
  const reply = replyContextFrom(headers);
  const result = await actions.createDraft(userId, {
    ...draft,
    threadId: original.threadId,
    linkedInboxAccountId: accountId,
    ...(reply ? { reply } : {}),
  });
  // `{ unsupported }` and `{ error }` both carry an error string: hand either back as the provider said it.
  if ("error" in result) return JSON.stringify(result);

  const created = { draftId: result.draftId ?? null, provider: actions.provider, to: draft.to };
  // Without a draft id there is nothing to return to a retry, so nothing is remembered.
  if (created.draftId) rememberDraft(key, { ...created, draftId: created.draftId });
  return answer(created);
}

/**
 * Create the reply draft for a validated call and return the tool's JSON result.
 * The recipient is checked BEFORE any provider is touched, and an identical recent
 * draft is answered from memory. May throw (a hard provider or database failure);
 * `executeCreateDraft` answers those generically.
 */
export async function createReplyDraft(
  ctx: CreateDraftContext,
  input: ReplyDraftInput,
): Promise<string> {
  const original = await findOriginal(ctx.userId, input.emailId);
  if (!original) return fail("NOT_FOUND", NOT_FOUND_ERROR);

  // The original sender's From, as the human reply route does. Never Reply-To.
  const to = parseSingleAddress(original.from);
  if (to === null) return fail("NO_REPLY_ADDRESS", NO_REPLY_ADDRESS_ERROR);

  const subject = input.subject ?? replySubject(original.subject);
  const key = draftKey({
    userId: ctx.userId,
    emailKey: original.gmailId,
    bodyHash: sha256Hex(input.body),
    subject,
  });
  const earlier = findRecentDraft(key);
  if (earlier) return answer(earlier, { deduplicated: true });

  return writeDraft(ctx.userId, original, { to, subject, body: input.body }, key);
}

/**
 * SHA-256 of the body a create_draft call carries, for its audit row: a long draft
 * is over the args-hash limit, so the args hash alone cannot tell two drafts apart.
 * Null when there is no string body or it is over the cap (the call is refused).
 */
export function draftBodyHash(args: unknown): string | null {
  const body = (args as { body?: unknown } | null)?.body;
  if (typeof body !== "string" || exceedsCodePoints(body, MAX_DRAFT_BODY_LENGTH)) return null;
  return sha256Hex(body);
}

/**
 * What a create_draft result says was created, for its audit row: the provider's
 * draft id (only when id-shaped) and SHA-256 of the lowercased recipient. Null for
 * anything that is not a success. The address itself is never stored.
 */
export function createdDraftIdentity(resultText: string): DraftIdentity | null {
  try {
    const parsed: unknown = JSON.parse(resultText);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { success, draft_id: draftId, to } = parsed as Record<string, unknown>;
    if (success !== true || typeof to !== "string") return null;
    return { draftId: auditIdOf(draftId), recipientHash: sha256Hex(to.toLowerCase()) };
  } catch {
    return null;
  }
}

/**
 * Run `create_draft` for a caller the gate already admitted. Returns the tool's
 * JSON result: `{success: true, draft_id, provider, to}`, a provider's own
 * `{unsupported}` or `{error}`, or `{error, code}`. Never throws: an unexpected
 * failure is captured and answered generically, so a provider or database message
 * never reaches the agent. A hard failure can follow a request that reached the
 * provider, so the answer does not claim that no draft exists.
 */
export async function executeCreateDraft(ctx: CreateDraftContext, args: unknown): Promise<string> {
  const parsed = parseArgs(args);
  if (!parsed.ok) return fail("INVALID_ARGUMENT", parsed.error);
  try {
    return await createReplyDraft(ctx, parsed.input);
  } catch (err) {
    captureError(err, { tags: { scope: "mcp.create-draft" }, extra: { userId: ctx.userId } });
    return fail("UNAVAILABLE", UNAVAILABLE_ERROR);
  }
}
