/**
 * Judge health — a fleet-wide tripwire for silent accuracy degradation.
 *
 * When the LLM scorer is unavailable (provider outage, quota exhaustion, 402s),
 * the judge falls through to the keyword pipeline, which structurally caps PUSH
 * recall at ~46% and AUTO recall at 0% (it defaults ambiguous mail to QUEUE).
 * At scale that is the worst failure mode: one provider hiccup degrades EVERY
 * user's classification at once. This module keeps a bounded, time-based
 * rolling window of the judge's decision *source* and raises an alarm while the
 * keyword-fallback share of LLM-eligible judgments stays above a threshold.
 *
 * Cheap + in-process (per dyno). It is an OBSERVABILITY tripwire, not a gate: it
 * never changes a classification, only surfaces that the pipeline is degraded.
 *
 * ── Why it was rebuilt (#1319) ─────────────────────────────────────────────
 * From 2026-09-05 every judge LLM call failed (OpenRouter credits, most likely)
 * and PUSH went from ~54/month to 0 for four weeks with no alert. The previous
 * tripwire alarmed ONCE per episode, to Sentry only, and counted deterministic
 * short-circuits (fast-path, sender-prior, …) in the denominator. Now:
 *   - ratio = keyword-fallback / (llm + keyword-fallback) — only judgments that
 *     actually reached the LLM step; short-circuits never call the LLM;
 *   - a time window (last 60 min) with a minimum LLM-eligible sample;
 *   - the alarm re-fires once per interval for as long as it stays degraded,
 *     to Sentry AND as an in-app `ops` Notification to every ADMIN (the same
 *     recipient path as the cost-cap trip alert, ops/admin-ops-notification.ts);
 *   - the message names the top provider failure (llm/llm-failure-log.ts).
 *
 * ── Runbook: "LLM judge failing" alarm ─────────────────────────────────────
 * Meaning: in the last 60 min more than half of the emails that needed the LLM
 * scorer were classified by the keyword fallback instead. PUSH effectively
 * stops (the fallback's confidence is 0.55/0.70; PUSH needs urgency >= 0.7 AND
 * confidence >= 0.7, tier-policy.ts). Classification keeps running; accuracy
 * does not.
 * Check, in order:
 *   1. The alarm's "top error". `402 credits exhausted (openrouter)` → top up
 *      OpenRouter credits / raise the key's credit limit. `401 auth rejected`
 *      → the env key was revoked or rotated. `429 rate limited` → key limit.
 *   2. Render logs: `[JUDGE] LLM feature extraction attempt` (per-email judge
 *      failure with the cause chain) and `[LLM-FAILURE]` (one structured line
 *      per provider failure class per minute, with a suppressed count).
 *   3. `[cost-guard]` lines / GET /api/admin/flags `costGuard`: a tripped daily
 *      ceiling blocks the call BEFORE dispatch, so no provider error is
 *      recorded — the alarm then says "none recorded at provider dispatch".
 *   4. GET /api/admin/judge-health (admin) for the live ratio + top error;
 *      GET /api/health/schedulers (public) carries only status + ratio.
 *   5. After the fix, emails judged during the outage keep their fallback
 *      tier until re-judged: scripts/rejudge-fallback.ts (manual) or the
 *      FALLBACK_REJUDGE_SWEEP scheduler (default OFF) — judge/fallback-rejudge.ts.
 */

import { getTopLlmFailure } from "../llm/llm-failure-log.js";
import { createAdminOpsNotifications } from "../ops/admin-ops-notification.js";
import { captureError } from "../sentry.js";

export type JudgeSource =
  | "pinned-rule"
  | "fast-path"
  | "sender-prior"
  | "learned-rule"
  | "llm"
  | "keyword-fallback";

/** Rolling window the fallback ratio is computed over. */
export const JUDGE_HEALTH_WINDOW_MS = 60 * 60 * 1000;
/** Fewer LLM-eligible judgments than this in the window → too little signal. */
export const JUDGE_HEALTH_MIN_LLM_ELIGIBLE = 20;
/** Degraded when the fallback share of LLM-eligible judgments EXCEEDS this. */
export const JUDGE_HEALTH_FALLBACK_ALARM_RATIO = 0.5;
/** At most one alarm (Sentry + ops Notification) per process per interval. */
export const JUDGE_HEALTH_ALARM_INTERVAL_MS = 60 * 60 * 1000;
/** Hard cap on retained judgments, whatever the mail volume. */
export const JUDGE_HEALTH_MAX_EVENTS = 2000;

const MS_PER_MINUTE = 60 * 1000;
const PERCENT = 100;
const PUBLIC_RATIO_DECIMALS = 100;

// The one source that means "the LLM did not score this email" — the degraded path.
const FALLBACK_SOURCE: JudgeSource = "keyword-fallback";
// Sources that reached the LLM step. Pinned/fast-path/sender-prior/learned
// short-circuits never call the LLM, so they must not dilute the ratio: a
// mailbox that is mostly newsletters would otherwise read "15% fallback"
// during a total outage.
const LLM_ELIGIBLE_SOURCES: ReadonlySet<JudgeSource> = new Set<JudgeSource>([
  "llm",
  FALLBACK_SOURCE,
]);

interface EligibleOutcome {
  at: number;
  fallback: boolean;
}

let eligible: EligibleOutcome[] = [];
// When this process last raised the alarm. NOT reset on recovery, so a
// flapping ratio still alarms at most once per interval.
let lastAlarmAt: number | null = null;
// Whether the last evaluation was degraded — drives the one-line recovery log.
let wasDegraded = false;
// Fleet-wide-per-dyno liveness pulse — see checkJudgeHeartbeat below. Seeded
// at module load (process boot), not null: the daily scheduler tick runs
// once immediately on start (automation-scheduler.ts), seconds after boot,
// long before this process could plausibly have classified an email. Without
// this seed, checkJudgeHeartbeat would read "never recorded" and
// runJudgeHeartbeatCheck would alarm on every single deploy/restart —
// exactly the false-positive-training-people-to-ignore-it failure mode
// issue #742 exists to prevent. Boot itself counts as a heartbeat.
let lastRecordedAt: number | null = Date.now();

function heartbeatMaxSilenceMs(): number {
  const v = Number(process.env.JUDGE_HEALTH_HEARTBEAT_MAX_SILENCE_MS);
  // 26h default: survives one quiet Sunday without a false alarm, still
  // catches a dyno that's been dead since yesterday's deploy.
  return Number.isFinite(v) && v > 0 ? v : 26 * 60 * 60 * 1000;
}

export interface JudgeHealth {
  /** LLM-eligible judgments (llm + keyword-fallback) in the window. */
  total: number;
  fallbacks: number;
  fallbackRate: number;
  degraded: boolean;
  windowMs: number;
  /** Most frequent provider failure in the window, e.g. "402 credits exhausted (openrouter)". */
  topError: string | null;
}

/** What the PUBLIC health endpoint may carry: no error text, no volumes. */
export interface PublicJudgeHealth {
  status: "ok" | "degraded";
  fallbackRatio: number;
}

function pruneWindow(now: number): void {
  const fresh = eligible.filter((o) => now - o.at < JUDGE_HEALTH_WINDOW_MS);
  eligible = fresh.length > JUDGE_HEALTH_MAX_EVENTS ? fresh.slice(-JUDGE_HEALTH_MAX_EVENTS) : fresh;
}

function topErrorLabel(now: number): string | null {
  const top = getTopLlmFailure(now);
  return top ? `${top.label} (${top.provider})` : null;
}

function computeHealth(now: number): JudgeHealth {
  pruneWindow(now);
  const total = eligible.length;
  const fallbacks = eligible.reduce((n, o) => n + (o.fallback ? 1 : 0), 0);
  const fallbackRate = total === 0 ? 0 : fallbacks / total;
  const degraded =
    total >= JUDGE_HEALTH_MIN_LLM_ELIGIBLE && fallbackRate > JUDGE_HEALTH_FALLBACK_ALARM_RATIO;
  return {
    total,
    fallbacks,
    fallbackRate,
    degraded,
    windowMs: JUDGE_HEALTH_WINDOW_MS,
    topError: topErrorLabel(now),
  };
}

function formatAlarmMessage(health: JudgeHealth): string {
  const pct = (health.fallbackRate * PERCENT).toFixed(0);
  const minutes = JUDGE_HEALTH_WINDOW_MS / MS_PER_MINUTE;
  const top = health.topError ?? "none recorded at provider dispatch";
  return `LLM judge failing: ${pct}% fallback in last ${minutes} min (${health.fallbacks}/${health.total} LLM-eligible judgments), top error: ${top}. PUSH is effectively off while this lasts.`;
}

function raiseAlarm(health: JudgeHealth, now: number): void {
  lastAlarmAt = now;
  const message = formatAlarmMessage(health);
  console.error(`[JUDGE-HEALTH] ${message}`);
  captureError(new Error("judge pipeline degraded to keyword fallback"), {
    tags: { scope: "judge-health" },
    extra: { fallbackRate: health.fallbackRate, sample: health.total, topError: health.topError },
  });
  // Interval-bucketed dedupe key: one row per admin per interval fleet-wide,
  // even when several dynos alarm in the same interval.
  const bucketStart =
    Math.floor(now / JUDGE_HEALTH_ALARM_INTERVAL_MS) * JUDGE_HEALTH_ALARM_INTERVAL_MS;
  void createAdminOpsNotifications({
    dedupeKey: `judge-fallback:${new Date(bucketStart).toISOString()}`,
    title: "LLM judge failing",
    message,
  }).catch((err: unknown) => {
    // console+Sentry already fired; alerting must never throw into the judge.
    console.warn("[JUDGE-HEALTH] ops notification failed:", err);
  });
}

/**
 * Record one judge decision's source. Call from the PRODUCTION classify path
 * only (not the eval harness, which must not pollute the window). Alarms at
 * most once per interval while degraded.
 */
export function recordJudgeSource(source: JudgeSource, now: number = Date.now()): void {
  lastRecordedAt = now;
  if (!LLM_ELIGIBLE_SOURCES.has(source)) return;
  eligible = [...eligible, { at: now, fallback: source === FALLBACK_SOURCE }];

  const health = computeHealth(now);
  if (health.degraded) {
    wasDegraded = true;
    if (lastAlarmAt === null || now - lastAlarmAt >= JUDGE_HEALTH_ALARM_INTERVAL_MS) {
      raiseAlarm(health, now);
    }
  } else if (wasDegraded) {
    wasDegraded = false;
    console.log("[JUDGE-HEALTH] Recovered: keyword-fallback share back under threshold.");
  }
}

/** Current rolling judge health (admin endpoint — authenticated). */
export function getJudgeHealth(now: number = Date.now()): JudgeHealth {
  return computeHealth(now);
}

/** Coarse judge health for the PUBLIC /api/health/schedulers endpoint. */
export function getPublicJudgeHealth(now: number = Date.now()): PublicJudgeHealth {
  const health = computeHealth(now);
  return {
    status: health.degraded ? "degraded" : "ok",
    fallbackRatio: Math.round(health.fallbackRate * PUBLIC_RATIO_DECIMALS) / PUBLIC_RATIO_DECIMALS,
  };
}

export interface JudgeHeartbeat {
  alive: boolean;
  lastRecordedAt: number | null;
  silentForMs: number | null;
}

/**
 * Heartbeat: computeHealth() alone can't tell "no drift" apart from "the
 * tripwire itself stopped receiving data" — a dead classify pipeline and a
 * quiet one both leave the window frozen, reading as healthy forever. This is
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

/** Test-only: reset the rolling window + alarm interval + heartbeat. */
export function __resetJudgeHealth(): void {
  eligible = [];
  lastAlarmAt = null;
  wasDegraded = false;
  lastRecordedAt = null;
}
