/**
 * Outlook (Microsoft Graph) inbox ingestion — Phase 3B of
 * docs/providers/multi-provider-plan.md.
 *
 * Delta-query poll against /me/mailFolders/inbox/messages/delta, handing
 * every message to the shared persist path (persistGmailEmail) exactly like
 * the Gmail and IMAP paths — dedup, judge + attention mirroring, PUSH
 * interrupts, commitment mining all live there.
 *
 * Cursor model: Graph delta pages via @odata.nextLink and finishes with an
 * @odata.deltaLink. We cap pages per tick (a first sync of a large mailbox
 * would otherwise be unbounded) and store WHICHEVER link we stopped at as
 * the row's cursor — a nextLink resumes the catch-up next tick, a deltaLink
 * yields only changes from then on. The cursor lives in
 * LinkedInboxAccount.historyId (the provider-generic sync watermark: Gmail
 * historyId for GOOGLE rows, Graph delta/next link for OUTLOOK rows — same
 * co-opt precedent as gmailId holding provider message ids).
 *
 * Two Prefer headers are load-bearing:
 * - IdType="ImmutableId": default Graph message ids CHANGE when a message
 *   moves folder (archive would orphan every stored id and re-ingest mail).
 * - outlook.body-content-type="text": text bodies, no HTML stripping needed.
 */

import { persistGmailEmail } from "../judge/email-firewall.js";
import { captureError } from "../sentry.js";
import { formatMailbox } from "./email-address.js";

const GRAPH_ORIGIN = "https://graph.microsoft.com/";
const PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 4;
const SELECT_FIELDS =
  "id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,isRead,flag,body";

export interface OutlookSyncArgs {
  userId: string;
  /** The linked mailbox's own address (normalized) — provenance + self-sent detection. */
  email: string;
  accessToken: string; // plaintext bearer (decrypted by caller)
  linkedInboxAccountId: string;
  /** Stored delta/next link from the previous tick, or null for a first sync. */
  cursor: string | null;
  maxPages?: number;
}

export interface OutlookSyncResult {
  fetched: number;
  inserted: number;
  classified: number;
  errors: number;
  /** The link to persist for the next tick; null when nothing new was learned. */
  cursor: string | null;
  /** 401/403 from Graph — the caller must flag the row for reconnect. */
  authFailed: boolean;
}

interface GraphEmailAddress {
  emailAddress?: { name?: string | null; address?: string | null } | null;
}
interface GraphMessage {
  id?: string;
  "@removed"?: unknown;
  subject?: string | null;
  from?: GraphEmailAddress | null;
  toRecipients?: GraphEmailAddress[] | null;
  ccRecipients?: GraphEmailAddress[] | null;
  receivedDateTime?: string | null;
  bodyPreview?: string | null;
  isRead?: boolean | null;
  flag?: { flagStatus?: string | null } | null;
  body?: { content?: string | null } | null;
}
interface GraphDeltaPage {
  value?: GraphMessage[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

function formatAddress(addr: GraphEmailAddress | null | undefined): string {
  const a = addr?.emailAddress?.address?.trim() ?? "";
  const n = addr?.emailAddress?.name?.trim() ?? "";
  return formatMailbox(n === a ? "" : n, a);
}

function initialDeltaUrl(): string {
  const params = new URLSearchParams({ $top: String(PAGE_SIZE), $select: SELECT_FIELDS });
  return `${GRAPH_ORIGIN}v1.0/me/mailFolders/inbox/messages/delta?${params.toString()}`;
}

/**
 * Only ever GET links on graph.microsoft.com. The cursor round-trips through
 * a DB column — a tampered or corrupted row must not turn the poll into a
 * bearer-token-bearing request to an arbitrary host (SSRF + token exfil).
 */
function isGraphLink(url: string): boolean {
  return url.startsWith(GRAPH_ORIGIN);
}

export async function syncOutlookInbox(args: OutlookSyncArgs): Promise<OutlookSyncResult> {
  const maxPages = args.maxPages ?? DEFAULT_MAX_PAGES;
  const result: OutlookSyncResult = {
    fetched: 0,
    inserted: 0,
    classified: 0,
    errors: 0,
    cursor: null,
    authFailed: false,
  };

  let url = args.cursor && isGraphLink(args.cursor) ? args.cursor : initialDeltaUrl();

  for (let page = 0; page < maxPages; page++) {
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${args.accessToken}`,
        Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"',
      },
      // A hung Graph call would stall the whole tick (and overlapping ticks
      // are what make the concurrent-refresh race real) — fail fast instead.
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401 || res.status === 403) {
      result.authFailed = true;
      return result;
    }
    if (res.status === 429) {
      // Graph throttling: stop this tick, resume from the same cursor next
      // tick (we deliberately did NOT advance result.cursor past `url`).
      console.warn(`[outlook-sync] throttled (429) for ${args.userId}; retrying next tick`);
      result.errors += 1;
      return result;
    }
    if (!res.ok) {
      console.warn(`[outlook-sync] delta fetch failed for ${args.userId}: http ${res.status}`);
      result.errors += 1;
      return result;
    }
    const body = (await res.json()) as GraphDeltaPage;

    for (const msg of body.value ?? []) {
      // Deletions/moves-out surface as @removed entries — Klorn keeps past
      // mail (AttentionItem/DecisionLabel reference it), so skip them.
      if (!msg.id || msg["@removed"] !== undefined) continue;
      result.fetched += 1;

      const from = formatAddress(msg.from);
      const to = formatAddress(msg.toRecipients?.[0]);
      const cc = (msg.ccRecipients ?? []).map(formatAddress).filter(Boolean).join(", ") || "";
      const subject = msg.subject?.trim() || "(no subject)";
      // Invalid Date would make Prisma reject the create and permanently drop
      // the email (delta pages never replay) — same guard as gmail-fetch's
      // parseReceivedAt.
      const parsedReceived = msg.receivedDateTime ? new Date(msg.receivedDateTime) : null;
      const receivedAt =
        parsedReceived && !Number.isNaN(parsedReceived.getTime()) ? parsedReceived : new Date();
      const isRead = msg.isRead === true;
      const isStarred = msg.flag?.flagStatus === "flagged";
      const labels: string[] = ["INBOX"];
      if (!isRead) labels.push("UNREAD");
      if (isStarred) labels.push("IMPORTANT");
      const bodyText = msg.body?.content ?? "";

      // Same namespacing rule as the IMAP providers (`naver-imap:`,
      // `icloud-imap:`): provider prefix + mailbox address keeps the Graph
      // immutable id from colliding with any other provider's ids — or the
      // same message reaching two linked Outlook mailboxes — in the
      // (userId, gmailId) dedup key.
      const stableId = `outlook:${args.email}:${msg.id}`;

      try {
        const persisted = await persistGmailEmail(
          args.userId,
          {
            gmailId: stableId,
            threadId: null,
            from,
            to,
            cc,
            subject,
            snippet: (msg.bodyPreview ?? "").slice(0, 200),
            body: bodyText.slice(0, 50_000),
            htmlBody: "",
            labels,
            isRead,
            isStarred,
            receivedAt,
            attachments: [],
          },
          {
            linkedInboxAccountId: args.linkedInboxAccountId,
            // Self-sent detection and commitment senderIsUser compare against
            // THIS mailbox's address, not the primary Google account.
            userEmail: args.email,
          },
        );
        if (persisted.isNew) {
          result.inserted += 1;
          result.classified += 1;
        }
      } catch (err) {
        result.errors += 1;
        // console first: captureError is a no-op without a Sentry DSN.
        console.warn(`[outlook-sync] persist failed for ${stableId}`, err);
        captureError(err, {
          tags: { scope: "outlook-sync.upsert" },
          extra: { userId: args.userId, stableId },
        });
      }
    }

    const nextLink = body["@odata.nextLink"];
    const deltaLink = body["@odata.deltaLink"];
    if (nextLink && isGraphLink(nextLink)) {
      // More pages exist. Persist the nextLink as the cursor FIRST so a page
      // cap (or a failure on the next page) resumes instead of restarting.
      result.cursor = nextLink;
      url = nextLink;
      continue;
    }
    if (deltaLink && isGraphLink(deltaLink)) {
      result.cursor = deltaLink;
    }
    return result;
  }

  // Page cap hit with a nextLink still pending — result.cursor already holds
  // it; the next tick resumes the catch-up from there.
  return result;
}
