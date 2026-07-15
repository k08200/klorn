/**
 * Judge health — a fleet-wide tripwire for silent accuracy degradation.
 *
 * When the LLM scorer is unavailable (provider outage, quota exhaustion, 402s),
 * the judge falls through to the keyword pipeline, which structurally caps PUSH
 * recall at ~46% and AUTO recall at 0% (it defaults ambiguous mail to QUEUE).
 * At scale that is the worst failure mode: one provider hiccup degrades EVERY
 * user's classification at once, with no signal other than per-call debug logs
 * nobody watches. This module keeps a bounded rolling window of the judge's
 * decision *source* and raises a single alarm when the keyword-fallback rate
 * crosses a threshold — so a fleet-wide collapse is caught, not discovered weeks
 * later in the numbers.
 *
 * Cheap + in-process (per dyno). It is an OBSERVABILITY tripwire, not a gate: it
 * never changes a classification, only surfaces that the pipeline is degraded.
 */

import { captureError } from "../sentry.js";

export type JudgeSource =
  | "fast-path"
  | "sender-prior"
  | "learned-rule"
  | "llm"
  | "keyword-fallback";

// The one source that means "the LLM did not score this email" — the degraded path.
const FALLBACK_SOURCE: JudgeSource = "keyword-fallback";

function windowSize(): number {
  const v = Number(process.env.JUDGE_HEALTH_WINDOW);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 200;
}
function minSample(): number {
  const v = Number(process.env.JUDGE_HEALTH_MIN_SAMPLE);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 30;
}
function fallbackAlarmRate(): number {
  const v = Number(process.env.JUDGE_HEALTH_FALLBACK_RATE);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.2;
}

// 26h default: survives one quiet Sunday without a false alarm, still catches
// a dyno that's been dead since yesterday's deploy.
function heartbeatMaxSilenceMs(): number {
  const v = Number(process.env.JUDGE_HEALTH_HEARTBEAT_MAX_SILENCE_MS);
  return Number.isFinite(v) && v > 0 ? v : 26 * 60 * 60 * 1000;
}

const recent: JudgeSource[] = [];
// Latched so the alarm fires once per degradation episode, re-arming on recovery.
let alarmed = false;
// Fleet-wide-per-dyno liveness pulse — see checkJudgeHeartbeat below. Seeded
// at module load (process boot), not null: the daily scheduler tick runs
// once immediately on start (automation-scheduler.ts), seconds after boot,
// long before this process could plausibly have classified an email. Without
// this seed, checkJudgeHeartbeat would read "never recorded" and
// runJudgeHeartbeatCheck would alarm on every single deploy/restart —
// exactly the false-positive-training-people-to-ignore-it failure mode
// issue #742 exists to prevent. Boot itself counts as a heartbeat.
let lastRecordedAt: number | null = Date.now();

export interface JudgeHealth {
  total: number;
  fallbackRate: number;
  degraded: boolean;
}

function computeHealth(): JudgeHealth {
  const total = recent.length;
  if (total === 0) return { total: 0, fallbackRate: 0, degraded: false };
  const fallbacks = recent.reduce((n, s) => n + (s === FALLBACK_SOURCE ? 1 : 0), 0);
  const fallbackRate = fallbacks / total;
  const degraded = total >= minSample() && fallbackRate > fallbackAlarmRate();
  return { total, fallbackRate, degraded };
}

/**
 * Record one judge decision's source. Call from the PRODUCTION classify path
 * only (not the eval harness, which must not pollute the window). Fires a single
 * alarm on crossing into degraded; re-arms once the window recovers.
 */
export function recordJudgeSource(source: JudgeSource): void {
  lastRecordedAt = Date.now();
  recent.push(source);
  const max = windowSize();
  if (recent.length > max) recent.splice(0, recent.length - max);

  const health = computeHealth();
  if (health.degraded && !alarmed) {
    alarmed = true;
    const pct = (health.fallbackRate * 100).toFixed(0);
    console.error(
      `[JUDGE-HEALTH] Degraded: ${pct}% of the last ${health.total} judgements fell back to the keyword pipeline (PUSH recall ~46% / AUTO 0% on that path). LLM provider likely failing.`,
    );
    captureError(new Error("judge pipeline degraded to keyword fallback"), {
      tags: { scope: "judge-health" },
      extra: { fallbackRate: health.fallbackRate, sample: health.total },
    });
  } else if (!health.degraded && alarmed) {
    // Recovered — re-arm so the next episode alarms again.
    alarmed = false;
    console.log("[JUDGE-HEALTH] Recovered: keyword-fallback rate back under threshold.");
  }
}

/** Current rolling judge health (for an admin/observability endpoint). */
export function getJudgeHealth(): JudgeHealth {
  return computeHealth();
}

export interface JudgeHeartbeat {
  alive: boolean;
  lastRecordedAt: number | null;
  silentForMs: number | null;
}

/**
 * Heartbeat: computeHealth() alone can't tell "no drift" apart from "the
 * tripwire itself stopped receiving data" — a dead classify pipeline and a
 * quiet one both leave `recent` frozen, reading as healthy forever. This is
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

/** Test-only: reset the rolling window + alarm latch + heartbeat. */
export function __resetJudgeHealth(): void {
  recent.length = 0;
  alarmed = false;
  lastRecordedAt = null;
}
