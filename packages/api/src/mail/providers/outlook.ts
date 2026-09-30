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
 * Replies (step B0b of docs/providers/unified-platform-plan.md). Graph's sendMail
 * cannot set In-Reply-To (internetMessageHeaders only accepts x-* custom headers),
 * so a reply is made FROM the original message and Graph threads it itself
 * (conversationId and In-Reply-To are set by the service):
 *   POST /me/messages/{id}/createReply  - Mail.ReadWrite, 201 + the reply draft
 *     https://learn.microsoft.com/en-us/graph/api/message-createreply?view=graph-rest-1.0
 *   PATCH /me/messages/{draft}          - Mail.ReadWrite; subject, body and the
 *     recipient lists are updatable only while isDraft = true
 *     https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0
 *   POST /me/messages/{draft}/attachments - under 3 MB per file
 *     https://learn.microsoft.com/en-us/graph/api/message-post-attachments?view=graph-rest-1.0
 *   POST /me/messages/{draft}/send      - Mail.Send, 202, the draft moves to Sent Items
 *     https://learn.microsoft.com/en-us/graph/api/message-send?view=graph-rest-1.0
 * All four scopes are already requested at connect time (Mail.Read/ReadWrite/Send).
 *
 * Why not POST /me/messages/{id}/reply
 * (https://learn.microsoft.com/en-us/graph/api/message-reply?view=graph-rest-1.0):
 * its JSON form takes `comment` OR `message.body`, and the service builds an HTML
 * reply around it with the quoted original, so the bytes sent are not the bytes the
 * caller (and, on an agent path, the ActionReceipt) approved. The docs also say the
 * reply goes to the original's `replyTo` instead of its `from`, and describe
 * `message.toRecipients` as an update to the reply without saying whether it replaces
 * that default. createReply + PATCH is the documented way to set body and recipients
 * exactly, and it needs no quoted text to match Gmail's behaviour here.
 *
 * Recipient pinning. The recipient is whatever the caller passed as `to`. The PATCH
 * sets To, Cc and Bcc explicitly, which replaces the Reply-To default createReply
 * chose, and the PATCH answer is checked: unless the draft is addressed to exactly
 * `to` and nobody else, the draft is discarded and the call throws, before anything
 * is sent. A reply is addressed only by an original whose id is of THIS mailbox
 * (`outlook:<email>:<id>`); any other id throws before any Graph call.
 *
 * Failure handling. Any failure before the send discards the half-made draft (best
 * effort, logged), so no stray draft addressed to a Reply-To is left behind. A send
 * whose outcome is unknown (5xx, network) throws and leaves the draft alone: it may
 * already be sent, and deleting it would delete the sent copy. There is no fallback to
 * sendMail: an unthreaded resend could double-send. sendEmail returns messageId null,
 * as it always has for Outlook, because the draft's id is not known to survive the send.
 *
 * `getReplyHeaders` still answers {} (best-effort per contract): the header path is
 * Gmail and SMTP only. Without a `replyToProviderMessageId`, sendEmail is still a NEW
 * message through sendMail and createDraft a plain draft, exactly as before B0b.
 */

import { markLinkedInboxForReconnect } from "../gmail.js";
import { resolveOutlookBearer } from "../outlook-token.js";
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

interface OutlookCtx {
  userId: string;
  rowId: string;
  accessToken: string;
  email: string;
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
function graphIdFrom(stableId: string, email: string): string | null {
  const prefix = `outlook:${email}:`;
  return stableId.startsWith(prefix) ? stableId.slice(prefix.length) : null;
}

type GraphCallResult = { ok: true; body: unknown } | MailActionFailure;

async function graphCall(
  ctx: OutlookCtx,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  jsonBody?: unknown,
): Promise<GraphCallResult> {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ctx.accessToken}`,
      Prefer: 'IdType="ImmutableId"',
      ...(jsonBody !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(jsonBody !== undefined ? { body: JSON.stringify(jsonBody) } : {}),
    // Fail fast — action routes have a user waiting on them.
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) {
    void markLinkedInboxForReconnect(ctx.userId, ctx.rowId, "OUTLOOK").catch((err) => {
      console.warn(`[outlook-actions] reconnect mark failed for row ${ctx.rowId}:`, err);
    });
    return { error: "Outlook authorization expired — reconnect the inbox in Settings" };
  }
  if (!res.ok) {
    // EVERY other failure is hard (contract header) — a 429 throttle or a
    // vanished message must surface as a 502 to the caller, never as the
    // local-only fallback. Body is never reflected.
    throw new Error(`Graph ${method} ${path} failed: http ${res.status}`);
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
  const graphId = graphIdFrom(messageId, ctx.email);
  if (!graphId) {
    // Hard failure (see contract header): a soft {error} would send DELETE
    // callers into the "remove locally" branch and the message would
    // resurrect on the next delta sync.
    throw new Error("Not a message id of this Outlook mailbox");
  }
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

function addressesOf(list: unknown): string[] | null {
  if (!Array.isArray(list)) return null;
  return list.map((item) => {
    const address = (item as { emailAddress?: { address?: unknown } } | null)?.emailAddress
      ?.address;
    return typeof address === "string" ? address : "";
  });
}

/**
 * Fail closed: the reply draft may be sent only if Graph says it is addressed to
 * `to` alone. A missing To list is a refusal; a missing Cc or Bcc list is "nobody".
 */
function assertAddressedOnlyTo(message: unknown, to: string): void {
  const draft = (message ?? {}) as Record<string, unknown>;
  const toList = addressesOf(draft.toRecipients);
  const others = [
    ...(addressesOf(draft.ccRecipients) ?? []),
    ...(addressesOf(draft.bccRecipients) ?? []),
  ];
  const pinned =
    toList?.length === 1 && toList[0]?.trim().toLowerCase() === to.trim().toLowerCase();
  if (!pinned || others.length > 0) {
    throw new Error("Graph reply draft is not addressed to exactly the requested recipient");
  }
}

/** Best effort: a leftover draft is untidy, never worth hiding the failure that caused it. */
async function discardDraft(ctx: OutlookCtx, draft: ReplyDraft): Promise<void> {
  try {
    await graphCall(ctx, "DELETE", draft.path);
  } catch (err) {
    console.warn(`[outlook-actions] could not discard reply draft for row ${ctx.rowId}:`, err);
  }
}

/** Set the draft's content and recipients, then check who it is addressed to. */
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
  assertAddressedOnlyTo(patched.body, content.to);
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
 * soft failure; throws on a hard one. Nothing is left behind on either.
 */
async function prepareReplyDraft(
  ctx: OutlookCtx,
  originalMessageId: string,
  content: ReplyContent,
): Promise<ReplyDraft | MailActionFailure> {
  const originalGraphId = graphIdFrom(originalMessageId, ctx.email);
  if (!originalGraphId) throw new Error("Not a message id of this Outlook mailbox");
  const created = await graphCall(
    ctx,
    "POST",
    `/me/messages/${encodeURIComponent(originalGraphId)}/createReply`,
  );
  if ("error" in created) return created;
  const made = created.body as { id?: unknown; webLink?: unknown } | null;
  if (typeof made?.id !== "string" || made.id === "") {
    throw new Error("Graph createReply returned no draft id");
  }
  const draft: ReplyDraft = {
    id: made.id,
    path: `/me/messages/${encodeURIComponent(made.id)}`,
    webLink: typeof made.webLink === "string" ? made.webLink : null,
  };
  try {
    const failure = await fillReplyDraft(ctx, draft, content);
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

async function sendNativeReply(
  ctx: OutlookCtx,
  originalMessageId: string,
  content: ReplyContent,
): Promise<SendMailResult> {
  const draft = await prepareReplyDraft(ctx, originalMessageId, content);
  if ("error" in draft) return draft;
  const sent = await graphCall(ctx, "POST", `${draft.path}/send`);
  if ("error" in sent) {
    // An authorization refusal means the draft was not sent, so it can go.
    await discardDraft(ctx, draft);
    return sent;
  }
  return { success: true, messageId: null, threaded: true };
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
      return {
        success: true,
        draftId: reply.id,
        messageId: reply.id,
        url: reply.webLink ?? OUTLOOK_DRAFTS_URL,
      };
    }
    const out = await graphCall(
      ctx,
      "POST",
      "/me/messages",
      buildGraphMessage(to, subject, body, attachments),
    );
    if ("error" in out) return out;
    const created = out.body as { id?: string; webLink?: string } | null;
    return {
      success: true,
      draftId: created?.id ?? null,
      messageId: created?.id ?? null,
      url: created?.webLink ?? OUTLOOK_DRAFTS_URL,
    };
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
