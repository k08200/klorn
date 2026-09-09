/**
 * Live folder listings — Sent / Drafts / Archived.
 *
 * Every serious mail client shows these folders; Klorn's local mirror is
 * INBOX-only by design (the classifier's input), so the folders are read live
 * from Gmail instead of widening the sync. `gmail.readonly` already covers
 * every label — no new scope.
 *
 * Listing is METADATA-ONLY: a folder view renders sender / subject / snippet /
 * time, and downloading 50 full MIME trees (bodies + attachment bytes) to
 * paint 50 rows is the mistake `fetchGmailEmails` makes acceptable only
 * because sync needs the bodies. Opening a message goes through the existing
 * detail path, which fetches exactly one.
 */

import { google } from "googleapis";
import { Semaphore } from "../semaphore.js";
import { getAuthedClient, getAuthedInboxClient, getLinkedInboxClients } from "./gmail.js";

type OAuth2 = InstanceType<typeof google.auth.OAuth2>;

export const MAILBOXES = ["sent", "drafts", "archived"] as const;
export type Mailbox = (typeof MAILBOXES)[number];

/** One row of a folder listing — what the list renders, nothing more. */
export interface MailboxItemWire {
  gmailId: string;
  threadId: string | null;
  subject: string;
  from: string;
  to: string;
  snippet: string;
  /** ISO. Gmail's internalDate (epoch ms) is the arrival authority. */
  receivedAt: string;
  isRead: boolean;
  /**
   * Which account the row lives in: "primary" or a LinkedInboxAccount id.
   * Every follow-up (open, delete the draft) must go back to the same
   * account — a Gmail message id only exists in the mailbox that issued it.
   */
  inbox: string;
}

/** One connected Google account the folders can read, keyed like `inbox`. */
interface MailboxAccount {
  key: string;
  auth: OAuth2;
}

/**
 * The OAuth client an `inbox=` scope acts on, for single-message follow-ups
 * (open, delete draft). Absent / "primary" / "all" = the user's own Google
 * account; anything else = one LinkedInboxAccount id, userId-scoped by the
 * lookup so a foreign id resolves to null rather than someone else's mail.
 */
export async function resolveMailboxClient(
  userId: string,
  inbox: string | undefined,
): Promise<OAuth2 | null> {
  if (!inbox || inbox === "primary" || inbox === "all") return getAuthedClient(userId);
  return getAuthedInboxClient(userId, inbox);
}

/**
 * Which accounts a listing scope names (mirrors routes/email.ts's `inbox=`):
 * absent or "primary" = the user's own inbox, "all" = every connected Google
 * account, anything else = one linked account. Null = nothing connected for
 * that scope — the route decides between demo rows (primary) and 404 (a
 * linked id that does not resolve must never show demo mail).
 */
async function accountsFor(
  userId: string,
  inbox: string | undefined,
): Promise<MailboxAccount[] | null> {
  if (inbox === "all") {
    const [primary, linked] = await Promise.all([
      getAuthedClient(userId),
      getLinkedInboxClients(userId),
    ]);
    const accounts = [
      ...(primary ? [{ key: "primary", auth: primary }] : []),
      ...linked.map((l) => ({ key: l.id, auth: l.client })),
    ];
    return accounts.length ? accounts : null;
  }
  const auth = await resolveMailboxClient(userId, inbox);
  if (!auth) return null;
  return [{ key: inbox && inbox !== "primary" ? inbox : "primary", auth }];
}

/**
 * "all" pages every account on its own Gmail cursor while the client sees ONE
 * opaque token: base64url JSON of {accountKey: cursor}, listing only the
 * accounts that still have a page. Garbage decodes to null (= first page),
 * never a throw — a stale token from an older build is a retry, not a 500.
 */
export function encodeCompositeToken(cursors: Record<string, string>): string | null {
  if (!Object.keys(cursors).length) return null;
  return Buffer.from(JSON.stringify(cursors), "utf8").toString("base64url");
}

export function decodeCompositeToken(token: string | undefined): Record<string, string> | null {
  if (!token) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const cursors = Object.fromEntries(
      Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
    return Object.keys(cursors).length ? cursors : null;
  } catch {
    return null;
  }
}

/**
 * The box → Gmail search mapping, exported for its tests: "archived" is a
 * negative-space query (mail that is in no folder at all) and every exclusion
 * carries weight — dropping `-in:trash` resurfaces deleted mail in a folder
 * the user thinks of as safe.
 */
export function buildMailboxQuery(box: Mailbox): string {
  switch (box) {
    case "sent":
      return "in:sent";
    case "drafts":
      return "in:draft";
    case "archived":
      return "-in:inbox -in:sent -in:draft -in:trash -in:spam -in:chats";
  }
}

const PAGE_SIZE = 50;
const METADATA_CONCURRENCY = 8;

function header(headers: { name?: string | null; value?: string | null }[], name: string): string {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** One page of a folder listing plus the cursor to the next. */
export interface MailboxPage {
  items: MailboxItemWire[];
  /** Opaque Gmail cursor; null on the final page. Round-trips verbatim. */
  nextPageToken: string | null;
}

/**
 * List one folder page, newest first, PAGE_SIZE rows. 50 rows used to be a
 * hard cut — a Sent folder past one page just ended; the page token turns
 * that into "load more". Returns null when Gmail is not connected so the
 * route can fall back to demo data the same way the inbox list does.
 * Metadata fetches run under a small semaphore — 50 parallel requests is how
 * a folder click turns into a Gmail 429.
 */
export async function listGmailMailbox(
  userId: string,
  box: Mailbox,
  pageToken?: string,
  inbox?: string,
): Promise<MailboxPage | null> {
  const accounts = await accountsFor(userId, inbox);
  if (!accounts) return null;
  if (inbox !== "all") return listAccountPage(accounts[0], box, pageToken);
  return listAllAccountsPage(accounts, box, pageToken);
}

/** One page across every connected account, merged newest-first. Each
 *  account advances on its own cursor (see encodeCompositeToken); a page
 *  boundary can interleave slightly across accounts, which Gmail's own
 *  list order does not promise either. */
async function listAllAccountsPage(
  accounts: MailboxAccount[],
  box: Mailbox,
  pageToken: string | undefined,
): Promise<MailboxPage> {
  const cursors = decodeCompositeToken(pageToken);
  const targets = cursors ? accounts.filter((a) => a.key in cursors) : accounts;
  const pages = await Promise.all(
    targets.map((account) => listAccountPage(account, box, cursors?.[account.key])),
  );
  const next = Object.fromEntries(
    targets.flatMap((account, i) => {
      const token = pages[i].nextPageToken;
      return token ? [[account.key, token] as const] : [];
    }),
  );
  const items = pages
    .flatMap((page) => page.items)
    .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0));
  return { items, nextPageToken: encodeCompositeToken(next) };
}

async function listAccountPage(
  account: MailboxAccount,
  box: Mailbox,
  pageToken: string | undefined,
): Promise<MailboxPage> {
  const gmail = google.gmail({ version: "v1", auth: account.auth });
  const res = await gmail.users.messages.list({
    userId: "me",
    maxResults: PAGE_SIZE,
    q: buildMailboxQuery(box),
    ...(pageToken ? { pageToken } : {}),
  });
  const ids = (res.data.messages ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));

  const sem = new Semaphore(METADATA_CONCURRENCY);
  const rows = await sem.all<MailboxItemWire | null>(
    ids.map((id) => async () => {
      try {
        const detail = await gmail.users.messages.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date"],
        });
        const headers = detail.data.payload?.headers ?? [];
        const internal = Number(detail.data.internalDate);
        return {
          gmailId: detail.data.id ?? id,
          threadId: detail.data.threadId ?? null,
          subject: header(headers, "Subject"),
          from: header(headers, "From"),
          to: header(headers, "To"),
          snippet: detail.data.snippet ?? "",
          receivedAt: Number.isFinite(internal)
            ? new Date(internal).toISOString()
            : new Date(0).toISOString(),
          isRead: !(detail.data.labelIds ?? []).includes("UNREAD"),
          inbox: account.key,
        };
      } catch {
        // One unreadable message must not blank the folder.
        return null;
      }
    }),
  );
  return {
    items: rows.filter((r): r is MailboxItemWire => r !== null),
    nextPageToken: res.data.nextPageToken ?? null,
  };
}

/**
 * Delete the Gmail draft whose MESSAGE id is `gmailId`. The folder listing
 * hands out message ids (messages.list), but drafts.delete wants the DRAFT
 * id — deleting with the message id silently 404s and the draft lingers, so
 * this resolves through users.drafts.list first. Called after a draft-based
 * send so the original doesn't survive as a duplicate; best-effort by
 * contract (false = not found / not connected, never a throw for a missing
 * row).
 */
export async function deleteGmailDraftByMessageId(
  userId: string,
  gmailId: string,
  inbox?: string,
): Promise<boolean> {
  const auth = await resolveMailboxClient(userId, inbox);
  if (!auth) return false;

  const gmail = google.gmail({ version: "v1", auth });
  const res = await gmail.users.drafts.list({ userId: "me", maxResults: 100 });
  const draft = (res.data.drafts ?? []).find((d) => d.message?.id === gmailId);
  if (!draft?.id) return false;
  await gmail.users.drafts.delete({ userId: "me", id: draft.id });
  return true;
}
