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
 * Reply threading is deliberately not wired yet: Graph's sendMail cannot set
 * In-Reply-To (internetMessageHeaders only accepts x-* custom headers) — a
 * real reply needs the /messages/{id}/reply endpoint. sendEmail therefore
 * sends a NEW message, and getReplyHeaders answers {} (best-effort per
 * contract) so /api/email/:id/reply never claims `threaded: true` for a
 * send that carries no threading headers. createDraft accepts the seam's
 * reply context (step B0) and ignores it for the same reason. Native Outlook
 * replies and reply drafts (/reply, /createReply) are step B0b in
 * docs/providers/unified-platform-plan.md; getReplyHeaders stays {} there too.
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
  method: "GET" | "POST" | "PATCH",
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
    ...(attachments.length
      ? {
          attachments: attachments.map((a) => ({
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: a.filename,
            contentType: a.mimeType,
            contentBytes: a.content.toString("base64"),
          })),
        }
      : {}),
  };
}

export const outlookMailActions: MailProviderActions = {
  provider: "OUTLOOK",

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
    const out = await graphCall(ctx, "POST", "/me/sendMail", {
      message: buildGraphMessage(to, subject, body, attachments),
      saveToSentItems: true,
    });
    if ("error" in out) return out;
    // Graph's sendMail answers 202 with no body — there is no provider
    // message id to hand back (the contract allows null).
    return { success: true, messageId: null };
  },

  createDraft: async (
    userId,
    to,
    subject,
    body,
    _threadId,
    attachments = [],
    linkedInboxAccountId,
    // Accepted for seam parity, ignored until B0b: POST /me/messages cannot
    // carry In-Reply-To, and a native reply draft needs /messages/{id}/createReply.
    _reply,
  ): Promise<CreateDraftResult> => {
    const ctx = await ctxFor(userId, linkedInboxAccountId);
    if ("error" in ctx) return ctx;
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
    // {} unconditionally (best-effort per contract): returning the real
    // internetMessageId would make /api/email/:id/reply report
    // `threaded: true` while our sendEmail cannot set In-Reply-To on Graph.
    // Wire the /messages/{id}/reply endpoint before answering headers here.
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
