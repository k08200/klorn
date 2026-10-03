/**
 * Judge fallback alarm — DB-backed (#1319).
 *
 * From 2026-09-05 every judge LLM call failed (OpenRouter credits, most likely)
 * and PUSH went from ~54/month to 0 for four weeks with no alert. An in-memory
 * window cannot catch that at prod volume (~3 emails/hour) and is wiped by
 * every deploy, so this check reads what the judge already persists: the
 * "Judged by" fact attention-mirror stamps into AttentionItem.evidence on every
 * email judgement, timestamped by `inputHashAt` (attention-mirror.ts,
 * emailRefreshFields). One aggregate query, counts only, over the last 24 h.
 *
 * LLM-eligible = `llm` + `keyword-fallback`: judgments that reached the LLM
 * step. Pinned / fast-path / sender-prior / learned-rule short-circuits never
 * call the LLM and must not dilute the ratio. The alarm fires when either:
 *   (ratio)  eligible >= JUDGE_FALLBACK_MIN_ELIGIBLE and the fallback share
 *            exceeds JUDGE_FALLBACK_ALARM_RATIO;
 *   (streak) the last JUDGE_FALLBACK_STREAK eligible judgments in the window
 *            all fell back — fires however low the volume.
 *
 * Delivery: one `ops` Notification per ADMIN per condition per UTC day, deduped
 * fleet-wide by its dedupeKey (the cost-cap trip alert's pattern, shared via
 * ops/admin-ops-notification.ts). console.error + Sentry fire only when this
 * call actually created a notification — or, when nobody can receive one (no
 * ADMIN, or the write failed), once per process per day per condition.
 *
 * Observability only: it never changes a classification, tier or cost.
 *
 * ── Runbook: "LLM judge failing" alarm ─────────────────────────────────────
 * Meaning: over the last 24 h most emails that needed the LLM scorer (or the
 * last 6 in a row) were classified by the keyword fallback instead. PUSH
 * effectively stops: the fallback's confidence is 0.55/0.70 and PUSH needs
 * urgency >= 0.7 AND confidence >= 0.7 (tier-policy.ts). Classification keeps
 * running; accuracy does not.
 * Check, in order:
 *   1. The alarm's "top error". `402 credits exhausted (openrouter)` → top up
 *      OpenRouter credits / raise the key's credit limit. `401 auth rejected`
 *      → the env key was revoked or rotated. `429 rate limited` → key limit.
 *      "unknown (restarted since)" → this process has not seen a failed call
 *      since boot (or a different instance served the judge); go to step 2.
 *   2. Render logs: `[JUDGE] LLM feature extraction attempt` (per-email judge
 *      failure with the cause chain) and `[LLM-FAILURE]` (one structured line
 *      per provider failure class per minute, with a suppressed count).
 *   3. `[cost-guard]` lines / GET /api/admin/flags `costGuard`: a tripped daily
 *      ceiling blocks the call BEFORE dispatch, so no provider error exists.
 *   4. GET /api/admin/judge-health (admin) for the last check + top error;
 *      GET /api/health/schedulers (public) carries only status + ratio.
 *   5. After the fix, emails judged during the outage keep their fallback
 *      tier until re-judged: scripts/rejudge-fallback.ts (manual) or the
 *      FALLBACK_REJUDGE_SWEEP scheduler (default OFF) — judge/fallback-rejudge.ts.
 */

import { Prisma } from "@prisma/client";
import { getTopLlmFailure } from "../llm/llm-failure-log.js";
import {
  type AdminOpsDelivery,
  createAdminOpsNotifications,
} from "../ops/admin-ops-notification.js";
import { captureError } from "../sentry.js";
import type { JudgeSource } from "./judge-health.js";

const HOUR_MS = 60 * 60 * 1000;

/** How far back the check reads judgments. */
export const JUDGE_FALLBACK_LOOKBACK_MS = 24 * HOUR_MS;
/** How often the automation scheduler runs the check. */
export const JUDGE_FALLBACK_CHECK_INTERVAL_MS = HOUR_MS;
/** Ratio condition needs at least this many LLM-eligible judgments. */
export const JUDGE_FALLBACK_MIN_ELIGIBLE = 5;
/** Ratio condition: degraded when the fallback share EXCEEDS this. */
export const JUDGE_FALLBACK_ALARM_RATIO = 0.5;
/** Streak condition: this many most recent eligible judgments all fell back. */
export const JUDGE_FALLBACK_STREAK = 6;

const FALLBACK_SOURCE: JudgeSource = "keyword-fallback";
/** Judgments that reached the LLM step — the only ones the ratio counts. */
export const LLM_ELIGIBLE_SOURCES: readonly JudgeSource[] = ["llm", FALLBACK_SOURCE];

const ALARM_TITLE = "LLM judge failing";
const UNKNOWN_TOP_ERROR = "unknown (restarted since)";
const PERCENT = 100;
const PUBLIC_RATIO_SCALE = 100;
const UTC_DAY_KEY_LENGTH = 10; // "YYYY-MM-DD"

export type FallbackCondition = "ratio" | "streak";

export interface JudgeFallbackThresholds {
  minEligible: number;
  ratio: number;
}

export interface JudgeFallbackStatus {
  checkedAt: number;
  eligible: number;
  fallbacks: number;
  /** null below the minimum eligible sample — too little signal for a ratio. */
  fallbackRatio: number | null;
  streakLength: number;
  streakFallbacks: number;
  conditions: FallbackCondition[];
  degraded: boolean;
}

/** PUBLIC surface: no error text, no volumes. */
export interface PublicJudgeHealth {
  status: "ok" | "degraded" | "unknown";
  fallbackRatio: number | null;
}

/** ADMIN surface (authenticated). */
export interface AdminJudgeHealth {
  lastCheck: JudgeFallbackStatus | null;
  lookbackMs: number;
  topError: string | null;
}

interface SourceCounts {
  window: Readonly<Record<string, number>>;
  streak: Readonly<Record<string, number>>;
}

interface CountRow {
  source: string | null;
  scope: string;
  count: number | bigint;
}

let lastCheck: JudgeFallbackStatus | null = null;
let refreshing: Promise<void> | null = null;
let lastRefreshAttemptAt: number | null = null;
// Dedupe keys this process already made loud without a created notification.
const loudWithoutRecipient = new Set<string>();
let warnedRetiredEnv = false;

/** Env overrides kept from the retired count-based tripwire. Invalid → default. */
export function resolveJudgeFallbackThresholds(): JudgeFallbackThresholds {
  const rate = Number(process.env.JUDGE_HEALTH_FALLBACK_RATE);
  const min = Number(process.env.JUDGE_HEALTH_MIN_SAMPLE);
  return {
    minEligible: Number.isFinite(min) && min > 0 ? Math.floor(min) : JUDGE_FALLBACK_MIN_ELIGIBLE,
    ratio: Number.isFinite(rate) && rate > 0 && rate <= 1 ? rate : JUDGE_FALLBACK_ALARM_RATIO,
  };
}

/** Boot-time, once: the count-based window knob no longer does anything. */
export function warnRetiredJudgeHealthEnv(): void {
  if (warnedRetiredEnv || !process.env.JUDGE_HEALTH_WINDOW) return;
  warnedRetiredEnv = true;
  console.warn(
    "[JUDGE-HEALTH] JUDGE_HEALTH_WINDOW is set but no longer used: the fallback alarm reads the last 24 h of judgments from the DB (#1319). Remove it; JUDGE_HEALTH_FALLBACK_RATE and JUDGE_HEALTH_MIN_SAMPLE still apply.",
  );
}

/**
 * The single aggregate statement. Bound parameters, in order: since, eligible
 * sources, streak length. Selects only the judged-by label and counts — never
 * a content column. The jsonpath label must match the fact attention-mirror
 * writes ({ label: "Judged by", value: judgement.source }).
 */
export function judgeSourceCountsStatement(args: {
  since: Date;
  eligible: readonly string[];
  streak: number;
}): Prisma.Sql {
  return Prisma.sql`
    WITH judged AS (
      SELECT "inputHashAt" AS judged_at,
             jsonb_path_query_first("evidence", '$.facts[*] ? (@.label == "Judged by").value') #>> '{}' AS judged_by
      FROM "AttentionItem"
      WHERE "source" = 'EMAIL' AND "inputHashAt" >= ${args.since}
    ),
    streak AS (
      SELECT judged_by FROM judged
      WHERE judged_by = ANY(${[...args.eligible]}::text[])
      ORDER BY judged_at DESC
      LIMIT ${args.streak}::int
    )
    SELECT judged_by AS "source", 'window' AS "scope", COUNT(*)::int AS "count"
      FROM judged GROUP BY judged_by
    UNION ALL
    SELECT judged_by AS "source", 'streak' AS "scope", COUNT(*)::int AS "count"
      FROM streak GROUP BY judged_by`;
}

async function fetchJudgeSourceCounts(now: number): Promise<SourceCounts> {
  // Lazy db import: keeps this module off the Prisma init path at import time.
  const { prisma } = await import("../db.js");
  const rows = await prisma.$queryRaw<CountRow[]>(
    judgeSourceCountsStatement({
      since: new Date(now - JUDGE_FALLBACK_LOOKBACK_MS),
      eligible: LLM_ELIGIBLE_SOURCES,
      streak: JUDGE_FALLBACK_STREAK,
    }),
  );
  const add = (acc: Readonly<Record<string, number>>, row: CountRow) => {
    const key = row.source ?? "unknown";
    return { ...acc, [key]: (acc[key] ?? 0) + Number(row.count) };
  };
  return {
    window: rows.filter((r) => r.scope === "window").reduce(add, {}),
    streak: rows.filter((r) => r.scope === "streak").reduce(add, {}),
  };
}

function sumEligible(counts: Readonly<Record<string, number>>): number {
  return LLM_ELIGIBLE_SOURCES.reduce((n, source) => n + (counts[source] ?? 0), 0);
}

export function evaluateJudgeFallback(
  counts: SourceCounts,
  thresholds: JudgeFallbackThresholds,
  checkedAt: number,
): JudgeFallbackStatus {
  const eligible = sumEligible(counts.window);
  const fallbacks = counts.window[FALLBACK_SOURCE] ?? 0;
  const fallbackRatio = eligible >= thresholds.minEligible ? fallbacks / eligible : null;
  const streakLength = sumEligible(counts.streak);
  const streakFallbacks = counts.streak[FALLBACK_SOURCE] ?? 0;
  const ratioFires = fallbackRatio !== null && fallbackRatio > thresholds.ratio;
  const streakFires = streakLength >= JUDGE_FALLBACK_STREAK && streakFallbacks === streakLength;
  const conditions: FallbackCondition[] = [
    ...(ratioFires ? (["ratio"] as const) : []),
    ...(streakFires ? (["streak"] as const) : []),
  ];
  return {
    checkedAt,
    eligible,
    fallbacks,
    fallbackRatio,
    streakLength,
    streakFallbacks,
    conditions,
    degraded: conditions.length > 0,
  };
}

async function measure(now: number): Promise<JudgeFallbackStatus> {
  const counts = await fetchJudgeSourceCounts(now);
  const status = evaluateJudgeFallback(counts, resolveJudgeFallbackThresholds(), now);
  lastCheck = status;
  return status;
}

function topErrorLabel(now: number): string | null {
  const top = getTopLlmFailure(now);
  return top ? `${top.label} (${top.provider})` : null;
}

function formatAlarmMessage(
  condition: FallbackCondition,
  status: JudgeFallbackStatus,
  topError: string | null,
): string {
  const top = topError ?? UNKNOWN_TOP_ERROR;
  if (condition === "ratio") {
    const pct = ((status.fallbackRatio ?? 0) * PERCENT).toFixed(0);
    return `LLM judge failing: ${pct}% fallback in last 24 h (${status.fallbacks}/${status.eligible} LLM-eligible judgments), top error: ${top}. PUSH is effectively off while this lasts.`;
  }
  return `LLM judge failing: the last ${status.streakLength} LLM-eligible judgments all fell back to keywords (last 24 h), top error: ${top}. PUSH is effectively off while this lasts.`;
}

function shouldBeLoud(delivery: AdminOpsDelivery | null, dedupeKey: string): boolean {
  if (delivery && delivery.created > 0) return true;
  const unreachable = delivery === null || delivery.recipients === 0;
  return unreachable && !loudWithoutRecipient.has(dedupeKey);
}

async function raiseAlarm(
  condition: FallbackCondition,
  status: JudgeFallbackStatus,
  now: number,
): Promise<void> {
  const dayKey = new Date(now).toISOString().slice(0, UTC_DAY_KEY_LENGTH);
  const dedupeKey = `judge-fallback:${condition}:${dayKey}`;
  const topError = topErrorLabel(now);
  const message = formatAlarmMessage(condition, status, topError);

  let delivery: AdminOpsDelivery | null = null;
  try {
    delivery = await createAdminOpsNotifications({ dedupeKey, title: ALARM_TITLE, message });
  } catch (err) {
    console.warn("[JUDGE-HEALTH] ops notification failed:", err);
  }
  if (!shouldBeLoud(delivery, dedupeKey)) return;

  if (!delivery || delivery.created === 0) {
    // Bounded: only today's keys are kept.
    for (const key of loudWithoutRecipient) {
      if (!key.endsWith(dayKey)) loudWithoutRecipient.delete(key);
    }
    loudWithoutRecipient.add(dedupeKey);
  }
  console.error(`[JUDGE-HEALTH] ${message}`);
  captureError(new Error("judge pipeline degraded to keyword fallback"), {
    tags: { scope: "judge-health", condition },
    extra: {
      eligible: status.eligible,
      fallbacks: status.fallbacks,
      fallbackRatio: status.fallbackRatio,
      streakLength: status.streakLength,
      topError,
    },
  });
}

/**
 * The hourly check (automation scheduler). Throws only if the DB read fails;
 * alarm delivery failures are logged, never thrown.
 */
export async function runJudgeFallbackCheck(
  now: number = Date.now(),
): Promise<JudgeFallbackStatus> {
  const status = await measure(now);
  for (const condition of status.conditions) {
    await raiseAlarm(condition, status, now);
  }
  return status;
}

/**
 * Re-measure in the background when this process's cached result is missing or
 * older than the check interval — so every instance can answer, not only the
 * one holding the scheduler lock. At most one attempt per interval per process,
 * never on the request's critical path, and it never alarms.
 */
function refreshIfStale(now: number): void {
  if (refreshing) return;
  if (lastCheck && now - lastCheck.checkedAt < JUDGE_FALLBACK_CHECK_INTERVAL_MS) return;
  if (
    lastRefreshAttemptAt !== null &&
    now - lastRefreshAttemptAt < JUDGE_FALLBACK_CHECK_INTERVAL_MS
  ) {
    return;
  }
  lastRefreshAttemptAt = now;
  refreshing = measure(now)
    .then(() => undefined)
    .catch((err: unknown) => {
      console.warn("[JUDGE-HEALTH] fallback snapshot refresh failed:", err);
    })
    .finally(() => {
      refreshing = null;
    });
}

/** For the PUBLIC /api/health/schedulers: the cached result, coarse only. */
export function getPublicJudgeHealth(now: number = Date.now()): PublicJudgeHealth {
  refreshIfStale(now);
  if (!lastCheck) return { status: "unknown", fallbackRatio: null };
  const ratio = lastCheck.fallbackRatio;
  return {
    status: lastCheck.degraded ? "degraded" : "ok",
    fallbackRatio:
      ratio === null ? null : Math.round(ratio * PUBLIC_RATIO_SCALE) / PUBLIC_RATIO_SCALE,
  };
}

/** For the ADMIN /api/admin/judge-health: the cached result + the top error. */
export function getJudgeHealth(now: number = Date.now()): AdminJudgeHealth {
  refreshIfStale(now);
  return { lastCheck, lookbackMs: JUDGE_FALLBACK_LOOKBACK_MS, topError: topErrorLabel(now) };
}

/** Test-only: forget the cached result, refresh gate and loud-key memory. */
export function __resetJudgeFallbackCheck(): void {
  lastCheck = null;
  refreshing = null;
  lastRefreshAttemptAt = null;
  loudWithoutRecipient.clear();
  warnedRetiredEnv = false;
}
