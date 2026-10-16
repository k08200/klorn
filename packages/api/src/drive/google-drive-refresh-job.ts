/**
 * The Google Drive refresh job `drive-google-refresh` (step D5d of
 * docs/providers/unified-platform-plan.md, D5 "Refresh"). Every hour it takes
 * at most GOOGLE_REFRESH_ACCOUNTS_PER_SWEEP GOOGLE accounts not refreshed for
 * GOOGLE_REFRESH_STALE_MS and not flagged for reconnect, never-refreshed first
 * and then the oldest (linked-drive-accounts.ts `dueDriveRefreshAccounts`), and
 * refreshes their picked files' metadata one account after another
 * (google-drive-refresh.ts). An account whose pass ended (a rate limit, an
 * outage) is not stamped, so the next sweep takes it again first.
 *
 * Volume: at most 20 accounts of at most a few hundred rows an hour, one
 * files.get per row, 4 in flight: far under Drive's per-project and per-user
 * limits (prior knowledge, not re-verified: 12,000 queries a minute). Metadata
 * can be up to 6 hours old. `changes.list` is deferred.
 *
 * Off (DRIVE_ENABLED or GOOGLE_DRIVE_ENABLED, read per sweep and again per
 * account): the sweep reads nothing, no query and no Google call. The
 * scheduler still registers its heartbeat and records it after each sweep, so
 * the flags can flip without a restart and /api/health/schedulers never
 * reports it missing. Like every scheduler it is not started while
 * BACKGROUND_AGENTS_DISABLED is set.
 *
 * One sweep at a time per process: a tick that finds the previous sweep running
 * does nothing, and records no heartbeat, so a sweep that hangs shows as stale.
 */

import { recordSchedulerTick, registerScheduler } from "../scheduler-heartbeat.js";
import { captureError } from "../sentry.js";
import { googleDriveRoutesEnabled } from "./drive-scope.js";
import { type AccountRefreshOutcome, refreshGoogleDriveAccount } from "./google-drive-refresh.js";
import { type DueDriveAccount, dueDriveRefreshAccounts } from "./linked-drive-accounts.js";

export const GOOGLE_DRIVE_REFRESH_INTERVAL_MS = 60 * 60_000;
/** Accounts per sweep (plan, D5 "Refresh"). */
export const GOOGLE_REFRESH_ACCOUNTS_PER_SWEEP = 20;
/** An account is due once its last refresh is this old. */
export const GOOGLE_REFRESH_STALE_MS = 6 * 60 * 60_000;
const FIRST_SWEEP_DELAY_MS = 3 * 60_000;
const SCHEDULER_NAME = "drive-google-refresh";

export interface RefreshSweepResult {
  readonly state: "off" | "busy" | "ran";
  readonly accounts: number;
  readonly refreshed: number;
  readonly stopped: number;
}

let running = false;

function emptyResult(state: RefreshSweepResult["state"]): RefreshSweepResult {
  return { state, accounts: 0, refreshed: 0, stopped: 0 };
}

/** One account's pass; a throw (the database) is reported, and the account is due again. */
async function refreshSafely(
  account: DueDriveAccount,
  now: Date,
): Promise<AccountRefreshOutcome | "failed"> {
  try {
    return await refreshGoogleDriveAccount(account.userId, account.id, now);
  } catch (err) {
    console.error(`[GOOGLE-DRIVE] refresh of drive account ${account.id} failed; due again`);
    captureError(err, {
      tags: { scope: "drive.google.refresh.account" },
      extra: { userId: account.userId, accountId: account.id },
    });
    return "failed";
  }
}

async function sweepDue(clock: () => Date): Promise<RefreshSweepResult> {
  const cutoff = new Date(clock().getTime() - GOOGLE_REFRESH_STALE_MS);
  const due = await dueDriveRefreshAccounts("GOOGLE", cutoff, GOOGLE_REFRESH_ACCOUNTS_PER_SWEEP);
  const outcomes: Array<AccountRefreshOutcome | "failed"> = [];
  for (const account of due) {
    // A flip off mid-sweep stops it at the next account.
    if (!googleDriveRoutesEnabled()) break;
    outcomes.push(await refreshSafely(account, clock()));
  }
  return {
    state: "ran",
    accounts: outcomes.length,
    refreshed: outcomes.filter((o) => o === "refreshed").length,
    stopped: outcomes.filter((o) => o !== "refreshed" && o !== "skipped").length,
  };
}

/** One sweep. `now` pins the clock (tests); the job passes nothing. */
export async function runGoogleDriveRefreshSweep(now?: Date): Promise<RefreshSweepResult> {
  if (!googleDriveRoutesEnabled()) return emptyResult("off");
  if (running) return emptyResult("busy");
  running = true;
  try {
    const result = await sweepDue(() => now ?? new Date());
    if (result.accounts > 0) {
      console.log(
        `[GOOGLE-DRIVE] refresh sweep: ${result.accounts} accounts, ${result.refreshed} refreshed, ${result.stopped} stopped`,
      );
    }
    return result;
  } finally {
    running = false;
  }
}

/** One scheduled sweep; the heartbeat is recorded when a sweep ends (not when busy). */
export async function driveGoogleRefreshTick(): Promise<void> {
  try {
    const result = await runGoogleDriveRefreshSweep();
    if (result.state !== "busy") recordSchedulerTick(SCHEDULER_NAME);
  } catch (err) {
    console.error("[GOOGLE-DRIVE] refresh sweep failed:", err);
    captureError(err, { tags: { scope: "drive.google.refresh.sweep" } });
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null;
let firstRunTimer: ReturnType<typeof setTimeout> | null = null;

function tick(): void {
  void driveGoogleRefreshTick();
}

export function startDriveGoogleRefreshScheduler(): void {
  if (intervalId || firstRunTimer) return;
  registerScheduler(SCHEDULER_NAME, GOOGLE_DRIVE_REFRESH_INTERVAL_MS);
  firstRunTimer = setTimeout(() => {
    firstRunTimer = null;
    tick();
    intervalId = setInterval(tick, GOOGLE_DRIVE_REFRESH_INTERVAL_MS);
    intervalId.unref?.();
  }, FIRST_SWEEP_DELAY_MS);
  firstRunTimer.unref?.();
}

export function stopDriveGoogleRefreshScheduler(): void {
  if (firstRunTimer) clearTimeout(firstRunTimer);
  if (intervalId) clearInterval(intervalId);
  firstRunTimer = null;
  intervalId = null;
}
