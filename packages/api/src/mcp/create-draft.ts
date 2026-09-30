/**
 * `create_draft` — an MCP agent drafts a reply to one email (step A4 of
 * docs/providers/unified-platform-plan.md). MCP-only: the definition lives here
 * and is NOT in ALL_TOOLS (that would hand it to the autonomous agent) or
 * CHAT_TOOL_NAMES (that would hand it to chat); mcp/tool-gate.ts adds it to the
 * write set and mcp/write-call.ts runs it, so the A2a gate, audit row and per-user
 * write cap apply unchanged.
 *
 * What the agent can and cannot decide:
 *  - It decides the WORDS: `body` (plain text) and, optionally, `subject`.
 *  - It never decides where the draft goes. There is no recipient argument: the
 *    draft's To is the original message's reply address, parsed and validated
 *    here (mcp/reply-target.ts). A hostile mail that talks the agent into naming
 *    another recipient gets an INVALID_ARGUMENT, not a draft.
 *  - It never supplies threading. The reply headers are read from the provider for
 *    the original message (`getReplyHeaders`) and the thread id comes from the
 *    row. Any header-shaped argument is refused.
 *  - It never picks the account. The email row names its linked inbox account (or
 *    the primary, which is `null`), and that id is threaded through every call:
 *    a row that names another account is never drafted on the primary.
 *  - It never sends. This module holds no send call, and a draft is only ever
 *    written to the user's own Drafts folder, where a human reviews it.
 *
 * Outlook answers unsupported until B0b: a draft made through Graph's plain
 * message endpoint cannot carry In-Reply-To, so it would not thread. A provider
 * with no draft support answers its own unsupported result, unchanged.
 */

import { prisma } from "../db.js";
import type { InboxProviderName } from "../mail/inbox-credentials.js";
import { mailActionsFor } from "../mail/providers/dispatch.js";
import type { ReplyHeadersResult, ReplyThreadingHeaders } from "../mail/providers/types.js";
import { captureError } from "../sentry.js";
import {
  checkedSubject,
  MAX_SUBJECT_LENGTH,
  pickReplyAddress,
  replySubject,
} from "./reply-target.js";
import { MAX_TARGET_ID_LENGTH } from "./write-audit.js";

export const CREATE_DRAFT_TOOL_NAME = "create_draft";

/** Longest draft body. Proposed value: a long reply, far below what a mailbox accepts. */
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
      "be chosen. Plain text only, no attachments. Not available for Outlook mailboxes yet.",
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
const EMAIL_ID_ERROR = `email_id must be a non-empty string of at most ${MAX_TARGET_ID_LENGTH} characters.`;
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

function parseEmailId(raw: unknown): string | null {
  const id = typeof raw === "string" ? raw.trim() : "";
  return id.length === 0 || id.length > MAX_TARGET_ID_LENGTH ? null : id;
}

function isValidBody(raw: unknown): raw is string {
  return (
    typeof raw === "string" &&
    raw.trim().length > 0 &&
    raw.length <= MAX_DRAFT_BODY_LENGTH &&
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
  const emailId = parseEmailId(given.email_id);
  if (emailId === null) return { ok: false, error: EMAIL_ID_ERROR };
  if (!isValidBody(given.body)) return { ok: false, error: BODY_ERROR };
  const subject = parseSubject(given.subject);
  if (!subject.ok) return { ok: false, error: SUBJECT_ERROR };
  return { ok: true, input: { emailId, body: given.body, subject: subject.subject } };
}

/** The original message: the caller's own row, same id lookup as mark_read and set_tier. */
function findOriginal(userId: string, emailId: string) {
  return prisma.emailMessage.findFirst({
    where: { userId, OR: [{ id: emailId }, { gmailId: emailId }] },
    select: {
      gmailId: true,
      threadId: true,
      from: true,
      subject: true,
      linkedInboxAccountId: true,
    },
  });
}

/**
 * A provider may one day return the original's Reply-To next to the threading
 * headers. No provider does today, so the pinned recipient is the From address;
 * the field is read defensively (and validated like From) so that adding it to the
 * provider seam needs no change here.
 */
function readReplyTo(headers: ReplyHeadersResult): unknown {
  return (headers as { replyTo?: unknown }).replyTo;
}

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

/**
 * Create the reply draft for a validated call and return the tool's JSON result.
 * May throw (a hard provider or database failure); `executeCreateDraft` answers
 * those generically.
 */
export async function createReplyDraft(
  ctx: CreateDraftContext,
  input: ReplyDraftInput,
): Promise<string> {
  const original = await findOriginal(ctx.userId, input.emailId);
  if (!original) return fail("NOT_FOUND", NOT_FOUND_ERROR);

  // The account is the row's: a linked inbox stays linked at every step below.
  const accountId = original.linkedInboxAccountId;
  const actions = await mailActionsFor(ctx.userId, accountId);
  if (UNTHREADED_DRAFT_PROVIDERS.has(actions.provider)) {
    return JSON.stringify({ unsupported: true, error: UNSUPPORTED_THREADING_ERROR });
  }

  const headers = await actions.getReplyHeaders(ctx.userId, original.gmailId, accountId);
  const to = pickReplyAddress({ from: original.from, replyTo: readReplyTo(headers) });
  if (to === null) return fail("NO_REPLY_ADDRESS", NO_REPLY_ADDRESS_ERROR);

  const reply = replyContextFrom(headers);
  const result = await actions.createDraft(ctx.userId, {
    to,
    subject: input.subject ?? replySubject(original.subject),
    body: input.body,
    threadId: original.threadId,
    linkedInboxAccountId: accountId,
    ...(reply ? { reply } : {}),
  });
  // `{ unsupported }` and `{ error }` both carry an error string: hand either back as the provider said it.
  if ("error" in result) return JSON.stringify(result);
  return JSON.stringify({
    success: true,
    draft_id: result.draftId ?? null,
    provider: actions.provider,
    to,
  });
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
