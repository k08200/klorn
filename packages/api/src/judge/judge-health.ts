/**
 * Judge health — the per-process heartbeat of the judge's classify path.
 *
 * recordJudgeSource is called once per production judgement (email-firewall.ts)
 * and feeds ONLY the liveness pulse below (#742): "has this dyno judged
 * anything recently?". It no longer keeps a fallback-rate window or raises
 * the fallback alarm — at ~3 emails/hour an in-memory window never reached a
 * useful sample, and every deploy wiped it (#1319). The fallback alarm is
 * DB-backed and lives in judge-fallback-check.ts, which reads the same source
 * from the "Judged by" fact attention-mirror stores on each AttentionItem.
 *
 * Cheap + in-process (per dyno). Observability only: it never changes a
 * classification.
 */

import { captureError } from "../sentry.js";

export type JudgeSource =
  | "pinned-rule"
  | "fast-path"
  | "sender-prior"
  | "learned-rule"
  | "llm"
  | "keyword-fallback";

// 26h default: survives one quiet Sunday without a false alarm, still catches
// a dyno that's been dead since yesterday's deploy.
function heartbeatMaxSilenceMs(): number {
  const v = Number(process.env.JUDGE_HEALTH_HEARTBEAT_MAX_SILENCE_MS);
  return Number.isFinite(v) && v > 0 ? v : 26 * 60 * 60 * 1000;
}

// Fleet-wide-per-dyno liveness pulse — see checkJudgeHeartbeat below. Seeded
// at module load (process boot), not null: the daily scheduler tick runs
// once immediately on start (automation-scheduler.ts), seconds after boot,
// long before this process could plausibly have classified an email. Without
// this seed, checkJudgeHeartbeat would read "never recorded" and
// runJudgeHeartbeatCheck would alarm on every single deploy/restart —
// exactly the false-positive-training-people-to-ignore-it failure mode
// issue #742 exists to prevent. Boot itself counts as a heartbeat.
let lastRecordedAt: number | null = Date.now();

/**
 * Record that the judge decided one email (any source). Heartbeat only. Call
 * from the PRODUCTION classify path (not the eval harness).
 */
export function recordJudgeSource(_source: JudgeSource, now: number = Date.now()): void {
  lastRecordedAt = now;
}

export interface JudgeHeartbeat {
  alive: boolean;
  lastRecordedAt: number | null;
  silentForMs: number | null;
}

/**
 * Heartbeat: the fallback check alone can't tell "no drift" apart from "the
 * tripwire itself stopped receiving data" — a dead classify pipeline and a
 * quiet one both leave the judged-by stream frozen, reading as healthy forever. This is
 * the canary of the canary: has ANYTHING been recorded recently, fleet-wide
 * (per dyno)? A reader's suggestion (GHSA discussion, #742).
 */
export function checkJudgeHeartbeat(now = Date.now()): JudgeHeartbeat {
  if (lastRecordedAt === null) {
    return { alive: false, lastRecordedAt: null, silentForMs: null };
  }
  const silentForMs = now - lastRecordedAt;
  return { alive: silentForMs <= heartbeatMaxSilenceMs(), lastRecordedAt, silentForMs };
}

/**
 * Best-effort daily check (call from automation-scheduler, once per UTC day —
 * see runDailyCalibrationSnapshots for the sibling pattern). Alarms when the
 * feed has gone dead, not merely quiet, so a broken call site upstream of
 * recordJudgeSource (e.g. email-firewall.ts stops being invoked at all) is
 * caught instead of silently reading as "0% fallback, all healthy."
 */
export function runJudgeHeartbeatCheck(now = Date.now()): void {
  const beat = checkJudgeHeartbeat(now);
  if (beat.alive) return;
  const silentDesc =
    beat.silentForMs === null
      ? "since process start"
      : `for ${(beat.silentForMs / (60 * 60 * 1000)).toFixed(1)}h`;
  console.error(
    `[JUDGE-HEALTH] Heartbeat dead: no judge decisions recorded ${silentDesc}. The tripwire's feed may be dead, not the classification quiet.`,
  );
  captureError(new Error("judge health heartbeat silent — tripwire feed may be dead"), {
    tags: { scope: "judge-health-heartbeat" },
    extra: { lastRecordedAt: beat.lastRecordedAt, silentForMs: beat.silentForMs },
  });
}

/** Test-only: reset the heartbeat. */
export function __resetJudgeHealth(): void {
  lastRecordedAt = null;
}
