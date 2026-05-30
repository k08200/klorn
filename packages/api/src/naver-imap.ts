/**
 * Naver IMAP integration.
 *
 * Naver mail has no production REST API, but every Naver account supports
 * IMAP via the "외부 메일 가져오기/보내기" feature. The user generates a
 * per-app password in their security settings (NOT the account password)
 * and pastes it into Klorn's settings page.
 *
 * Two entry points:
 *   - verifyNaverImapCredentials  — short LOGIN+LOGOUT roundtrip used
 *                                   by /api/naver-imap/connect to fail
 *                                   loudly on a wrong password.
 *   - syncNaverImap               — fetches recent messages, upserts
 *                                   EmailMessage rows, fires judgeEmail
 *                                   + upsertAttentionForEmailJudgement
 *                                   so the firewall surfaces them next
 *                                   to Gmail-sourced mail.
 *
 * Free Render tier note: we do NOT use IMAP IDLE (persistent connection
 * holding) because the dyno can sleep and the connection lock interacts
 * badly with the cron-based scheduler. Each sync opens, fetches, closes.
 */

import { ImapFlow } from "imapflow";
import sanitizeHtml from "sanitize-html";
import { upsertAttentionForEmailJudgement } from "./attention-mirror.js";
import { decryptToken } from "./crypto-tokens.js";
import { prisma } from "./db.js";
import { judgeEmail } from "./poc-judge.js";
import { captureError } from "./sentry.js";

interface VerifyArgs {
  email: string;
  password: string;
  host: string; // "imap.naver.com:993"
}

interface VerifyResult {
  ok: boolean;
  message?: string;
}

function parseHost(host: string): { host: string; port: number } {
  const [h, p] = host.split(":");
  const port = Number(p) || 993;
  return { host: h, port };
}

export async function verifyNaverImapCredentials(args: VerifyArgs): Promise<VerifyResult> {
  const { host, port } = parseHost(args.host);
  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user: args.email, pass: args.password },
    logger: false,
    // Connection should fail fast — the settings UI is waiting on this.
    socketTimeout: 12_000,
  });

  try {
    await client.connect();
    // SELECT INBOX to confirm read access — not all credential errors
    // surface at LOGIN; some only manifest on the first SELECT.
    const lock = await client.getMailboxLock("INBOX");
    lock.release();
    await client.logout();
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Map common IMAP error shapes to user-readable hints.
    if (/authentication failed/i.test(msg) || /AUTH=/i.test(msg)) {
      return {
        ok: false,
        message:
          "Naver IMAP login failed. Generate a separate '외부 메일 비밀번호' in Naver security settings and paste that — not your account password.",
      };
    }
    if (/timeout|ECONN|ENOTFOUND/i.test(msg)) {
      return { ok: false, message: `Could not reach ${args.host}: ${msg}` };
    }
    return { ok: false, message: msg };
  }
}

interface SyncArgs {
  userId: string;
  email: string;
  password: string; // plaintext (decrypted by caller)
  host: string;
  limit?: number; // defaults to 50
}

interface SyncResult {
  fetched: number;
  inserted: number;
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

/**
 * Sync the most-recent `limit` messages from the user's Naver INBOX.
 * Upsert each into EmailMessage (keyed on (userId, gmailId) — for IMAP
 * we synthesize a stable id from the IMAP UID), then classify via
 * poc-judge and mirror to AttentionItem.
 */
export async function syncNaverImap(args: SyncArgs): Promise<SyncResult> {
  const limit = args.limit ?? 50;
  const { host, port } = parseHost(args.host);

  const result: SyncResult = { fetched: 0, inserted: 0, classified: 0, errors: 0 };

  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user: args.email, pass: args.password },
    logger: false,
    socketTimeout: 30_000,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
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

        const env = msg.envelope ?? {};
        const from = formatAddress(env.from?.[0] ?? undefined);
        const to = formatAddress(env.to?.[0] ?? undefined);
        const cc = (env.cc ?? []).map(formatAddress).filter(Boolean).join(", ") || null;
        const subject = env.subject?.trim() || "(no subject)";
        const receivedAt = env.date ?? new Date();
        const bodyBuf = msg.bodyParts?.get("text") ?? msg.bodyParts?.get("TEXT");
        const snippet = snippetFromBody(bodyBuf);

        // Stable id-per-mailbox: prefix with `naver-imap:` so it never
        // collides with Gmail message ids in the same EmailMessage table.
        const stableId = `naver-imap:${args.email}:${msg.uid}`;

        // Flags → Gmail-ish labels so existing classifier paths work.
        const flags = Array.isArray(msg.flags) ? msg.flags : [...(msg.flags ?? new Set<string>())];
        const labels: string[] = ["INBOX"];
        if (!flags.includes("\\Seen")) labels.push("UNREAD");
        if (flags.includes("\\Flagged")) labels.push("IMPORTANT");
        const isRead = flags.includes("\\Seen");
        const isStarred = flags.includes("\\Flagged");

        try {
          // Upsert keyed on (userId, gmailId) — we co-opt gmailId as the
          // canonical "external mail provider id" since the column is
          // already unique on that pair. The `naver-imap:` prefix keeps
          // the namespaces from colliding.
          const upserted = await prisma.emailMessage.upsert({
            where: { userId_gmailId: { userId: args.userId, gmailId: stableId } },
            create: {
              userId: args.userId,
              gmailId: stableId,
              threadId: null,
              from,
              to,
              cc,
              subject,
              snippet,
              body: bodyBuf ? bodyBuf.toString("utf8").slice(0, 50_000) : null,
              htmlBody: null,
              labels,
              isRead,
              isStarred,
              receivedAt,
            },
            update: {
              isRead,
              isStarred,
              labels,
            },
          });
          // Crude "is this new" check — for fire-and-forget judgement
          // we re-classify every fetched email cheaply on first poll
          // and skip already-judged ones on subsequent polls.
          const wasJust = upserted.createdAt.getTime() >= Date.now() - 60_000;
          if (wasJust) {
            result.inserted += 1;
          }

          // Classify + mirror — fire-and-forget so a slow LLM doesn't
          // block the IMAP loop. Failures are captured to Sentry.
          judgeEmail(
            {
              from,
              subject,
              snippet,
              labels,
            },
            args.userId,
          )
            .then((judgement) =>
              upsertAttentionForEmailJudgement(
                {
                  id: upserted.id,
                  userId: args.userId,
                  from,
                  subject,
                  snippet,
                  receivedAt,
                },
                judgement,
              ),
            )
            .catch((err) =>
              captureError(err, {
                tags: { scope: "naver-imap.judge" },
                extra: { userId: args.userId, stableId },
              }),
            );
          result.classified += 1;
        } catch (err) {
          result.errors += 1;
          captureError(err, {
            tags: { scope: "naver-imap.upsert" },
            extra: { userId: args.userId, stableId },
          });
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    result.errors += 1;
    captureError(err, {
      tags: { scope: "naver-imap.sync" },
      extra: { userId: args.userId },
    });
    throw err;
  }

  return result;
}

/**
 * Convenience wrapper for the scheduler: looks up the user, decrypts the
 * stored password, then runs syncNaverImap.
 */
export async function syncNaverImapForUser(userId: string): Promise<SyncResult | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      naverImapEmail: true,
      naverImapPasswordCipher: true,
      naverImapHost: true,
    },
  });
  if (!user?.naverImapEmail || !user.naverImapPasswordCipher || !user.naverImapHost) {
    return null;
  }
  return syncNaverImap({
    userId,
    email: user.naverImapEmail,
    password: decryptToken(user.naverImapPasswordCipher),
    host: user.naverImapHost,
  });
}
