/**
 * Generalized IMAP integration (Phase 2 of the multi-provider plan;
 * formerly naver-imap.ts — Naver-only until then).
 *
 * Providers without a production REST API (Naver, iCloud) support IMAP with
 * a per-app password the user generates in their account security settings
 * (NOT the account password) and pastes into Klorn's settings page. Which
 * providers exist, their hosts, dedup-key prefixes, and error copy live in
 * imap-providers.ts — this module owns only the IMAP conversation.
 *
 * Two entry points:
 *   - verifyImapCredentials — short LOGIN+LOGOUT roundtrip used by the
 *                             connect route to fail loudly on a wrong
 *                             password.
 *   - syncImapInbox         — fetches recent messages and hands each to the
 *                             shared persist path (persistGmailEmail), which
 *                             owns dedup, judge + attention mirroring, and
 *                             PUSH interrupts — identical to Gmail ingest.
 *
 * Free Render tier note: we do NOT use IMAP IDLE (persistent connection
 * holding) because the dyno can sleep and the connection lock interacts
 * badly with the cron-based scheduler. Each sync opens, fetches, closes.
 */

import sanitizeHtml from "sanitize-html";

import { persistGmailEmail } from "../judge/email-firewall.js";
import { captureError } from "../sentry.js";
import { createImapClient, endImapSession } from "./imap-connection.js";
import { envelopeSubject } from "./imap-envelope.js";
import { formatImapMessageId } from "./imap-message-id.js";
import { reconcileInboxValidity, removeRecentlyMovedRows } from "./imap-poll-guards.js";
import type { ImapProviderConfig } from "./imap-providers.js";
import { liveUidValidity } from "./imap-uidvalidity.js";

interface VerifyArgs {
  provider: ImapProviderConfig;
  email: string;
  password: string;
  host: string; // "imap.naver.com:993"
}

interface VerifyResult {
  ok: boolean;
  message?: string;
}

export async function verifyImapCredentials(args: VerifyArgs): Promise<VerifyResult> {
  try {
    const client = createImapClient({
      provider: args.provider,
      host: args.host,
      email: args.email,
      password: args.password,
      // Connection should fail fast — the settings UI is waiting on this.
      socketTimeout: 12_000,
    });
    try {
      await client.connect();
      // SELECT INBOX to confirm read access — not all credential errors
      // surface at LOGIN; some only manifest on the first SELECT.
      const lock = await client.getMailboxLock("INBOX");
      lock.release();
      return { ok: true };
    } finally {
      await endImapSession(client);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Map common IMAP error shapes to user-readable hints.
    if (/authentication failed/i.test(msg) || /AUTH=/i.test(msg)) {
      return { ok: false, message: args.provider.authFailureHint };
    }
    if (/timeout|ECONN|ENOTFOUND/i.test(msg)) {
      return { ok: false, message: `Could not reach ${args.host}: ${msg}` };
    }
    return { ok: false, message: msg };
  }
}

interface SyncArgs {
  provider: ImapProviderConfig;
  userId: string;
  email: string;
  password: string; // plaintext (decrypted by caller)
  host: string;
  // The LinkedInboxAccount row this mailbox belongs to (Phase 0b). Stamped on
  // every EmailMessage so IMAP mail carries real provenance instead of being
  // indistinguishable from primary-account mail.
  linkedInboxAccountId?: string;
  // The INBOX UIDVALIDITY stored on that row (step B2), so the poll can tell a
  // renumbered mailbox from an unchanged one. Null/absent = none recorded yet.
  inboxUidValidity?: string | null;
  // Step B2b, from the same row: a reset seen on an earlier poll and when, and when
  // the last repair ran (imap-uidvalidity-reset.ts). Null/absent = none.
  inboxUidValidityPending?: string | null;
  inboxUidValidityPendingAt?: Date | null;
  inboxUidValidityResetAt?: Date | null;
  limit?: number; // defaults to 50
}

interface SyncResult {
  fetched: number;
  inserted: number;
  // Kept for wire/aggregate stability: classification now happens inside the
  // shared persist path (fire-and-forget), so this equals `inserted` — every
  // first-seen email is handed to the judge.
  classified: number;
  errors: number;
}

interface ImapEnvelopeAddress {
  address?: string | null;
  name?: string | null;
}
interface ImapEnvelope {
  from?: ImapEnvelopeAddress[] | null;
  to?: ImapEnvelopeAddress[] | null;
  cc?: ImapEnvelopeAddress[] | null;
  subject?: string | null;
  date?: Date | null;
  messageId?: string | null;
}
interface ImapFetchMessage {
  uid: number;
  envelope?: ImapEnvelope | null;
  flags?: Set<string> | string[];
  bodyParts?: Map<string, Buffer>;
  source?: Buffer;
}

function formatAddress(addr: ImapEnvelopeAddress | undefined): string {
  if (!addr) return "";
  const a = addr.address?.trim() ?? "";
  const n = addr.name?.trim() ?? "";
  if (n && a) return `${n} <${a}>`;
  return a || n;
}

function snippetFromBody(buf: Buffer | undefined, max = 200): string | null {
  if (!buf) return null;
  // Strip HTML through sanitize-html (proper parser) rather than regex —
  // CodeQL flags regex-based tag stripping as bad-tag-filter even when
  // the output is never rendered. The judge prompt only needs the first
  // sentence or two so we collapse whitespace and slice.
  const stripped = sanitizeHtml(buf.toString("utf8"), {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: "discard",
  });
  const text = stripped.replace(/\s+/g, " ").trim();
  return text.slice(0, max) || null;
}

type PersistCall = [
  email: Parameters<typeof persistGmailEmail>[1],
  options: NonNullable<Parameters<typeof persistGmailEmail>[2]>,
];

/**
 * Turn one fetched message into the arguments of the shared persist call. Used by
 * the poll and by the targeted re-sync after an undo, so both write a row the same
 * way. Pure: the poll runs it outside its per-message error handling, as it always
 * has.
 */
function toPersistCall(args: SyncArgs, msg: ImapFetchMessage): PersistCall {
  const env = msg.envelope ?? {};
  const from = formatAddress(env.from?.[0] ?? undefined);
  const to = formatAddress(env.to?.[0] ?? undefined);
  const cc = (env.cc ?? []).map(formatAddress).filter(Boolean).join(", ") || null;
  const subject = envelopeSubject(env.subject);
  const receivedAt = env.date ?? new Date();
  const bodyBuf = msg.bodyParts?.get("text") ?? msg.bodyParts?.get("TEXT");
  const snippet = snippetFromBody(bodyBuf);
  const stableId = formatImapMessageId(args.provider.idPrefix, args.email, msg.uid);

  // Flags → Gmail-ish labels so existing classifier paths work.
  const flags = Array.isArray(msg.flags) ? msg.flags : [...(msg.flags ?? new Set<string>())];
  const labels: string[] = ["INBOX"];
  if (!flags.includes("\\Seen")) labels.push("UNREAD");
  if (flags.includes("\\Flagged")) labels.push("IMPORTANT");
  const isRead = flags.includes("\\Seen");
  const isStarred = flags.includes("\\Flagged");

  // Shared persist path (Phase 1): the same fetch→normalize→persist→judge pipeline
  // Gmail ingestion uses. We still co-opt gmailId as the canonical "external mail
  // provider id" (the idPrefix keeps the namespaces from colliding), and
  // persistGmailEmail owns dedup, fromAddress normalization, commitment mining, and
  // the fire-and-forget judge + attention mirror — including PUSH interrupts and
  // judge-health recording the old inline judge lacked.
  return [
    {
      gmailId: stableId,
      threadId: null,
      from,
      to,
      cc: cc ?? "",
      subject,
      snippet: snippet ?? "",
      body: bodyBuf ? bodyBuf.toString("utf8").slice(0, 50_000) : "",
      htmlBody: "",
      labels,
      isRead,
      isStarred,
      receivedAt,
      attachments: [],
    },
    {
      linkedInboxAccountId: args.linkedInboxAccountId ?? null,
      // Self-sent detection and commitment senderIsUser must compare against THIS
      // mailbox's address, not the primary Google account (same as email-sync's
      // linked fan-out passing linked.email).
      userEmail: args.email,
    },
  ];
}

/**
 * Sync the most-recent `limit` messages from the mailbox's INBOX.
 * Upsert each into EmailMessage (keyed on (userId, gmailId) — for IMAP
 * we synthesize a stable id from the IMAP UID), then classify via
 * poc-judge and mirror to AttentionItem.
 */
export async function syncImapInbox(args: SyncArgs): Promise<SyncResult> {
  const limit = args.limit ?? 50;
  const scope = args.provider.logScope;

  const result: SyncResult = { fetched: 0, inserted: 0, classified: 0, errors: 0 };

  const client = createImapClient({
    provider: args.provider,
    host: args.host,
    email: args.email,
    password: args.password,
    socketTimeout: 30_000,
    accountId: args.linkedInboxAccountId,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      if (args.linkedInboxAccountId) {
        // Steps B2 and B2b, imap-poll-guards.ts: record the INBOX UIDVALIDITY, or,
        // when the server renumbered the mailbox, hold it and repair a confirmed reset.
        const gate = await reconcileInboxValidity({
          provider: args.provider,
          userId: args.userId,
          email: args.email,
          linkedInboxAccountId: args.linkedInboxAccountId,
          stored: args.inboxUidValidity,
          pending: args.inboxUidValidityPending,
          pendingAt: args.inboxUidValidityPendingAt,
          resetAt: args.inboxUidValidityResetAt,
          live: liveUidValidity(client.mailbox),
        });
        // A held mailbox persists nothing: under the old stored value a new message
        // that reuses an old UID would be deduped into the stale row.
        if (gate === "hold") return result;
      }
      const status = await client.status("INBOX", { messages: true });
      const totalMessages = status.messages ?? 0;
      if (totalMessages === 0) {
        return result;
      }
      const from = Math.max(1, totalMessages - limit + 1);
      const range = `${from}:${totalMessages}`;

      // IMAP FETCH returns an async iterable. Pull envelope + a small
      // body part (plain text first). The full RFC822 body is too large
      // to store routinely for a POC.
      for await (const raw of client.fetch(
        range,
        {
          envelope: true,
          flags: true,
          bodyParts: ["TEXT"],
        },
        { uid: false },
      )) {
        const msg = raw as ImapFetchMessage;
        result.fetched += 1;
        // Stable id-per-mailbox: the provider's idPrefix (`naver-imap:`,
        // `icloud-imap:`) keeps it from colliding with Gmail message ids —
        // or another provider's UIDs — in the same EmailMessage table.
        const stableId = formatImapMessageId(args.provider.idPrefix, args.email, msg.uid);

        const persistCall = toPersistCall(args, msg);

        try {
          const persisted = await persistGmailEmail(args.userId, ...persistCall);
          // `isNew` from the persist result replaces the old "created in the
          // last 60s" heuristic — a slow tick can no longer double-judge, and
          // re-touched rows (the poll re-fetches its window every cycle) are
          // never re-judged or resurrected in the attention mirror.
          if (persisted.isNew) {
            result.inserted += 1;
            result.classified += 1;
          }
        } catch (err) {
          result.errors += 1;
          // console first: captureError is a no-op without a Sentry DSN, so in
          // dev/self-host a persist failure would drop this email from triage
          // with no trace.
          console.warn(`[${scope}] persist failed for ${stableId}`, err);
          captureError(err, {
            tags: { scope: `${scope}.upsert` },
            extra: { userId: args.userId, stableId },
          });
        }
      }
      if (args.linkedInboxAccountId) {
        // A message Klorn moved out while this window was being persisted must not
        // stay behind as a row (step B2). Never reached while the mailbox is held, and
        // moves recorded before the last repair are ignored: their ids are old numbers.
        await removeRecentlyMovedRows({
          userId: args.userId,
          linkedInboxAccountId: args.linkedInboxAccountId,
          provider: args.provider,
          notBefore: args.inboxUidValidityResetAt ?? null,
        });
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    result.errors += 1;
    // console first — captureError is silent without a Sentry DSN (self-host/dev).
    console.warn(
      `[${scope}] sync failed for ${args.userId}:`,
      err instanceof Error ? err.message : String(err),
    );
    captureError(err, {
      tags: { scope: `${scope}.sync` },
      extra: { userId: args.userId },
    });
    throw err;
  } finally {
    // Every exit path closes the session: the empty-mailbox early return, a
    // failed connect or fetch, and success. Without this a failed poll left
    // its socket to imapflow's 5-minute inactivity timeout.
    await endImapSession(client);
  }

  return result;
}

interface SyncMessageArgs {
  provider: ImapProviderConfig;
  userId: string;
  email: string;
  password: string; // plaintext (decrypted by caller)
  host: string;
  linkedInboxAccountId: string;
  uid: number;
}

/**
 * Ingest ONE message of the INBOX by UID, through the same persist path as the
 * poll. Used after an undo (step B2): the restored message has a NEW UID, so the
 * route needs its row immediately, under the id the next poll will also use.
 * Resolves with the row id, or null when the UID is not in INBOX. Errors propagate.
 */
export async function syncImapMessage(args: SyncMessageArgs): Promise<{ emailId: string } | null> {
  const client = createImapClient({
    provider: args.provider,
    host: args.host,
    email: args.email,
    password: args.password,
    socketTimeout: 30_000,
    accountId: args.linkedInboxAccountId,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      for await (const raw of client.fetch(
        String(args.uid),
        { envelope: true, flags: true, bodyParts: ["TEXT"] },
        { uid: true },
      )) {
        const persistCall = toPersistCall(args, raw as ImapFetchMessage);
        const persisted = await persistGmailEmail(args.userId, ...persistCall);
        return { emailId: persisted.emailId };
      }
      return null;
    } finally {
      lock.release();
    }
  } finally {
    await endImapSession(client);
  }
}
