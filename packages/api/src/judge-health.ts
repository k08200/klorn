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

import { captureError } from "./sentry.js";

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

const recent: JudgeSource[] = [];
// Latched so the alarm fires once per degradation episode, re-arming on recovery.
let alarmed = false;

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

/** Test-only: reset the rolling window + alarm latch. */
export function __resetJudgeHealth(): void {
  recent.length = 0;
  alarmed = false;
}
