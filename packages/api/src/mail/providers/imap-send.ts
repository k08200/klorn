/**
 * Send, reply and drafts for NAVER and ICLOUD — step B3 of
 * docs/providers/unified-platform-plan.md. Three actions of MailProviderActions:
 *
 *   sendEmail        SMTP submission (nodemailer), then the Sent copy over IMAP
 *   createDraft      IMAP APPEND to the \Drafts folder with the \Draft flag
 *   getReplyHeaders  the original's Message-ID and References, fetched by UID
 *
 * Reachable only while IMAP_SEND_ENABLED is on (dispatch.ts). The deterministic
 * floor is untouched: on the agent/chat path `send_email` still needs a verified
 * ActionReceipt before it ever reaches a provider (tool-executor.ts); this file
 * only implements what the provider does once it is called.
 *
 * Where a connection may go:
 *   - SMTP: only the registry host of the provider (`provider.smtp`), never
 *     anything from the account row. A row whose stored IMAP host fails the
 *     allowlist or the host pin is REFUSED before any connection or decryption
 *     (`findCheckedAccount`): such a row is corrupt, and its credential must not
 *     be sent anywhere on its say-so.
 *   - IMAP: the row's host, through `createImapClient`, which re-enforces the
 *     allowlist and host pin itself.
 *
 * Who the mail is from: the linked account's own address, in both the From header
 * and the SMTP envelope. Who it goes to: exactly one address, checked by the same
 * guard as Gmail's `sendEmail` and then by a stricter SMTP-address check; the
 * header carries that bare address (no display name, so the header is 7-bit).
 *
 * Result contract: like the B1 flag actions, these never throw. `{ error }` for
 * every failure; never `unsupported`. `getReplyHeaders` answers `{}` for any
 * failure, as its contract says. Concurrency, the global cap, the auth cooldown
 * and the deadlines (busy before anything is sent, a total bound on a running
 * task) are in imap-session.ts: one queue per account, shared with the B1 flag
 * actions.
 *
 * Sent copy: does Naver or iCloud SMTP file a copy in Sent by itself? Neither
 * provider's documentation says (Apple's "iCloud Mail server settings" page and
 * Naver's "IMAP/SMTP 설정 및 해제 방법" page are both silent), and mail clients
 * that submit over SMTP to iCloud store their own with an IMAP APPEND. Rather
 * than assume, the sender asks the server: it searches Sent for the message's own
 * Message-ID and APPENDs only when it is not there, so a server that files its
 * own copy gets no duplicate and one that does not gets exactly one. One search
 * right after the 250 cannot see a copy the server files later, nor one filed
 * under a rewritten Message-ID; that is checked on real accounts before the flip.
 * The copy happens after the message is gone, so it has a hard deadline
 * (SENT_COPY_DEADLINE_MS) and never changes the send's result.
 *
 * Known limit: if the connection drops after the message body was sent but
 * before the server's answer, the send is reported as `{ error }` though the
 * message may have been delivered. SMTP cannot tell the two apart.
 */

import type { ImapFlow, ListResponse } from "imapflow";

import { parseImapMessageId } from "../imap-message-id.js";
import {
  IMAP_PROVIDERS,
  type ImapProviderConfig,
  type ImapProviderKey,
} from "../imap-providers.js";
import {
  buildPlainTextMime,
  checkSendRecipient,
  invalidAddressMessage,
  isNoReplyAddress,
  looksLikeEmailAddress,
  newMessageId,
  PLAIN_ADDRESS_ONLY_MESSAGE,
  toSmtpAddress,
} from "../outbound-message.js";
import { classifySmtpFailure, openSmtpSession, type SmtpSession } from "../smtp-transport.js";
import { describeFailure, fail } from "./action-failure.js";
import { findCheckedAccount, sessionAccountFor } from "./imap-account.js";
import { fetchReplyHeaders } from "./imap-reply-headers.js";
import {
  noteSideFailure,
  runAccountTask,
  type SessionAccount,
  withImapClient,
} from "./imap-session.js";
import type {
  CreateDraftInput,
  CreateDraftResult,
  MailActionFailure,
  MailAttachment,
  MailProviderActions,
  ReplyHeadersResult,
  ReplyThreadingHeaders,
  SendMailOptions,
  SendMailResult,
} from "./types.js";

/** After a message has gone out, the Sent copy gets this long; the send's result never waits longer. */
export const SENT_COPY_DEADLINE_MS = 5_000;

/** A copy in Sent is a message the user already has: stored as read. */
const SENT_COPY_FLAGS: readonly string[] = ["\\Seen"];
/** RFC 3501 `\Draft`; `\Seen` keeps a draft out of the unread count. */
const DRAFT_FLAGS: readonly string[] = ["\\Draft", "\\Seen"];

type SendSurface = Pick<MailProviderActions, "sendEmail" | "createDraft" | "getReplyHeaders">;

/** A finished message: the bytes SMTP and APPEND carry, and what identifies it. */
interface OutboundMessage {
  raw: Buffer;
  messageId: string;
  date: Date;
}

const needsLinkedId = (provider: ImapProviderConfig) =>
  fail(`${provider.label} actions need the linked mailbox id.`);

/** The linked account as a session, or the failure to return. Opens nothing. */
async function prepareAccount(
  provider: ImapProviderConfig,
  userId: string,
  linkedInboxAccountId: string | null | undefined,
): Promise<SessionAccount | MailActionFailure> {
  // The primary inbox (null id) is always Google; an IMAP action without its
  // linked row id is the not-connected class.
  if (!linkedInboxAccountId) return needsLinkedId(provider);
  const checked = await findCheckedAccount(provider, userId, linkedInboxAccountId);
  if ("error" in checked) return checked;
  // The stored address becomes From and the SMTP sender: it must be a plain one.
  if (toSmtpAddress(checked.email) !== checked.email) {
    console.warn(`[${provider.logScope}] action skipped — unusable address for row ${checked.id}`);
    return fail(`${provider.label} mailbox is not connected.`);
  }
  return sessionAccountFor(provider, userId, checked);
}

function compose(
  from: string,
  to: string,
  subject: string,
  body: string,
  attachments: readonly MailAttachment[],
  threading: ReplyThreadingHeaders,
): OutboundMessage {
  const messageId = newMessageId(from);
  const date = new Date();
  const mime = buildPlainTextMime(to, subject, body, attachments, threading, {
    from,
    messageId,
    date,
  });
  return { raw: Buffer.from(mime, "utf-8"), messageId, date };
}

/** The server's own answer to a message it refused: a definite "no". */
function refusalFor(err: unknown, provider: ImapProviderConfig): MailActionFailure {
  const { code, command } = (err ?? {}) as { code?: unknown; command?: unknown };
  console.warn(`[${provider.logScope}] send refused by the server (${describeFailure(err)})`);
  if (code === "EMESSAGE") return fail(`${provider.label} refused the message.`);
  return command === "MAIL FROM"
    ? fail(`${provider.label} did not accept the sending address.`)
    : fail(`${provider.label} rejected the recipient address.`);
}

/** Delivery is unknown: the connection was up and then failed, or the deadline passed. */
const unconfirmedFailure = (provider: ImapProviderConfig): MailActionFailure =>
  fail(
    `${provider.label} did not confirm delivery. The message may or may not have been sent; check your Sent folder before trying again.`,
  );

/** Provably nothing was sent: the failure came before any MAIL FROM. */
const notSentFailure = (provider: ImapProviderConfig): MailActionFailure =>
  fail(`Could not reach ${provider.label}. The message was not sent; try again shortly.`);

/** nodemailer could not even be loaded or configured: not a problem reaching the mailbox. */
const sendingUnavailableFailure = (provider: ImapProviderConfig): MailActionFailure =>
  fail(
    `Sending through ${provider.label} is temporarily unavailable. The message was not sent; try again later.`,
  );

/**
 * The answer for a failed submission, from what the failure proves about delivery
 * (classifySmtpFailure). A rejected login is rethrown for the shared reconnect
 * handling and cooldown. Everything else is logged and reported (throttled, class
 * and code only) and answered here, so a failure on an established connection can
 * never read as "could not reach, try again shortly".
 */
function answerForSendFailure(
  err: unknown,
  connected: boolean,
  provider: ImapProviderConfig,
  account: SessionAccount,
): MailActionFailure {
  const kind = classifySmtpFailure(err, connected);
  if (kind === "auth") throw err;
  if (kind === "refused") return refusalFor(err, provider);
  noteSideFailure(err, provider, account);
  return kind === "not-sent" ? notSentFailure(provider) : unconfirmedFailure(provider);
}

/**
 * Hand the message to the provider's SMTP server. Returns the failure to report,
 * or null once the server has acknowledged the message (its 250).
 *
 * The session's socket is destroyed when the task is aborted, and again when this
 * returns, so it never outlives the task. Nothing is sent once the task has been
 * aborted: the caller was already told delivery is unconfirmed.
 */
async function submit(
  provider: ImapProviderConfig,
  account: SessionAccount,
  recipient: string,
  message: OutboundMessage,
  signal: AbortSignal,
): Promise<MailActionFailure | null> {
  let session: SmtpSession;
  try {
    session = await openSmtpSession(provider, { email: account.email, password: account.password });
  } catch (err) {
    noteSideFailure(err, provider, account);
    return sendingUnavailableFailure(provider);
  }
  const abort = () => session.abort();
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) return unconfirmedFailure(provider);
    await session.send({ from: account.email, to: recipient, raw: message.raw });
    return null;
  } catch (err) {
    return answerForSendFailure(err, session.connected, provider, account);
  } finally {
    signal.removeEventListener("abort", abort);
    session.abort();
  }
}

// --- folders ---------------------------------------------------------------

type FolderRole = "\\Sent" | "\\Drafts";

const UNSELECTABLE_FLAGS = ["\\Noselect", "\\NonExistent"] as const;

/**
 * Leaf names a NAME-sourced role may have. imapflow 1.7.0 reports its looser
 * "name-guess" tier (a known name wrapped in generic words, such as "Sent Mail")
 * as `specialUseSource: "name"` too (lib/commands/list.js, PUBLIC_SOURCE), so the
 * source alone does not say the match was exact. A folder whose role came from a
 * server SPECIAL-USE flag ("extension") is trusted whatever it is called; one
 * from its name only when the leaf is exactly one of these. Korean names are not
 * here: Naver's help documents its web folders ("임시보관함",
 * https://help.naver.com/service/30029/contents/21155) but not what IMAP LIST
 * reports. Anything else is not written to: mail in the wrong folder is worse than
 * no copy.
 */
const TRUSTED_NAME_LEAVES: Readonly<Record<FolderRole, readonly string[]>> = {
  "\\Sent": ["sent", "sent messages"],
  "\\Drafts": ["drafts"],
};

function leafName(folder: ListResponse): string {
  return folder.name || folder.path.split(folder.delimiter || "/").pop() || folder.path;
}

function isTrustedFolder(folder: ListResponse, role: FolderRole): boolean {
  if (folder.specialUse !== role) return false;
  if (UNSELECTABLE_FLAGS.some((flag) => folder.flags?.has(flag))) return false;
  switch (folder.specialUseSource) {
    case "extension":
    case "user":
      return true;
    case "name":
      return TRUSTED_NAME_LEAVES[role].includes(leafName(folder).toLowerCase());
    default:
      return false;
  }
}

/** The path of the trusted folder with this role, or null when the mailbox has none. */
async function findFolder(client: ImapFlow, role: FolderRole): Promise<string | null> {
  const folders = await client.list();
  return folders.find((folder) => isTrustedFolder(folder, role))?.path ?? null;
}

/** Is a message with this Message-ID already in the folder? The lock is always released. */
async function messageAlreadyStored(
  client: ImapFlow,
  path: string,
  messageId: string,
): Promise<boolean> {
  const lock = await client.getMailboxLock(path);
  try {
    const hits = await client.search({ header: { "message-id": messageId } }, { uid: true });
    return Array.isArray(hits) && hits.length > 0;
  } finally {
    lock.release();
  }
}

/** APPEND `mime` to the folder. False when the server did not confirm storing it. */
async function appendMessage(
  client: ImapFlow,
  path: string,
  message: OutboundMessage,
  flags: readonly string[],
): Promise<boolean> {
  const stored = await client.append(path, message.raw, [...flags], message.date);
  return stored !== false && stored !== undefined;
}

/** Store the Sent copy unless the server already did. */
async function storeSentCopy(
  client: ImapFlow,
  provider: ImapProviderConfig,
  account: SessionAccount,
  message: OutboundMessage,
): Promise<void> {
  const sent = await findFolder(client, "\\Sent");
  if (sent === null) {
    console.warn(
      `[${provider.logScope}] sent copy skipped — no Sent folder for row ${account.rowId}`,
    );
    return;
  }
  if (await messageAlreadyStored(client, sent, message.messageId)) return;
  if (!(await appendMessage(client, sent, message, SENT_COPY_FLAGS))) {
    console.warn(`[${provider.logScope}] sent copy not confirmed for row ${account.rowId}`);
  }
}

/**
 * Run `work` with a hard deadline. At the deadline its signal is aborted (it
 * closes its connection) and the caller moves on; `work`'s late outcome is ignored.
 */
async function withDeadline(
  ms: number,
  work: (signal: AbortSignal) => Promise<void>,
): Promise<"done" | "timed-out"> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timed-out");
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal).then(() => "done" as const), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * File a copy of the sent message in the Sent folder unless the server already
 * did (see the header note). The message has gone out, so nothing here may change
 * the send's result or hold it past SENT_COPY_DEADLINE_MS: a failure is noted and
 * swallowed, a missed deadline is logged.
 */
async function saveSentCopy(
  provider: ImapProviderConfig,
  account: SessionAccount,
  message: OutboundMessage,
): Promise<void> {
  try {
    const outcome = await withDeadline(SENT_COPY_DEADLINE_MS, (signal) =>
      withImapClient(
        provider,
        account,
        (client) => storeSentCopy(client, provider, account, message),
        signal,
      ),
    );
    if (outcome === "timed-out") {
      console.warn(
        `[${provider.logScope}] sent copy skipped — deadline of ${SENT_COPY_DEADLINE_MS} ms passed for row ${account.rowId}`,
      );
    }
  } catch (err) {
    noteSideFailure(err, provider, account);
  }
}

async function sendMessage(
  provider: ImapProviderConfig,
  userId: string,
  to: string,
  subject: string,
  body: string,
  attachments: readonly MailAttachment[],
  options: SendMailOptions | undefined,
): Promise<SendMailResult> {
  const recipientError = checkSendRecipient(to);
  if (recipientError) return fail(recipientError);
  const recipient = toSmtpAddress(to);
  if (recipient === null) return fail(PLAIN_ADDRESS_ONLY_MESSAGE);
  const account = await prepareAccount(provider, userId, options?.linkedInboxAccountId);
  if ("error" in account) return account;

  const message = compose(account.email, recipient, subject, body, attachments, {
    inReplyTo: options?.inReplyTo,
    references: options?.references,
  });
  return runAccountTask<SendMailResult>(
    provider,
    account,
    async ({ signal, afterResult }) => {
      const failure = await submit(provider, account, recipient, message, signal);
      if (failure) return failure;
      // Acknowledged. A send that has been aborted since must not act further.
      if (signal.aborted) return unconfirmedFailure(provider);
      // The caller gets its success now; the copy follows within its own deadline.
      afterResult(() => saveSentCopy(provider, account, message));
      return { success: true, messageId: message.messageId, threadId: null };
    },
    { onTimeout: unconfirmedFailure(provider) },
  );
}

async function saveDraft(
  provider: ImapProviderConfig,
  userId: string,
  draft: CreateDraftInput,
): Promise<CreateDraftResult> {
  const { to, subject, body, attachments = [], linkedInboxAccountId, reply } = draft;
  if (!looksLikeEmailAddress(to)) return fail(invalidAddressMessage(to));
  const recipient = toSmtpAddress(to);
  if (recipient === null) return fail(PLAIN_ADDRESS_ONLY_MESSAGE);
  if (isNoReplyAddress(recipient)) {
    return fail(
      `This address (${to}) is a no-reply system sender. Klorn will not create a ${provider.label} draft.`,
    );
  }
  const account = await prepareAccount(provider, userId, linkedInboxAccountId);
  if ("error" in account) return account;

  const message = compose(account.email, recipient, subject, body, attachments, reply ?? {});
  return runAccountTask<CreateDraftResult>(provider, account, ({ signal }) =>
    withImapClient(
      provider,
      account,
      async (client): Promise<CreateDraftResult> => {
        const folder = await findFolder(client, "\\Drafts");
        if (folder === null) {
          return fail(`Could not find the Drafts folder in your ${provider.label} mailbox.`);
        }
        if (!(await appendMessage(client, folder, message, DRAFT_FLAGS))) {
          return fail(`${provider.label} did not save the draft.`);
        }
        return {
          success: true,
          draftId: message.messageId,
          messageId: message.messageId,
          url: provider.webmailUrl,
        };
      },
      signal,
    ),
  );
}

async function readReplyHeaders(
  provider: ImapProviderConfig,
  userId: string,
  messageId: string,
  linkedInboxAccountId: string | null | undefined,
): Promise<ReplyHeadersResult> {
  if (!linkedInboxAccountId) return {};
  const checked = await findCheckedAccount(provider, userId, linkedInboxAccountId);
  if ("error" in checked) return {};
  const uid = parseImapMessageId(messageId, provider.idPrefix, checked.email);
  if (uid === null) return {};
  const account = sessionAccountFor(provider, userId, checked);
  if ("error" in account) return {};

  const headers = await runAccountTask(provider, account, ({ signal }) =>
    withImapClient(provider, account, (client) => fetchReplyHeaders(client, uid), signal),
  );
  return "error" in headers ? {} : headers;
}

/**
 * The action layer must not throw: anything unforeseen (a malformed attachment,
 * a bug) becomes `{ error }`, with only the error's class and code logged.
 */
async function neverThrow<T>(
  provider: ImapProviderConfig,
  what: string,
  work: () => Promise<T | MailActionFailure>,
): Promise<T | MailActionFailure> {
  try {
    return await work();
  } catch (err) {
    console.warn(`[${provider.logScope}] ${what} failed unexpectedly (${describeFailure(err)})`);
    return fail(`Could not ${what}. Try again shortly.`);
  }
}

export function imapSendActions(providerKey: ImapProviderKey): SendSurface {
  const provider = IMAP_PROVIDERS[providerKey];
  return {
    sendEmail: (userId, to, subject, body, attachments = [], options) =>
      neverThrow(provider, "send the message", () =>
        sendMessage(provider, userId, to, subject, body, attachments, options),
      ),
    createDraft: (userId, draft) =>
      neverThrow(provider, "save the draft", () => saveDraft(provider, userId, draft)),
    getReplyHeaders: async (userId, messageId, linkedInboxAccountId) => {
      try {
        return await readReplyHeaders(provider, userId, messageId, linkedInboxAccountId);
      } catch (err) {
        console.warn(`[${provider.logScope}] reply headers failed (${describeFailure(err)})`);
        return {};
      }
    },
  };
}
