/**
 * Scheduler lease: at most one instance runs a scheduler tick at a time.
 *
 * Render's zero-downtime deploys run the old and the new instance side by side
 * for a while, and both start the same setInterval schedulers. Each tick must
 * therefore hold a lease that only one instance can hold.
 *
 * Why a row and not an advisory lock: the app reaches Postgres through a pooler
 * (Supavisor in production), so two statements from one Prisma client can run
 * on two different backends. The session advisory lock this replaces was taken
 * by one statement and released by another; when the release landed on another
 * backend it returned false and the lock stayed with an idle backend that
 * outlives the app (seen held for hours, across deploys), and every tick whose
 * acquire landed elsewhere was skipped without a word (2026-11-11). The lease
 * (scheduler-lease-store.ts) names its holder in every statement, and a holder
 * that stops renewing (killed, crashed, stalled) loses it when it expires.
 *
 * Nothing here is silent: a skipped tick is logged (rate-limited) and alerts
 * Sentry when skips persist; a takeover of an expired lease, a lease lost
 * mid-tick, renewals failing, and a tick holding the lease unusually long are
 * all reported. Every database call is time-bounded, so a hung call cannot
 * leave the caller's in-process latch set forever.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  assertLeaseTtl,
  createPrismaLeaseStore,
  type LeaseAcquireResult,
  type LeaseStore,
} from "./scheduler-lease-store.js";
import { captureError } from "./sentry.js";
import { withTimeout } from "./with-timeout.js";
import { newWork } from "./work-context.js";

/** How long a lease lasts without renewal: the most a dead holder can block a tick. */
export const SCHEDULER_LEASE_TTL_MS = 2 * 60_000;
/** Renewal cadence while a tick runs; a quarter of the TTL, so three misses still hold it. */
export const SCHEDULER_LEASE_RENEW_EVERY_MS = 30_000;
/** Bound on each acquire / renew / release call (it is abandoned, not cancelled). */
export const LEASE_CALL_TIMEOUT_MS = 15_000;
/** A run of skipped ticks is logged when it starts, then about this often. */
const BLOCKED_LOG_EVERY_MS = 10 * 60_000;
/**
 * A run of skipped ticks this long alerts Sentry, once per run. Several TTLs: a
 * dead holder expires within one, so a run this long means a live instance keeps
 * the lease or the acquire itself keeps failing.
 */
const BLOCKED_ALERT_AFTER_MS = 10 * 60_000;
/**
 * Slack on the two thresholds above, so a loop whose interval equals a
 * threshold (the 10-minute agent loop) crosses it on the tick that lands on it,
 * whatever the latency jitter, instead of one interval later.
 */
const CADENCE_SLACK_MS = 30_000;
/**
 * One tick holding the lease this long alerts Sentry, once per tick. While it
 * runs, this process skips its own ticks (the caller's in-process latch) and
 * every other instance skips theirs, so a hung tick is a stalled scheduler.
 */
const LONG_HOLD_ALERT_MS = 15 * 60_000;

/** Who holds a lease: host, pid and a random part, readable in the table. */
export const PROCESS_LEASE_HOLDER = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

export interface SchedulerLeaseOptions {
  /** The row key, e.g. "automation". */
  name: string;
  /** Log prefix of the owning scheduler, e.g. "[AUTOMATION]". */
  logPrefix: string;
  store?: LeaseStore;
  holderId?: string;
  ttlMs?: number;
  renewEveryMs?: number;
}

export interface SchedulerLease {
  /**
   * Run `work` while holding the lease, renewing it until `work` settles, then
   * release it. Returns false, without running `work`, when the lease is not
   * acquired or this lease object is already running a tick. A rejection from
   * `work` is rethrown after the release.
   */
  runExclusive(work: () => Promise<void>): Promise<boolean>;
}

/** A run of consecutive skipped ticks. Replaced, never mutated. */
interface BlockedRun {
  since: number;
  loggedAt: number;
  alerted: boolean;
}

/** The next state of a run of skipped ticks, and whether this skip is logged / alerted. */
export function nextBlockedRun(
  prev: BlockedRun | null,
  now: number,
): { run: BlockedRun; log: boolean; alert: boolean } {
  const since = prev?.since ?? now;
  const log = prev === null || now - prev.loggedAt >= BLOCKED_LOG_EVERY_MS - CADENCE_SLACK_MS;
  const alert = !prev?.alerted && now - since >= BLOCKED_ALERT_AFTER_MS - CADENCE_SLACK_MS;
  return {
    run: {
      since,
      loggedAt: log ? now : (prev?.loggedAt ?? now),
      alerted: !!prev?.alerted || alert,
    },
    log,
    alert,
  };
}

type Refusal =
  | { kind: "held"; holderId: string | null; expiresAt: Date | null }
  | { kind: "error"; error: unknown };

type AcquireOutcome =
  | Extract<LeaseAcquireResult, { acquired: true }>
  | { acquired: false; refusal: Refusal };

interface LeaseContext {
  name: string;
  logPrefix: string;
  holderId: string;
  ttlMs: number;
  renewEveryMs: number;
  store: () => LeaseStore;
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)} min`;
}

function tags(ctx: LeaseContext, extra: Record<string, string> = {}): Record<string, string> {
  return { scope: "scheduler.lease", lease: ctx.name, ...extra };
}

/** One store call, time-bounded; a synchronous throw becomes a rejection. */
function callStore<T>(
  ctx: LeaseContext,
  label: string,
  call: (store: LeaseStore) => Promise<T>,
): Promise<T> {
  const pending = Promise.resolve().then(() => call(ctx.store()));
  return withTimeout(pending, LEASE_CALL_TIMEOUT_MS, `scheduler lease "${ctx.name}" ${label}`);
}

async function acquireLease(ctx: LeaseContext): Promise<AcquireOutcome> {
  try {
    const result = await callStore(ctx, "acquire", (s) =>
      s.acquire(ctx.name, ctx.holderId, ctx.ttlMs),
    );
    if (result.acquired) return result;
    const { holderId, expiresAt } = result;
    return { acquired: false, refusal: { kind: "held", holderId, expiresAt } };
  } catch (error) {
    return { acquired: false, refusal: { kind: "error", error } };
  }
}

function reportRefusal(
  ctx: LeaseContext,
  refusal: Refusal,
  step: ReturnType<typeof nextBlockedRun>,
  now: number,
): void {
  const skippedFor = minutes(now - step.run.since);
  if (step.log) {
    const why =
      refusal.kind === "held"
        ? `held by ${refusal.holderId ?? "nobody"} until ${refusal.expiresAt?.toISOString() ?? "?"}`
        : "the acquire failed";
    const line = `${ctx.logPrefix} scheduler lease "${ctx.name}" not acquired (${why}) — skipping tick; ticks skipped for ${skippedFor}`;
    console.warn(line, ...(refusal.kind === "error" ? [refusal.error] : []));
  }
  if (step.alert) {
    const error =
      refusal.kind === "error"
        ? refusal.error
        : new Error(`scheduler lease "${ctx.name}" not acquired for ${skippedFor}`);
    captureError(error, {
      tags: tags(ctx),
      extra: refusal.kind === "held" ? { holderId: refusal.holderId } : {},
    });
  }
}

function reportAcquired(
  ctx: LeaseContext,
  result: Extract<LeaseAcquireResult, { acquired: true }>,
  recoveredFrom: BlockedRun | null,
): void {
  if (recoveredFrom) {
    console.log(
      `${ctx.logPrefix} scheduler lease "${ctx.name}" acquired after ${minutes(Date.now() - recoveredFrom.since)} of skipped ticks`,
    );
  }
  if (result.tookOverFrom) {
    console.warn(
      `${ctx.logPrefix} took over scheduler lease "${ctx.name}" from ${result.tookOverFrom.holderId} (expired ${result.tookOverFrom.expiresAt.toISOString()}): that holder stopped renewing mid-tick (killed, crashed or stalled)`,
    );
  }
}

function reportLost(ctx: LeaseContext, during: "renew" | "release"): void {
  console.error(
    `${ctx.logPrefix} scheduler lease "${ctx.name}" lost mid-tick (found at ${during}): another instance took it after it expired, so this tick may have overlapped theirs`,
  );
  captureError(new Error(`scheduler lease "${ctx.name}" lost mid-tick`), {
    tags: tags(ctx, { during }),
  });
}

/**
 * Renews the lease on a timer while a tick runs. Reports a loss once and then
 * stops trying. A renewal still in flight at stop is ignored: it may land after
 * the release and find the lease free, which is not a loss.
 */
class LeaseRenewal {
  private readonly startedAt = Date.now();
  private lastRenewedAt = this.startedAt;
  private readonly timer: ReturnType<typeof setInterval>;
  private lost = false;
  private stopped = false;
  private renewing = false;
  private longHoldReported = false;
  private failingReported = false;

  constructor(private readonly ctx: LeaseContext) {
    this.timer = setInterval(
      newWork(() => this.renewOnce()),
      ctx.renewEveryMs,
    );
    this.timer.unref?.();
  }

  get isLost(): boolean {
    return this.lost;
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
  }

  private renewOnce(): void {
    if (this.lost || this.stopped || this.renewing) return;
    this.reportLongHold();
    this.renewing = true;
    const { ctx } = this;
    callStore(ctx, "renew", (s) => s.renew(ctx.name, ctx.holderId, ctx.ttlMs))
      .then((ok) => this.onRenewed(ok))
      .catch((err) => this.onRenewFailed(err))
      .finally(() => {
        this.renewing = false;
      });
  }

  private onRenewed(ok: boolean): void {
    if (this.stopped || this.lost) return;
    if (ok) {
      this.lastRenewedAt = Date.now();
      return;
    }
    this.lost = true;
    reportLost(this.ctx, "renew");
  }

  /** A failed renewal is retried; renewals failing for half the TTL alert, once. */
  private onRenewFailed(err: unknown): void {
    if (this.stopped) return;
    const { ctx } = this;
    console.warn(`${ctx.logPrefix} scheduler lease "${ctx.name}" renewal failed, retrying:`, err);
    if (this.failingReported || Date.now() - this.lastRenewedAt < ctx.ttlMs / 2) return;
    this.failingReported = true;
    console.error(
      `${ctx.logPrefix} scheduler lease "${ctx.name}" renewals failing for ${minutes(Date.now() - this.lastRenewedAt)}: it expires mid-tick unless one succeeds`,
    );
    captureError(err, { tags: tags(ctx, { during: "renew" }) });
  }

  private reportLongHold(): void {
    const heldFor = Date.now() - this.startedAt;
    if (this.longHoldReported || heldFor < LONG_HOLD_ALERT_MS) return;
    this.longHoldReported = true;
    const { ctx } = this;
    console.error(
      `${ctx.logPrefix} scheduler lease "${ctx.name}": one tick has held it for ${minutes(heldFor)}; every later tick is skipped until it ends`,
    );
    captureError(
      new Error(`scheduler lease "${ctx.name}" held by one tick for ${minutes(heldFor)}`),
      {
        tags: tags(ctx),
      },
    );
  }
}

async function releaseLease(ctx: LeaseContext, alreadyLost: boolean): Promise<void> {
  try {
    const released = await callStore(ctx, "release", (s) => s.release(ctx.name, ctx.holderId));
    if (!released && !alreadyLost) reportLost(ctx, "release");
  } catch (err) {
    // Not a wedge: this process re-takes its own lease on its next tick, and
    // any other instance gets it once it expires.
    console.warn(
      `${ctx.logPrefix} scheduler lease "${ctx.name}" release failed; it expires within ${minutes(ctx.ttlMs)}:`,
      err,
    );
  }
}

function contextFor(options: SchedulerLeaseOptions): LeaseContext {
  const ttlMs = options.ttlMs ?? SCHEDULER_LEASE_TTL_MS;
  const renewEveryMs = options.renewEveryMs ?? SCHEDULER_LEASE_RENEW_EVERY_MS;
  assertLeaseTtl(ttlMs);
  if (!Number.isInteger(renewEveryMs) || renewEveryMs <= 0 || renewEveryMs >= ttlMs) {
    throw new RangeError(
      `scheduler lease renewal must be a positive int of ms below the TTL, got ${renewEveryMs}`,
    );
  }
  let store = options.store;
  return {
    name: options.name,
    logPrefix: options.logPrefix,
    holderId: options.holderId ?? PROCESS_LEASE_HOLDER,
    ttlMs,
    renewEveryMs,
    // Built on first use, so importing a scheduler opens no database scope.
    store: () => {
      store ??= createPrismaLeaseStore();
      return store;
    },
  };
}

export function createSchedulerLease(options: SchedulerLeaseOptions): SchedulerLease {
  const ctx = contextFor(options);
  let blocked: BlockedRun | null = null;
  let running = false;

  async function runOnce(work: () => Promise<void>): Promise<boolean> {
    const startedAt = Date.now();
    const outcome = await acquireLease(ctx);
    if (!outcome.acquired) {
      const step = nextBlockedRun(blocked, startedAt);
      reportRefusal(ctx, outcome.refusal, step, startedAt);
      blocked = step.run;
      return false;
    }
    const recoveredFrom = blocked;
    blocked = null;
    const renewal = new LeaseRenewal(ctx);
    try {
      reportAcquired(ctx, outcome, recoveredFrom);
      await work();
    } finally {
      renewal.stop();
      await releaseLease(ctx, renewal.isLost);
    }
    return true;
  }

  return {
    async runExclusive(work) {
      // The holder id is per process, so the store would let a second call in
      // this process through; the callers' own latches prevent that today.
      if (running) {
        console.warn(
          `${ctx.logPrefix} scheduler lease "${ctx.name}" is already running a tick in this process — skipping`,
        );
        return false;
      }
      running = true;
      try {
        return await runOnce(work);
      } finally {
        running = false;
      }
    },
  };
}
