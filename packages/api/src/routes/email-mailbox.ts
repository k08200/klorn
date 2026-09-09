/**
 * Folder routes — Sent / Drafts / Archived listings and a live single-message
 * read (desktop shell restructure, 2026-08-26).
 *
 * Every mail client the desktop is measured against (the founder's reference
 * set) puts these folders in the sidebar; Klorn's local mirror is INBOX-only,
 * so both endpoints read Gmail LIVE rather than widening the sync. Split from
 * routes/email.ts like the other email domains; registered by emailRoutes()
 * against the same `/api/email` prefix.
 */

import type { FastifyInstance } from "fastify";
import { getUserId } from "../auth.js";
import { renderableEmailHtmlFor } from "../mail/email-text.js";
import { fetchGmailEmailById } from "../mail/gmail-fetch.js";
import {
  deleteGmailDraftByMessageId,
  listGmailMailbox,
  MAILBOXES,
  type Mailbox,
  type MailboxItemWire,
  resolveMailboxClient,
} from "../mail/gmail-mailbox.js";

/** Demo rows so a signed-out / disconnected session still shows the shape. */
const DEMO_ROWS: Record<Mailbox, MailboxItemWire[]> = {
  sent: [
    {
      gmailId: "demo-sent-1",
      threadId: null,
      subject: "Re: Contract review — needs your sign-off today",
      from: "you@company.com",
      to: "Sarah Kim <sarah@company.com>",
      snippet: "Signed and attached. Clause 4 reads fine after legal's change.",
      receivedAt: "2026-07-29T05:40:00.000Z",
      isRead: true,
      inbox: "primary",
    },
  ],
  drafts: [
    {
      gmailId: "demo-draft-1",
      threadId: null,
      subject: "Q3 vendor consolidation",
      from: "you@company.com",
      to: "billing@vendor.io",
      snippet: "Before we renew, can you break the invoice into",
      receivedAt: "2026-07-29T03:12:00.000Z",
      isRead: true,
      inbox: "primary",
    },
  ],
  archived: [
    {
      gmailId: "demo-arch-1",
      threadId: null,
      subject: "Your July invoice is available",
      from: "billing@saas.example",
      to: "you@company.com",
      snippet: "Invoice #4783 for July is attached. No action needed.",
      receivedAt: "2026-07-28T22:05:00.000Z",
      isRead: true,
      inbox: "primary",
    },
  ],
};

function isMailbox(value: string): value is Mailbox {
  return (MAILBOXES as readonly string[]).includes(value);
}

/** `inbox=` names ONE linked account (not absent / primary / all). */
function isLinkedInboxScope(inbox: string | undefined): inbox is string {
  return Boolean(inbox) && inbox !== "primary" && inbox !== "all";
}

export function registerEmailMailboxRoutes(app: FastifyInstance) {
  app.get("/mailbox/:box", async (request, reply) => {
    const { box } = request.params as { box: string };
    if (!isMailbox(box)) {
      return reply.code(404).send({ success: false, error: "Unknown mailbox" });
    }
    const uid = getUserId(request);
    const { pageToken, inbox } = request.query as { pageToken?: string; inbox?: string };
    const page = await listGmailMailbox(uid, box, pageToken, inbox);
    // A linked id that does not resolve (unknown, foreign, non-Google) is a
    // miss, never demo mail dressed up as that account.
    if (page === null && isLinkedInboxScope(inbox)) {
      return reply.code(404).send({ success: false, error: "Inbox not found" });
    }
    // null = Gmail not connected — same demo fallback contract as GET /.
    return {
      success: true,
      data: {
        items: page?.items ?? DEMO_ROWS[box],
        nextPageToken: page?.nextPageToken ?? null,
        demo: page === null,
      },
    };
  });

  // Live single-message read for folder rows: these messages are not in the
  // local mirror, so the DB-backed GET /:id can never serve them. Attachments
  // ARE parsed here (format:"full") — opening one message is the acceptable
  // cost the metadata-only listing avoids paying fifty times.
  app.get("/live/:gmailId", async (request, reply) => {
    const { gmailId } = request.params as { gmailId: string };
    const { inbox } = request.query as { inbox?: string };
    const uid = getUserId(request);
    // The row said which account issued this id; open it THERE. The primary
    // path keeps fetchGmailEmailById's own token handling (no client passed).
    const linked = isLinkedInboxScope(inbox) ? await resolveMailboxClient(uid, inbox) : null;
    if (isLinkedInboxScope(inbox) && !linked) {
      return reply.code(404).send({ success: false, error: "Inbox not found" });
    }
    const raw = await fetchGmailEmailById(uid, gmailId, linked);
    if (!raw) {
      return reply.code(404).send({ success: false, error: "Message not found" });
    }
    return {
      success: true,
      data: {
        gmailId: raw.gmailId,
        threadId: raw.threadId,
        subject: raw.subject,
        from: raw.from,
        to: raw.to,
        cc: raw.cc,
        snippet: raw.snippet,
        body: raw.body,
        // Same sanitizer as the DB-backed detail route — raw htmlBody never
        // reaches a client from here either. Failure degrades to null and the
        // plain body stays authoritative.
        renderHtml: (() => {
          try {
            return renderableEmailHtmlFor(raw.body, raw.htmlBody);
          } catch {
            return null;
          }
        })(),
        receivedAt: raw.receivedAt.toISOString(),
        isRead: raw.isRead,
      },
    };
  });

  // Remove the ORIGINAL Gmail draft after a draft-based send — without this
  // the sent mail and its stale draft coexist and the folder looks broken.
  // 404 (not found) is a legitimate outcome, not an error: the draft may
  // have been sent or deleted from another client already.
  app.delete("/draft/by-message/:gmailId", async (request, reply) => {
    const { gmailId } = request.params as { gmailId: string };
    const { inbox } = request.query as { inbox?: string };
    const uid = getUserId(request);
    const deleted = await deleteGmailDraftByMessageId(uid, gmailId, inbox);
    if (!deleted) {
      return reply.code(404).send({ success: false, error: "Draft not found" });
    }
    return { success: true };
  });
}
