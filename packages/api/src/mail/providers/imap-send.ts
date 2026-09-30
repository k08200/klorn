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
 * failure, as its contract says. Concurrency, the global cap and the auth
 * cooldown are in imap-task-session.ts and shared with B1.
 *
 * Known limit: if the connection drops after the message body was sent but
 * before the server's answer, the send is reported as `{ error }` though the
 * message may have been delivered. SMTP cannot tell the two apart.
 */

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
  toSmtpAddress,
} from "../outbound-message.js";
import { createSmtpTransport } from "../smtp-transport.js";
import { fail, findCheckedAccount, sessionAccountFor } from "./imap-account.js";
import {
  appendMessage,
  DRAFT_FLAGS,
  findSpecialUseFolder,
  messageAlreadyStored,
  SENT_COPY_FLAGS,
} from "./imap-mailbox-copy.js";
import { fetchReplyHeaders } from "./imap-reply-headers.js";
import type { SessionAccount } from "./imap-session.js";
import {
  describeFailure,
  noteSideFailure,
  runAccountTask,
  withImapClient,
} from "./imap-task-session.js";
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

/** The server's answer to a message it refused, or null when the failure is not a refusal. */
function refusalFor(err: unknown, provider: ImapProviderConfig): MailActionFailure | null {
  const { code, command } = (err ?? {}) as { code?: unknown; command?: unknown };
  if (code !== "EENVELOPE" && code !== "EMESSAGE") return null;
  console.warn(`[${provider.logScope}] send refused by the server (${describeFailure(err)})`);
  if (code === "EMESSAGE") return fail(`${provider.label} refused the message.`);
  return command === "MAIL FROM"
    ? fail(`${provider.label} did not accept the sending address.`)
    : fail(`${provider.label} rejected the recipient address.`);
}

async function submit(
  provider: ImapProviderConfig,
  account: SessionAccount,
  recipient: string,
  message: OutboundMessage,
): Promise<MailActionFailure | null> {
  const transport = createSmtpTransport(provider, {
    email: account.email,
    password: account.password,
  });
  try {
    await transport.sendMail({
      envelope: { from: account.email, to: [recipient] },
      raw: message.raw,
    });
    return null;
  } catch (err) {
    const refusal = refusalFor(err, provider);
    if (refusal) return refusal;
    throw err;
  } finally {
    transport.close();
  }
}

/**
 * File a copy of the sent message in the Sent folder unless the server already
 * did (see imap-mailbox-copy.ts). The message has gone out, so nothing here may
 * change the send's result: a failure is noted and swallowed.
 */
async function saveSentCopy(
  provider: ImapProviderConfig,
  account: SessionAccount,
  message: OutboundMessage,
): Promise<void> {
  try {
    await withImapClient(provider, account, async (client) => {
      const sent = await findSpecialUseFolder(client, "\\Sent");
      if (sent === null) {
        console.warn(
          `[${provider.logScope}] sent copy skipped — no Sent folder for row ${account.rowId}`,
        );
        return;
      }
      if (await messageAlreadyStored(client, sent, message.messageId)) return;
      const stored = await appendMessage(client, sent, message.raw, SENT_COPY_FLAGS, message.date);
      if (!stored) {
        console.warn(`[${provider.logScope}] sent copy not confirmed for row ${account.rowId}`);
      }
    });
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
  if (recipient === null) {
    return fail(
      "Klorn can only send to a plain address (letters, digits and . _ + - before the @).",
    );
  }
  const account = await prepareAccount(provider, userId, options?.linkedInboxAccountId);
  if ("error" in account) return account;

  const message = compose(account.email, recipient, subject, body, attachments, {
    inReplyTo: options?.inReplyTo,
    references: options?.references,
  });
  return runAccountTask<SendMailResult>(provider, account, async () => {
    const refused = await submit(provider, account, recipient, message);
    if (refused) return refused;
    await saveSentCopy(provider, account, message);
    return { success: true, messageId: message.messageId, threadId: null };
  });
}

async function saveDraft(
  provider: ImapProviderConfig,
  userId: string,
  draft: CreateDraftInput,
): Promise<CreateDraftResult> {
  const { to, subject, body, attachments = [], linkedInboxAccountId, reply } = draft;
  const recipient = looksLikeEmailAddress(to) ? toSmtpAddress(to) : null;
  if (recipient === null) return fail(invalidAddressMessage(to));
  if (isNoReplyAddress(recipient)) {
    return fail(
      `This address (${to}) is a no-reply system sender. Klorn will not create a ${provider.label} draft.`,
    );
  }
  const account = await prepareAccount(provider, userId, linkedInboxAccountId);
  if ("error" in account) return account;

  const message = compose(account.email, recipient, subject, body, attachments, reply ?? {});
  return runAccountTask<CreateDraftResult>(provider, account, () =>
    withImapClient(provider, account, async (client): Promise<CreateDraftResult> => {
      const folder = await findSpecialUseFolder(client, "\\Drafts");
      if (folder === null) {
        return fail(`Could not find the Drafts folder in your ${provider.label} mailbox.`);
      }
      const stored = await appendMessage(client, folder, message.raw, DRAFT_FLAGS, message.date);
      if (!stored) return fail(`${provider.label} did not save the draft.`);
      return {
        success: true,
        draftId: message.messageId,
        messageId: message.messageId,
        url: provider.webmailUrl,
      };
    }),
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

  const headers = await runAccountTask(provider, account, () =>
    withImapClient(provider, account, (client) => fetchReplyHeaders(client, uid)),
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
