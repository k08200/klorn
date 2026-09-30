/**
 * The session layer under the IMAP flag actions (step B1 of
 * docs/providers/unified-platform-plan.md).
 *
 * Naver and iCloud rate-limit parallel logins from one IP (imap-scheduler.ts),
 * and a ban on our egress IP would stop polling for every user of the provider.
 * Callers burst, though: bulk read/unread runs up to 100 calls through
 * Promise.all, promo auto-read fires per new SILENT mail, an MCP batch is
 * dispatched concurrently. So a call never opens its own login:
 *
 *   1. Coalescing. Operations are queued per linked account; ONE worker opens
 *      ONE session, drains everything queued for that account (also what
 *      arrives while it is logging in or working), then logs out. Consecutive
 *      operations that want the same change become one STORE and one read-back.
 *      Order is preserved. Every caller still gets its own result. A session
 *      handles at most MAX_OPS_PER_IMAP_SESSION operations; the rest wait for
 *      the next login.
 *   2. Global cap. At most MAX_CONCURRENT_IMAP_ACTION_SESSIONS sessions run at
 *      once across all accounts. The poller is unaffected.
 *   3. Auth cooldown. After a rejected login, actions for that credential
 *      answer `{ error }` without connecting until IMAP_AUTH_COOLDOWN_MS has
 *      passed or the user reconnects (a new stored cipher is a new credential).
 *      Logged once per cooldown, not once per call.
 *   4. Reporting. Transport failures reach Sentry at most once per account per
 *      IMAP_TRANSPORT_CAPTURE_INTERVAL_MS; otherwise they are a warn log.
 *
 * State is per process (in-memory) on purpose: Render runs one instance, and a
 * second instance only doubles the caps, it does not break them.
 */

import type { ImapFlow } from "imapflow";
import { Semaphore } from "../../semaphore.js";
import { captureError } from "../../sentry.js";
import { createImapClient, endImapSession } from "../imap-connection.js";
import type { ImapProviderConfig } from "../imap-providers.js";
import { applyFlagRun, type FlagChange, type ServerOutcome, sameChange } from "./imap-flags.js";
import type { MailActionFailure } from "./types.js";

// A user is waiting on the route: fail fast rather than imapflow's defaults
// (90 s connect, 16 s greeting, 300 s socket inactivity).
export const IMAP_ACTION_CONNECT_TIMEOUT_MS = 10_000;
export const IMAP_ACTION_GREETING_TIMEOUT_MS = 10_000;
export const IMAP_ACTION_SOCKET_TIMEOUT_MS = 15_000;

export const MAX_CONCURRENT_IMAP_ACTION_SESSIONS = 3;
export const MAX_OPS_PER_IMAP_SESSION = 200;
export const IMAP_AUTH_COOLDOWN_MS = 15 * 60_000;
export const IMAP_TRANSPORT_CAPTURE_INTERVAL_MS = 10 * 60_000;

const INBOX = "INBOX";

/** Everything a session needs about one mailbox; the password is plaintext. */
export interface SessionAccount {
  userId: string;
  rowId: string;
  email: string;
  host: string;
  password: string;
  /** Identifies THIS credential: row id plus the stored cipher. */
  credentialKey: string;
}

export interface FlagOp {
  uid: number;
  change: FlagChange;
}

/** A server outcome, or the failure to hand straight back to the caller. */
export type OpResult = ServerOutcome | MailActionFailure;

interface Queued {
  op: FlagOp;
  settle: (result: OpResult) => void;
}

interface AccountQueue {
  account: SessionAccount;
  pending: readonly Queued[];
}

/** Keyed by linked account row id. An entry exists exactly while a worker runs. */
const queues = new Map<string, AccountQueue>();
/** credentialKey -> epoch ms the cooldown ends. */
const authCooldownUntil = new Map<string, number>();
/** rowId -> epoch ms of the last transport failure sent to Sentry. */
const lastTransportCapture = new Map<string, number>();
let sessionSlots = new Semaphore(MAX_CONCURRENT_IMAP_ACTION_SESSIONS);

/** Test hook: forget every queue, cooldown and throttle. */
export function resetImapSessionState(): void {
  queues.clear();
  authCooldownUntil.clear();
  lastTransportCapture.clear();
  sessionSlots = new Semaphore(MAX_CONCURRENT_IMAP_ACTION_SESSIONS);
}

const fail = (error: string): MailActionFailure => ({ error });

const authFailure = (label: string): MailActionFailure =>
  fail(`${label} rejected the saved app password. Reconnect your ${label} mailbox in Settings.`);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isAuthFailure(err: unknown): boolean {
  const e = err as { authenticationFailed?: unknown; serverResponseCode?: unknown } | null;
  return e?.authenticationFailed === true || e?.serverResponseCode === "AUTHENTICATIONFAILED";
}

/**
 * The answer for an account whose credential was rejected recently, or null.
 * Exported for step B3: sends, drafts and reply-header reads share this cooldown
 * with the flag actions, so a revoked app password stops every path at once.
 */
export function cooldownFailure(
  provider: ImapProviderConfig,
  account: SessionAccount,
): MailActionFailure | null {
  const until = authCooldownUntil.get(account.credentialKey);
  if (until === undefined) return null;
  if (Date.now() >= until) {
    authCooldownUntil.delete(account.credentialKey);
    return null;
  }
  return authFailure(provider.label);
}

function startCooldown(provider: ImapProviderConfig, account: SessionAccount): void {
  const now = Date.now();
  for (const [key, until] of authCooldownUntil) {
    if (until <= now) authCooldownUntil.delete(key);
  }
  authCooldownUntil.set(account.credentialKey, now + IMAP_AUTH_COOLDOWN_MS);
  console.warn(
    `[${provider.logScope}] action refused — login rejected for row ${account.rowId}; pausing actions for this mailbox for ${IMAP_AUTH_COOLDOWN_MS / 60_000} min`,
  );
}

function shouldCapture(rowId: string): boolean {
  const now = Date.now();
  const last = lastTransportCapture.get(rowId);
  if (last !== undefined && now - last < IMAP_TRANSPORT_CAPTURE_INTERVAL_MS) return false;
  for (const [key, at] of lastTransportCapture) {
    if (now - at >= IMAP_TRANSPORT_CAPTURE_INTERVAL_MS) lastTransportCapture.delete(key);
  }
  lastTransportCapture.set(rowId, now);
  return true;
}

/**
 * Telemetry is best-effort: a capture that throws (transport down, bad DSN)
 * must never decide whether a caller gets its result.
 */
function captureSafely(err: unknown, context: Parameters<typeof captureError>[1]): void {
  try {
    captureError(err, context);
  } catch (captureFailure) {
    console.warn(`[imap-session] error capture failed: ${errorMessage(captureFailure)}`);
  }
}

/**
 * The server rejected this credential: start the shared cooldown and answer the
 * reconnect error. Exported for step B3 (SMTP authentication uses it too).
 */
export function rejectLogin(
  provider: ImapProviderConfig,
  account: SessionAccount,
): MailActionFailure {
  startCooldown(provider, account);
  return authFailure(provider.label);
}

/**
 * A session failure that is not a rejected login: log once, report to Sentry at
 * most once per account per interval, answer the generic transport error. `err`
 * is logged and reported as given, so callers that may hold server text with an
 * address in it pass a sanitized error (step B3 does).
 */
export function softFailure(
  err: unknown,
  provider: ImapProviderConfig,
  account: SessionAccount,
): MailActionFailure {
  console.warn(
    `[${provider.logScope}] action session failed for row ${account.rowId}: ${errorMessage(err)}`,
  );
  if (shouldCapture(account.rowId)) {
    captureSafely(err, {
      tags: { scope: `${provider.logScope}.action` },
      extra: { userId: account.userId, linkedInboxAccountId: account.rowId },
    });
  }
  return fail(`Could not reach ${provider.label}. Try again shortly.`);
}

/** One failure for the whole session: log (and capture) once, not per caller. */
function sessionFailure(
  err: unknown,
  provider: ImapProviderConfig,
  account: SessionAccount,
): MailActionFailure {
  return isAuthFailure(err) ? rejectLogin(provider, account) : softFailure(err, provider, account);
}

async function withInbox<T>(
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
    const lock = await client.getMailboxLock(INBOX);
    try {
      return await run(client);
    } finally {
      lock.release();
    }
  } finally {
    await endImapSession(client);
  }
}

function takeBatch(rowId: string, max: number): readonly Queued[] {
  const queue = queues.get(rowId);
  if (!queue) return [];
  queues.set(rowId, { account: queue.account, pending: queue.pending.slice(max) });
  return queue.pending.slice(0, max);
}

/** Split into maximal consecutive runs wanting the same change (order kept). */
function splitRuns(batch: readonly Queued[]): Queued[][] {
  return batch.reduce<Queued[][]>((runs, item) => {
    const last = runs[runs.length - 1];
    if (last && sameChange(last[0].op.change, item.op.change)) {
      return [...runs.slice(0, -1), [...last, item]];
    }
    return [...runs, [item]];
  }, []);
}

async function runBatch(client: ImapFlow, batch: readonly Queued[]): Promise<void> {
  for (const run of splitRuns(batch)) {
    const outcomes = await applyFlagRun(
      client,
      run.map((item) => item.op.uid),
      run[0].op.change,
    );
    for (const item of run) item.settle(outcomes.get(item.op.uid) ?? "missing");
  }
}

/** Settle the batch in flight and everything still waiting with one failure. */
function failAll(rowId: string, inFlight: readonly Queued[], failure: MailActionFailure): void {
  const queue = queues.get(rowId);
  const waiting = queue?.pending ?? [];
  if (queue) queues.set(rowId, { account: queue.account, pending: [] });
  // settle() is a promise resolver: settling an already settled caller is a no-op,
  // so results of runs that finished before the failure are kept.
  for (const item of [...inFlight, ...waiting]) item.settle(failure);
}

async function runSession(provider: ImapProviderConfig, rowId: string): Promise<void> {
  const queue = queues.get(rowId);
  if (!queue) return;
  const { account } = queue;
  const cooling = cooldownFailure(provider, account);
  if (cooling) {
    failAll(rowId, [], cooling);
    return;
  }
  let inFlight: readonly Queued[] = [];
  let handled = 0;
  try {
    await withInbox(provider, account, async (client) => {
      while (handled < MAX_OPS_PER_IMAP_SESSION) {
        // Taken AFTER the login, so everything queued while connecting joins.
        inFlight = takeBatch(rowId, MAX_OPS_PER_IMAP_SESSION - handled);
        if (inFlight.length === 0) return;
        handled += inFlight.length;
        await runBatch(client, inFlight);
      }
    });
  } catch (err) {
    // The failure is decided first, but callers are settled in a finally: if
    // building it throws (a log sink, anything), they still get an answer
    // instead of waiting forever. The throw then reaches drain()'s handler.
    let failure = fail(`Could not reach ${provider.label}. Try again shortly.`);
    try {
      failure = sessionFailure(err, provider, account);
    } finally {
      failAll(rowId, inFlight, failure);
    }
  }
}

async function drain(provider: ImapProviderConfig, rowId: string): Promise<void> {
  try {
    for (;;) {
      const queue = queues.get(rowId);
      if (!queue || queue.pending.length === 0) return;
      await sessionSlots.acquire();
      try {
        await runSession(provider, rowId);
      } finally {
        sessionSlots.release();
      }
    }
  } catch (err) {
    // Not reachable in normal operation; a caller must never be left waiting,
    // so everyone is settled BEFORE anything is reported.
    failAll(rowId, [], fail(`Could not reach ${provider.label}. Try again shortly.`));
    console.warn(
      `[${provider.logScope}] action worker crashed for row ${rowId}: ${errorMessage(err)}`,
    );
    captureSafely(err, { tags: { scope: `${provider.logScope}.action-worker` } });
  } finally {
    queues.delete(rowId);
  }
}

/**
 * Run `work` while holding one of the global action-session slots. Step B3's
 * SMTP and one-shot IMAP work counts against the same cap as the flag actions:
 * both are logins to the same providers from the same egress IP.
 */
export async function withSessionSlot<T>(work: () => Promise<T>): Promise<T> {
  const slots = sessionSlots;
  await slots.acquire();
  try {
    return await work();
  } finally {
    slots.release();
  }
}

/**
 * Queue one flag change for `account` and resolve with its own result. Never
 * rejects. Opens no connection itself: the account's worker does, once for the
 * whole burst.
 */
export function submitFlagOp(
  provider: ImapProviderConfig,
  account: SessionAccount,
  op: FlagOp,
): Promise<OpResult> {
  const cooling = cooldownFailure(provider, account);
  if (cooling) return Promise.resolve(cooling);
  return new Promise<OpResult>((settle) => {
    const existing = queues.get(account.rowId);
    // The newest snapshot wins: a password rotated while ops were queued is
    // used by the next session.
    queues.set(account.rowId, {
      account,
      pending: [...(existing?.pending ?? []), { op, settle }],
    });
    if (!existing) {
      // drain() handles its own failures; this is the last net, so a detached
      // worker can never become an unhandled rejection.
      drain(provider, account.rowId).catch((err) => {
        console.warn(`[${provider.logScope}] action worker failed: ${errorMessage(err)}`);
      });
    }
  });
}
