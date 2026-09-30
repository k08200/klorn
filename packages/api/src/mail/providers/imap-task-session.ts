/**
 * One-shot work on an IMAP account — SMTP sends, draft and Sent-copy APPENDs and
 * reply-header reads (step B3 of docs/providers/unified-platform-plan.md).
 *
 * The flag actions (imap-session.ts, step B1) coalesce bursts of STOREs into one
 * login. Send, drafts and header reads are user-paced single operations with no
 * coalescing to gain, so they get the two guarantees that matter and share B1's
 * state for the rest:
 *
 *   1. Serial per account. Two tasks for one mailbox never run at once.
 *   2. Shared global cap. Each task holds one of the same
 *      MAX_CONCURRENT_IMAP_ACTION_SESSIONS slots the flag actions use, for the
 *      whole task (an SMTP send and the IMAP connection that stores its Sent
 *      copy count as one): they are logins to the same providers from the same
 *      egress IP.
 *   3. Shared auth cooldown, keyed by row id plus the stored cipher. A rejected
 *      login here (IMAP or SMTP) starts the cooldown B1 consults, and B1's
 *      rejection stops these tasks. A revoked app password stops every path.
 *   4. Soft failures only. A task never rejects: a failure becomes `{ error }`.
 *
 * Failure text never reaches a log or Sentry. imapflow and nodemailer errors can
 * quote the server's reply, which may hold a recipient address; only the error
 * class, code, reply code and failing command do (`describeFailure`).
 *
 * State is per process, on purpose, like B1's: one Render instance.
 */

import type { ImapFlow } from "imapflow";

import { createImapClient, endImapSession } from "../imap-connection.js";
import type { ImapProviderConfig } from "../imap-providers.js";
import { isSmtpAuthRejection } from "../smtp-transport.js";
import {
  cooldownFailure,
  IMAP_ACTION_CONNECT_TIMEOUT_MS,
  IMAP_ACTION_GREETING_TIMEOUT_MS,
  IMAP_ACTION_SOCKET_TIMEOUT_MS,
  isAuthFailure,
  rejectLogin,
  type SessionAccount,
  softFailure,
  withSessionSlot,
} from "./imap-session.js";
import type { MailActionFailure } from "./types.js";

/** rowId -> the tail of that account's queue. Never rejects. An entry exists while work is queued. */
const tails = new Map<string, Promise<void>>();

function serially<T>(rowId: string, work: () => Promise<T>): Promise<T> {
  const previous = tails.get(rowId) ?? Promise.resolve();
  const run = previous.then(work);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(rowId, tail);
  tail.then(() => {
    if (tails.get(rowId) === tail) tails.delete(rowId);
  });
  return run;
}

/**
 * Class, code, reply code and failing command of an error, and nothing else:
 * never its message, which may quote the server's reply.
 */
export function describeFailure(err: unknown): string {
  if (typeof err !== "object" || err === null) return "NonError";
  const e = err as Record<string, unknown>;
  const fields: Array<[string, unknown]> = [
    ["code", e.code],
    ["reply", e.responseCode],
    ["imap", e.serverResponseCode],
    ["command", e.command],
  ];
  const known = fields
    .filter(([, value]) => typeof value === "string" || typeof value === "number")
    .map(([name, value]) => `${name}=${String(value).slice(0, 40)}`);
  const name = typeof e.name === "string" ? e.name.slice(0, 40) : "Error";
  return [name, ...known].join(" ");
}

/** A fresh error built from `describeFailure`, safe to log and to send to Sentry. */
export function sanitizedError(err: unknown): Error {
  return new Error(describeFailure(err));
}

function isLoginRejection(err: unknown): boolean {
  return isAuthFailure(err) || isSmtpAuthRejection(err);
}

/** The answer for an error a task threw: a rejected login, or a soft transport failure. */
function failureFor(
  err: unknown,
  provider: ImapProviderConfig,
  account: SessionAccount,
): MailActionFailure {
  return isLoginRejection(err)
    ? rejectLogin(provider, account)
    : softFailure(sanitizedError(err), provider, account);
}

/**
 * Record a failure that must not change the caller's result (the Sent copy of a
 * message that already went out): a rejected login still starts the shared
 * cooldown, anything else is logged and reported like any session failure.
 */
export function noteSideFailure(
  err: unknown,
  provider: ImapProviderConfig,
  account: SessionAccount,
): void {
  failureFor(err, provider, account);
}

/**
 * Run `task` as the next piece of work on `account`, holding a global session
 * slot. Resolves with the task's result, or with `{ error }` when the account is
 * cooling down after a rejected login or the task threw. Never rejects.
 */
export function runAccountTask<T>(
  provider: ImapProviderConfig,
  account: SessionAccount,
  task: () => Promise<T>,
): Promise<T | MailActionFailure> {
  const cooling = cooldownFailure(provider, account);
  if (cooling) return Promise.resolve(cooling);
  return serially(account.rowId, () => {
    // Checked again on our turn: the task ahead of us may have been rejected.
    const coolingNow = cooldownFailure(provider, account);
    if (coolingNow) return Promise.resolve<T | MailActionFailure>(coolingNow);
    return withSessionSlot<T | MailActionFailure>(async () => {
      try {
        return await task();
      } catch (err) {
        return failureFor(err, provider, account);
      }
    });
  });
}

/**
 * An authenticated IMAP session with the action timeouts, ended whatever
 * happens. No mailbox is selected: callers that need one lock it themselves.
 */
export async function withImapClient<T>(
  provider: ImapProviderConfig,
  account: SessionAccount,
  run: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = createImapClient({
    provider,
    host: account.host,
    email: account.email,
    password: account.password,
    socketTimeout: IMAP_ACTION_SOCKET_TIMEOUT_MS,
    connectionTimeout: IMAP_ACTION_CONNECT_TIMEOUT_MS,
    greetingTimeout: IMAP_ACTION_GREETING_TIMEOUT_MS,
    accountId: account.rowId,
  });
  try {
    await client.connect();
    return await run(client);
  } finally {
    await endImapSession(client);
  }
}
