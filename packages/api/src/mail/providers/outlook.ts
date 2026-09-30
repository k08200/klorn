/**
 * OUTLOOK implementation of MailProviderActions (Phase 3C of
 * docs/providers/multi-provider-plan.md) — Microsoft Graph calls addressed
 * by the immutable message id embedded in the synthesized
 * `outlook:<email>:<graphId>` dedup key that outlook-sync.ts writes.
 *
 * Every request carries `Prefer: IdType="ImmutableId"`: the stored ids ARE
 * immutable ids (the sync fetches with the same Prefer), and without it
 * Graph would interpret the path id in mutable-id space and 404 after any
 * folder move.
 *
 * Result contract (types.ts), deliberately mirroring the Gmail module's:
 * `{ error }` means the NOT-CONNECTED class only — missing linked id,
 * unresolvable bearer, or Graph 401/403 (which also durably flags
 * reconnect). Everything else THROWS: non-auth 4xx (throttle, message gone),
 * a foreign/corrupt message id, 5xx, network. Callers treat `{ error }` as
 * "fall back to a local-only write" — for DELETE that removes the local row,
 * so a soft answer to a transient 429 would be a false success that the next
 * delta sync resurrects (the exact bug Phase 0b fixed).
 *
 * Replies (step B0b of docs/providers/unified-platform-plan.md, which has the design
 * and the reasons). Graph's sendMail cannot set In-Reply-To, so a reply is made FROM
 * the original message and Graph threads it itself:
 *   POST /me/messages/{id}/createReply    https://learn.microsoft.com/en-us/graph/api/message-createreply?view=graph-rest-1.0
 *   PATCH /me/messages/{draft}            https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0
 *   GET .../{draft}/attachments           https://learn.microsoft.com/en-us/graph/api/message-list-attachments?view=graph-rest-1.0
 *   DELETE .../{draft}/attachments/{id}   https://learn.microsoft.com/en-us/graph/api/attachment-delete?view=graph-rest-1.0
 *   POST /me/messages/{draft}/attachments https://learn.microsoft.com/en-us/graph/api/message-post-attachments?view=graph-rest-1.0
 *   POST /me/messages/{draft}/send        https://learn.microsoft.com/en-us/graph/api/message-send?view=graph-rest-1.0
 * (/reply is not used: https://learn.microsoft.com/en-us/graph/api/message-reply?view=graph-rest-1.0)
 * Before anything is sent, the PATCH answer must show exactly the approved recipient,
 * subject and text body, and the draft must carry no attachment but ours. A failure
 * before the send discards the draft (best effort, logged). A send whose outcome is
 * unknown throws SendOutcomeUnknownError and leaves the draft. The whole sequence has
 * a time budget. `getReplyHeaders` still answers {}: the header path is Gmail and SMTP
 * only. Without a `replyToProviderMessageId`, sendEmail is still a NEW message through
 * sendMail and createDraft a plain draft, exactly as before B0b.
 */

import { markLinkedInboxForReconnect } from "../gmail.js";
import { resolveOutlookBearer } from "../outlook-token.js";
import { SendOutcomeUnknownError } from "./send-outcome-unknown.js";
import type {
  CreateDraftResult,
  MailActionFailure,
  MailAttachment,
  MailProviderActions,
  ReplyHeadersResult,
  SendMailResult,
  SimpleMailActionResult,
} from "./types.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// Well-known folder names Graph resolves per-mailbox (localization-safe).
const FOLDER_TRASH = "deleteditems";
const FOLDER_ARCHIVE = "archive";
const FOLDER_INBOX = "inbox";

// Fallback when a created draft carries no webLink — the CreateDraftResult
// contract requires a url the UI can open.
const OUTLOOK_DRAFTS_URL = "https://outlook.live.com/mail/0/drafts";

// Action routes have a user waiting: no single Graph call may take longer than this.
const GRAPH_CALL_TIMEOUT_MS = 15_000;
// One native reply (several calls) may hold the user at most this long. The send keeps
// a full call timeout of its own, so preparation gets the rest.
const REPLY_SEQUENCE_BUDGET_MS = 45_000;
// Clean-up after a failure must not hold the user for a full call timeout.
const DISCARD_BUDGET_MS = 5_000;

interface OutlookCtx {
  userId: string;
  rowId: string;
  accessToken: string;
  email: string;
  /** Epoch ms after which no further call may start; each call is also clamped to what is left. */
  deadlineAt?: number;
}

/**
 * A non-2xx Graph answer. The message never reflects the response body. The code is
 * `graphStatus`, not `status`: Fastify turns an error's `status` into the route's own
 * HTTP status, and Graph's 404 or 429 must not become the client's.
 */
class GraphHttpError extends Error {
  constructor(
    method: string,
    path: string,
    readonly graphStatus: number,
  ) {
    super(`Graph ${method} ${path} failed: http ${graphStatus}`);
    this.name = "GraphHttpError";
  }
}

/** The reply's time budget ran out before a call was started, so that call was never made. */
class ReplyBudgetExceededError extends Error {
  constructor() {
    super("The Outlook reply took too long; it was stopped before anything was sent");
    this.name = "ReplyBudgetExceededError";
  }
}

async function ctxFor(
  userId: string,
  linkedInboxAccountId: string | null | undefined,
): Promise<OutlookCtx | MailActionFailure> {
  // The primary inbox (null id) is always the Google account — an OUTLOOK
  // action without its linked row id is the not-connected class.
  if (!linkedInboxAccountId) {
    return { error: "Outlook actions require a linked inbox account id" };
  }
  const bearer = await resolveOutlookBearer(userId, linkedInboxAccountId);
  if (!bearer) {
    return { error: "Outlook account is not connected" };
  }
  return { userId, rowId: linkedInboxAccountId, ...bearer };
}

/**
 * The stored id is `outlook:<mailbox email>:<graph immutable id>` — anything
 * else (a Gmail id, another mailbox's id) is corrupt data and the caller
 * must hard-fail, not soft-fail into a local-only write.
 */
function requireGraphId(stableId: string, email: string): string {
  const prefix = `outlook:${email}:`;
  if (!stableId.startsWith(prefix)) throw new Error("Not a message id of this Outlook mailbox");
  return stableId.slice(prefix.length);
}

type GraphCallResult = { ok: true; body: unknown } | MailActionFailure;

/** How long the next call may run: the plain limit, or what a reply's time budget has left. */
function callTimeoutMs(ctx: OutlookCtx): number {
  if (ctx.deadlineAt === undefined) return GRAPH_CALL_TIMEOUT_MS;
  const remaining = ctx.deadlineAt - Date.now();
  if (remaining <= 0) throw new ReplyBudgetExceededError();
  return Math.min(GRAPH_CALL_TIMEOUT_MS, remaining);
}

async function graphCall(
  ctx: OutlookCtx,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  jsonBody?: unknown,
  options: { markReconnect?: boolean } = {},
): Promise<GraphCallResult> {
  const timeoutMs = callTimeoutMs(ctx);
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ctx.accessToken}`,
      Prefer: 'IdType="ImmutableId"',
      ...(jsonBody !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(jsonBody !== undefined ? { body: JSON.stringify(jsonBody) } : {}),
    // Fail fast — action routes have a user waiting on them.
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401 || res.status === 403) {
    // A clean-up call passes markReconnect: false: the failure that made it necessary
    // has already flagged the inbox when it was an authorization failure.
    if (options.markReconnect !== false) {
      void markLinkedInboxForReconnect(ctx.userId, ctx.rowId, "OUTLOOK").catch((err) => {
        console.warn(`[outlook-actions] reconnect mark failed for row ${ctx.rowId}:`, err);
      });
    }
    return { error: "Outlook authorization expired — reconnect the inbox in Settings" };
  }
  if (!res.ok) {
    // EVERY other failure is hard (contract header) — a 429 throttle or a
    // vanished message must surface as a 502 to the caller, never as the
    // local-only fallback. Body is never reflected.
    throw new GraphHttpError(method, path, res.status);
  }
  const body = res.status === 202 || res.status === 204 ? null : await res.json().catch(() => null);
  return { ok: true, body };
}

async function messageAction(
  userId: string,
  messageId: string,
  linkedInboxAccountId: string | null | undefined,
  run: (ctx: OutlookCtx, encodedId: string) => Promise<GraphCallResult>,
): Promise<SimpleMailActionResult> {
  const ctx = await ctxFor(userId, linkedInboxAccountId);
  if ("error" in ctx) return ctx;
  // A foreign id is a hard failure (see contract header): a soft {error} would send
  // DELETE callers into the "remove locally" branch and the message would resurrect
  // on the next delta sync.
  const graphId = requireGraphId(messageId, ctx.email);
  const out = await run(ctx, encodeURIComponent(graphId));
  return "error" in out ? out : { success: true };
}

function fileAttachmentJson(attachment: MailAttachment): Record<string, unknown> {
  return {
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: attachment.filename,
    contentType: attachment.mimeType,
    contentBytes: attachment.content.toString("base64"),
  };
}

function buildGraphMessage(
  to: string,
  subject: string,
  body: string,
  attachments: MailAttachment[],
): Record<string, unknown> {
  return {
    subject,
    body: { contentType: "Text", content: body },
    toRecipients: [{ emailAddress: { address: to } }],
    ...(attachments.length ? { attachments: attachments.map(fileAttachmentJson) } : {}),
  };
}

// ─── Native replies (step B0b) ───────────────────────────────────────────────

interface ReplyContent {
  to: string;
  subject: string;
  body: string;
  attachments: MailAttachment[];
}

interface ReplyDraft {
  id: string;
  /** Graph path of the draft, id already URL-encoded. */
  path: string;
  webLink: string | null;
}

const asAddress = (address: string) => ({ emailAddress: { address } });

/** ASCII-only lower-casing: a look-alike letter must not fold into the approved address. */
const asciiLower = (text: string): string =>
  text.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));

/** Text bodies come back with CRLF line ends; the approved text has LF. */
const withLf = (text: string): string => text.replace(/\r\n/g, "\n");

function addressesOf(list: unknown): string[] | null {
  if (!Array.isArray(list)) return null;
  return list.map((item) => {
    const address = (item as { emailAddress?: { address?: unknown } } | null)?.emailAddress
      ?.address;
    return typeof address === "string" ? address : "";
  });
}

/**
 * Fail closed: the draft may be sent only if Graph says it is addressed to `to` alone.
 * To must hold exactly that address, and Cc and Bcc must be present and empty; a list
 * that is missing is a refusal, not "nobody".
 */
function assertAddressedOnlyTo(draft: Record<string, unknown>, to: string): void {
  const toList = addressesOf(draft.toRecipients);
  const ccList = addressesOf(draft.ccRecipients);
  const bccList = addressesOf(draft.bccRecipients);
  const pinned =
    toList?.length === 1 && asciiLower(toList[0]?.trim() ?? "") === asciiLower(to.trim());
  if (!pinned || ccList?.length !== 0 || bccList?.length !== 0) {
    throw new Error("Graph reply draft is not addressed to exactly the requested recipient");
  }
}

/** Fail closed: the draft must read back with the approved subject and the approved text. */
function assertApprovedText(draft: Record<string, unknown>, content: ReplyContent): void {
  const body = draft.body as { contentType?: unknown; content?: unknown } | null | undefined;
  const approved =
    draft.subject === content.subject &&
    typeof body?.contentType === "string" &&
    asciiLower(body.contentType) === "text" &&
    typeof body.content === "string" &&
    withLf(body.content) === withLf(content.body);
  if (!approved) {
    throw new Error("Graph reply draft does not hold the approved subject and text body");
  }
}

function warnStrayDraft(ctx: OutlookCtx, draftId: string, reason: string): void {
  // Ids only: nothing of the mail's content is logged.
  console.warn(
    `[outlook-actions] reply draft ${draftId} of row ${ctx.rowId} may remain in Drafts: ${reason}`,
  );
}

/**
 * Best effort: a leftover draft is untidy, never worth hiding the failure that caused
 * it. A delete Graph refuses is a failure too and is logged; it does not flag the inbox
 * for reconnect again, and it gets its own short time budget.
 */
async function discardDraft(ctx: OutlookCtx, draft: ReplyDraft): Promise<void> {
  const cleanup = { ...ctx, deadlineAt: Date.now() + DISCARD_BUDGET_MS };
  try {
    const out = await graphCall(cleanup, "DELETE", draft.path, undefined, { markReconnect: false });
    if ("error" in out) warnStrayDraft(ctx, draft.id, "the delete was refused for authorization");
  } catch (err) {
    warnStrayDraft(ctx, draft.id, err instanceof Error ? err.message : "the delete failed");
  }
}

/**
 * createReply may put the original's attachments (inline images) on the draft. They are
 * outside what was approved, so they go. The list is always read: `hasAttachments` leaves
 * inline attachments out. A list that cannot be read in full, or an entry that cannot be
 * deleted, fails the whole reply.
 */
async function clearInheritedAttachments(
  ctx: OutlookCtx,
  draft: ReplyDraft,
): Promise<MailActionFailure | null> {
  const listed = await graphCall(ctx, "GET", `${draft.path}/attachments?$select=id`);
  if ("error" in listed) return listed;
  const page = listed.body as { value?: unknown; "@odata.nextLink"?: unknown } | null;
  if (!Array.isArray(page?.value) || page["@odata.nextLink"] !== undefined) {
    throw new Error("The attachment list of the reply draft could not be read in full");
  }
  for (const entry of page.value) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || id === "") {
      throw new Error("The reply draft has an attachment without an id");
    }
    const removed = await graphCall(
      ctx,
      "DELETE",
      `${draft.path}/attachments/${encodeURIComponent(id)}`,
    );
    if ("error" in removed) return removed;
  }
  return null;
}

/** Set the draft's content and recipients, verify what Graph holds, then attach ours. */
async function fillReplyDraft(
  ctx: OutlookCtx,
  draft: ReplyDraft,
  content: ReplyContent,
): Promise<MailActionFailure | null> {
  const patched = await graphCall(ctx, "PATCH", draft.path, {
    subject: content.subject,
    body: { contentType: "Text", content: content.body },
    toRecipients: [asAddress(content.to)],
    ccRecipients: [],
    bccRecipients: [],
  });
  if ("error" in patched) return patched;
  const held = (patched.body ?? {}) as Record<string, unknown>;
  assertAddressedOnlyTo(held, content.to);
  assertApprovedText(held, content);
  const cleared = await clearInheritedAttachments(ctx, draft);
  if (cleared) return cleared;
  for (const attachment of content.attachments) {
    const added = await graphCall(
      ctx,
      "POST",
      `${draft.path}/attachments`,
      fileAttachmentJson(attachment),
    );
    if ("error" in added) return added;
  }
  return null;
}

/**
 * createReply from the original, then fill the draft. Returns the ready draft, or the
 * soft failure; throws on a hard one. A failure after the draft exists discards it.
 * The whole preparation runs inside the reply's time budget.
 */
async function prepareReplyDraft(
  ctx: OutlookCtx,
  originalMessageId: string,
  content: ReplyContent,
): Promise<ReplyDraft | MailActionFailure> {
  const originalGraphId = requireGraphId(originalMessageId, ctx.email);
  const budgeted = {
    ...ctx,
    deadlineAt: Date.now() + REPLY_SEQUENCE_BUDGET_MS - GRAPH_CALL_TIMEOUT_MS,
  };
  const created = await graphCall(
    budgeted,
    "POST",
    `/me/messages/${encodeURIComponent(originalGraphId)}/createReply`,
  );
  if ("error" in created) return created;
  const made = created.body as { id?: unknown; webLink?: unknown } | null;
  if (typeof made?.id !== "string" || made.id === "") {
    // A 201 whose draft id cannot be read: there is nothing to delete by.
    console.warn(
      `[outlook-actions] createReply for row ${ctx.rowId} answered without a readable draft id; a draft may remain in Drafts`,
    );
    throw new Error("Graph createReply returned no draft id");
  }
  const draft: ReplyDraft = {
    id: made.id,
    path: `/me/messages/${encodeURIComponent(made.id)}`,
    webLink: typeof made.webLink === "string" ? made.webLink : null,
  };
  try {
    const failure = await fillReplyDraft(budgeted, draft, content);
    if (failure) {
      await discardDraft(ctx, draft);
      return failure;
    }
  } catch (err) {
    await discardDraft(ctx, draft);
    throw err;
  }
  return draft;
}

/**
 * Send the prepared draft. A rejection (4xx) means nothing was sent, so the draft goes.
 * A 5xx, a timeout or a network error means nobody knows, so the draft stays (it may be
 * the sent copy) and the caller gets SendOutcomeUnknownError.
 */
async function sendReplyDraft(ctx: OutlookCtx, draft: ReplyDraft): Promise<GraphCallResult> {
  try {
    return await graphCall(ctx, "POST", `${draft.path}/send`);
  } catch (err) {
    if (err instanceof GraphHttpError && err.graphStatus < 500) {
      await discardDraft(ctx, draft);
      throw err;
    }
    throw new SendOutcomeUnknownError({ cause: err });
  }
}

async function sendNativeReply(
  ctx: OutlookCtx,
  originalMessageId: string,
  content: ReplyContent,
): Promise<SendMailResult> {
  const draft = await prepareReplyDraft(ctx, originalMessageId, content);
  if ("error" in draft) return draft;
  const sent = await sendReplyDraft(ctx, draft);
  if ("error" in sent) {
    // An authorization refusal means the draft was not sent, so it can go.
    await discardDraft(ctx, draft);
    return sent;
  }
  return { success: true, messageId: null, threaded: true };
}

function draftResult(id: string | null, webLink: string | null | undefined): CreateDraftResult {
  return { success: true, draftId: id, messageId: id, url: webLink ?? OUTLOOK_DRAFTS_URL };
}

export const outlookMailActions: MailProviderActions = {
  provider: "OUTLOOK",
  nativeReply: true,

  sendEmail: async (
    userId,
    to,
    subject,
    body,
    attachments = [],
    options,
  ): Promise<SendMailResult> => {
    const ctx = await ctxFor(userId, options?.linkedInboxAccountId);
    if ("error" in ctx) return ctx;
    if (options?.replyToProviderMessageId) {
      return sendNativeReply(ctx, options.replyToProviderMessageId, {
        to,
        subject,
        body,
        attachments,
      });
    }
    const out = await graphCall(ctx, "POST", "/me/sendMail", {
      message: buildGraphMessage(to, subject, body, attachments),
      saveToSentItems: true,
    });
    if ("error" in out) return out;
    // Graph's sendMail answers 202 with no body — there is no provider
    // message id to hand back (the contract allows null).
    return { success: true, messageId: null };
  },

  createDraft: async (userId, draft): Promise<CreateDraftResult> => {
    // `threadId` and the header-shaped `reply` are accepted for seam parity and
    // ignored: POST /me/messages cannot carry In-Reply-To. A reply draft is made from
    // the original's id instead (step B0b).
    const { to, subject, body, attachments = [], linkedInboxAccountId } = draft;
    const ctx = await ctxFor(userId, linkedInboxAccountId);
    if ("error" in ctx) return ctx;
    if (draft.replyToProviderMessageId) {
      const reply = await prepareReplyDraft(ctx, draft.replyToProviderMessageId, {
        to,
        subject,
        body,
        attachments,
      });
      if ("error" in reply) return reply;
      return draftResult(reply.id, reply.webLink);
    }
    const out = await graphCall(
      ctx,
      "POST",
      "/me/messages",
      buildGraphMessage(to, subject, body, attachments),
    );
    if ("error" in out) return out;
    const created = out.body as { id?: string; webLink?: string } | null;
    return draftResult(created?.id ?? null, created?.webLink);
  },

  getReplyHeaders: async (): Promise<ReplyHeadersResult> => {
    // {} unconditionally (best-effort per contract): Outlook threads by the
    // original's id (`replyToProviderMessageId`), not by headers. Returning the
    // internetMessageId here would make the reply route claim a header thread that
    // this provider never writes.
    return {};
  },

  markAsRead: (userId, messageId, linkedInboxAccountId) =>
    messageAction(userId, messageId, linkedInboxAccountId, (ctx, id) =>
      graphCall(ctx, "PATCH", `/me/messages/${id}`, { isRead: true }),
    ),

  toggleRead: (userId, messageId, isRead, linkedInboxAccountId) =>
    messageAction(userId, messageId, linkedInboxAccountId, (ctx, id) =>
      graphCall(ctx, "PATCH", `/me/messages/${id}`, { isRead }),
    ),

  toggleStar: (userId, messageId, starred, linkedInboxAccountId) =>
    messageAction(userId, messageId, linkedInboxAccountId, (ctx, id) =>
      graphCall(ctx, "PATCH", `/me/messages/${id}`, {
        flag: { flagStatus: starred ? "flagged" : "notFlagged" },
      }),
    ),

  trash: (userId, messageId, linkedInboxAccountId) =>
    messageAction(userId, messageId, linkedInboxAccountId, (ctx, id) =>
      graphCall(ctx, "POST", `/me/messages/${id}/move`, { destinationId: FOLDER_TRASH }),
    ),

  untrash: (userId, messageId, linkedInboxAccountId) =>
    messageAction(userId, messageId, linkedInboxAccountId, (ctx, id) =>
      graphCall(ctx, "POST", `/me/messages/${id}/move`, { destinationId: FOLDER_INBOX }),
    ),

  archive: (userId, messageId, linkedInboxAccountId) =>
    messageAction(userId, messageId, linkedInboxAccountId, (ctx, id) =>
      graphCall(ctx, "POST", `/me/messages/${id}/move`, { destinationId: FOLDER_ARCHIVE }),
    ),

  unarchive: (userId, messageId, linkedInboxAccountId) =>
    messageAction(userId, messageId, linkedInboxAccountId, (ctx, id) =>
      graphCall(ctx, "POST", `/me/messages/${id}/move`, { destinationId: FOLDER_INBOX }),
    ),
};
