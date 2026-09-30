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
 * One queue per account, for everything (step B3): the flag actions above and the
 * one-shot tasks below (SMTP sends, draft and Sent-copy APPENDs, reply-header
 * reads) for the same linked account run through the SAME per-row chain, one at a
 * time, in either order. The poller is separate and unaffected. A task also
 * takes one of the same global session slots for its whole duration, shares the
 * auth cooldown (an SMTP login rejection stops the flag actions and the reverse),
 * and is bounded in time, because a user waits on it and its effect is a mail:
 *
 *   - TASK_QUEUE_WAIT_MS: waiting for its turn. Past it the caller gets `{ error }`
 *     saying the mailbox was busy and nothing was sent or saved, and the task is
 *     never started afterwards, so a "busy" answer can never become a late send.
 *   - MAX_OUTSTANDING_TASKS_PER_USER: tasks a user may have queued or running.
 *   - TASK_TOTAL_TIMEOUT_MS: a running task's whole duration. Past it the
 *     connection is closed (the task's AbortSignal) and the caller is told the
 *     outcome is unconfirmed.
 *
 * State is per process (in-memory) on purpose: Render runs one instance, and a
 * second instance only doubles the caps, it does not break them.
 */

import type { ImapFlow } from "imapflow";
import { Semaphore } from "../../semaphore.js";
import { captureError } from "../../sentry.js";
import { createImapClient, endImapSession } from "../imap-connection.js";
import type { ImapProviderConfig } from "../imap-providers.js";
import { isSmtpAuthRejection } from "../smtp-transport.js";
import { errorMessage, fail, sanitizedError } from "./action-failure.js";
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

// One-shot tasks (step B3). Worst case for a caller: TASK_QUEUE_WAIT_MS waiting
// plus TASK_TOTAL_TIMEOUT_MS running, under a typical 100 s request limit.
export const TASK_QUEUE_WAIT_MS = 20_000;
export const TASK_TOTAL_TIMEOUT_MS = 60_000;
export const MAX_OUTSTANDING_TASKS_PER_USER = 10;

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
/** rowId -> the tail of that account's chain. Never rejects. Present while work is queued. */
const rowChains = new Map<string, Promise<void>>();
/** userId -> tasks queued or running (B3 one-shot tasks only). */
const outstandingTasks = new Map<string, number>();
let sessionSlots = new Semaphore(MAX_CONCURRENT_IMAP_ACTION_SESSIONS);

/** Test hook: forget every queue, chain, cooldown and throttle. */
export function resetImapSessionState(): void {
  queues.clear();
  rowChains.clear();
  outstandingTasks.clear();
  authCooldownUntil.clear();
  lastTransportCapture.clear();
  sessionSlots = new Semaphore(MAX_CONCURRENT_IMAP_ACTION_SESSIONS);
}

/**
 * Run `work` as the next piece of work on this account, after everything queued
 * for it before, whichever kind. One chain per linked account row.
 */
function serially<T>(rowId: string, work: () => Promise<T>): Promise<T> {
  const previous = rowChains.get(rowId) ?? Promise.resolve();
  const run = previous.then(work);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  rowChains.set(rowId, tail);
  tail.then(() => {
    if (rowChains.get(rowId) === tail) rowChains.delete(rowId);
  });
  return run;
}

const authFailure = (label: string): MailActionFailure =>
  fail(`${label} rejected the saved app password. Reconnect your ${label} mailbox in Settings.`);

function isAuthFailure(err: unknown): boolean {
  const e = err as { authenticationFailed?: unknown; serverResponseCode?: unknown } | null;
  return e?.authenticationFailed === true || e?.serverResponseCode === "AUTHENTICATIONFAILED";
}

/**
 * The answer for an account whose credential was rejected recently, or null.
 * Flag actions and B3 tasks share it, so a revoked app password stops every path.
 */
function cooldownFailure(
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

/** The server rejected this credential: start the shared cooldown, answer the reconnect error. */
function rejectLogin(provider: ImapProviderConfig, account: SessionAccount): MailActionFailure {
  startCooldown(provider, account);
  return authFailure(provider.label);
}

/**
 * A session failure that is not a rejected login: log once, report to Sentry at
 * most once per account per interval, answer the generic transport error. `err`
 * is logged and reported as given, so B3 tasks, whose errors may quote a
 * recipient, pass a sanitized one.
 */
function softFailure(
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

/**
 * An authenticated IMAP session with the action timeouts, ended whatever happens
 * (LOGOUT, then a hard close). No mailbox is selected: callers that need one lock
 * it themselves. Aborting `signal` hard-closes the connection, which makes any
 * pending command fail at once.
 */
export async function withImapClient<T>(
  provider: ImapProviderConfig,
  account: SessionAccount,
  run: (client: ImapFlow) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new Error("aborted before the session started");
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
  const abort = () => client.close();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await client.connect();
    return await run(client);
  } finally {
    signal?.removeEventListener("abort", abort);
    await endImapSession(client);
  }
}

/** A session with INBOX selected for the whole run; the flag actions' shape. */
function withInbox<T>(
  provider: ImapProviderConfig,
  account: SessionAccount,
  run: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  return withImapClient(provider, account, async (client) => {
    const lock = await client.getMailboxLock(INBOX);
    try {
      return await run(client);
    } finally {
      lock.release();
    }
  });
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

/** Run `work` while holding one of the global action-session slots. */
async function withSessionSlot<T>(work: () => Promise<T>): Promise<T> {
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
      serially(account.rowId, () => drain(provider, account.rowId)).catch((err) => {
        console.warn(`[${provider.logScope}] action worker failed: ${errorMessage(err)}`);
      });
    }
  });
}

// --- one-shot tasks (step B3) -------------------------------------------------

const busyFailure = (provider: ImapProviderConfig): MailActionFailure =>
  fail(
    `${provider.label} is busy with your other requests. Nothing was sent or saved; try again shortly.`,
  );

const timeoutFailure = (provider: ImapProviderConfig): MailActionFailure =>
  fail(
    `${provider.label} did not answer in time. The action may or may not have completed; check your mailbox before trying again.`,
  );

/** The answer for an error a task threw: a rejected login (IMAP or SMTP), or a soft failure. */
function failureFor(
  err: unknown,
  provider: ImapProviderConfig,
  account: SessionAccount,
): MailActionFailure {
  return isAuthFailure(err) || isSmtpAuthRejection(err)
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

function adjustOutstanding(userId: string, delta: number): void {
  const next = (outstandingTasks.get(userId) ?? 0) + delta;
  if (next <= 0) outstandingTasks.delete(userId);
  else outstandingTasks.set(userId, next);
}

/**
 * Run the task under TASK_TOTAL_TIMEOUT_MS. At the deadline the task's signal is
 * aborted (it closes its connection) and the caller gets the unconfirmed-outcome
 * answer; the task's own late failure is not reported again.
 */
async function runBounded<T>(
  provider: ImapProviderConfig,
  account: SessionAccount,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T | MailActionFailure> {
  const controller = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<MailActionFailure>((resolve) => {
    deadline = setTimeout(() => {
      controller.abort();
      resolve(timeoutFailure(provider));
    }, TASK_TOTAL_TIMEOUT_MS);
  });
  const finished = Promise.resolve()
    .then(() => task(controller.signal))
    .catch(
      (err: unknown): MailActionFailure =>
        controller.signal.aborted ? timeoutFailure(provider) : failureFor(err, provider, account),
    );
  try {
    return await Promise.race([finished, timedOut]);
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Run `task` as the next piece of work on `account`, through the account's one
 * queue and holding a global session slot. Resolves with the task's result, or
 * with `{ error }` when the account is cooling down, the user has too many tasks
 * outstanding, the mailbox stayed busy past TASK_QUEUE_WAIT_MS (the task is then
 * never run), the task threw, or it exceeded TASK_TOTAL_TIMEOUT_MS. Never rejects.
 */
export function runAccountTask<T>(
  provider: ImapProviderConfig,
  account: SessionAccount,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T | MailActionFailure> {
  const cooling = cooldownFailure(provider, account);
  if (cooling) return Promise.resolve(cooling);
  if ((outstandingTasks.get(account.userId) ?? 0) >= MAX_OUTSTANDING_TASKS_PER_USER) {
    return Promise.resolve(busyFailure(provider));
  }
  adjustOutstanding(account.userId, 1);

  return new Promise<T | MailActionFailure>((resolve) => {
    let turn: "queued" | "running" | "expired" = "queued";
    let finished = false;
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: T | MailActionFailure) => {
      if (finished) return;
      finished = true;
      clearTimeout(waitTimer);
      adjustOutstanding(account.userId, -1);
      resolve(result);
    };
    waitTimer = setTimeout(() => {
      if (turn !== "queued") return;
      turn = "expired";
      finish(busyFailure(provider));
    }, TASK_QUEUE_WAIT_MS);

    const takeTurn = async (): Promise<void> => {
      if (turn === "expired") return;
      // Checked again on our turn: the task ahead of us may have been rejected.
      const coolingNow = cooldownFailure(provider, account);
      if (coolingNow) {
        turn = "expired";
        finish(coolingNow);
        return;
      }
      await withSessionSlot(async () => {
        if (turn === "expired") return;
        turn = "running";
        clearTimeout(waitTimer);
        finish(await runBounded(provider, account, task));
      });
    };
    serially(account.rowId, takeTurn).catch((err: unknown) => {
      finish(softFailure(sanitizedError(err), provider, account));
    });
  });
}
