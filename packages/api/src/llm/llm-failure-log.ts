/**
 * Failed LLM provider calls, made visible (#1319).
 *
 * LlmUsageLog is written only after a provider call SUCCEEDS (the `call`
 * closure in openai.ts), while the cost pre-bill lands in GlobalCostLedger
 * BEFORE dispatch. During the 2026-09-05 OpenRouter credit outage every judge
 * call failed, nothing was written for the failures, and the pre-bills kept
 * the ledgers moving — the system looked alive for four weeks. This module is
 * the failure-side record:
 *   - every failed dispatch attempt → one structured, rate-limited log line
 *     (logLlmCallFailure), including hops a fallback provider then recovered;
 *   - only attempts of calls that failed OVERALL → a bounded 24 h in-memory
 *     tally per provider (tallyLlmFailure), which the judge fallback alarm
 *     reads to name the top error. A hop that a fallback recovered broke
 *     nothing, so it must not become "the" error. trackDispatchFailures ties
 *     the two together per call.
 *
 * Why NOT LlmUsageLog: it has no status/error column (recording a failure
 * there needs a schema change), and every row is read as a served call by the
 * usage and cost summaries — a failure would show up as a zero-token success.
 * A failed call is not usage.
 *
 * Content-free by construction: provider, model slug, the error's class name
 * + HTTP status (describeLlmFailure) and a coarse code. Never the provider's
 * message (it can quote the rejected key) and never the prompt.
 *
 * In-process, per dyno, best-effort. It never throws: it runs inside the
 * provider-call catch path, which must rethrow the original error unchanged.
 */

import { describeLlmFailure } from "./describe-failure.js";
import {
  isConnectionError,
  isCreditError,
  isKeyLimitError,
  isModelUnavailableError,
} from "./model-fallback.js";

export type LlmFailureCode =
  | "credits_exhausted"
  | "rate_limited"
  | "auth_rejected"
  | "model_unavailable"
  | "connection"
  | "upstream_error"
  | "bad_request"
  | "other";

const CODE_LABEL: Readonly<Record<LlmFailureCode, string>> = {
  credits_exhausted: "credits exhausted",
  rate_limited: "rate limited",
  auth_rejected: "auth rejected",
  model_unavailable: "model unavailable",
  connection: "connection error",
  upstream_error: "upstream error",
  bad_request: "bad request",
  other: "other error",
};

/** Rolling window the per-provider tally covers (the judge alarm's 24 h lookback). */
export const LLM_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Hard cap on retained failure events, whatever the outage volume. */
export const LLM_FAILURE_MAX_EVENTS = 1000;
/** At most one log line per (provider, code, status) per interval. */
export const LLM_FAILURE_LOG_INTERVAL_MS = 60 * 1000;
/** Cap on distinct rate-limit keys tracked (providers × codes is far below). */
const LOG_KEY_CAP = 64;

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_SERVER_ERROR_MIN = 500;

const LOG_PREFIX = "[LLM-FAILURE]";

export interface LlmFailureClass {
  /** Constructor/name + HTTP status, e.g. "AuthenticationError 401". */
  errorClass: string;
  status: number | null;
  code: LlmFailureCode;
  /** Human label for alarms, e.g. "402 credits exhausted". */
  label: string;
}

export interface LlmFailureContext {
  provider: string;
  model: string;
  /** A BYOK key is tallied apart from the fleet's env key. */
  ownedByUser?: boolean;
}

export interface LlmFailureTally {
  provider: string;
  total: number;
  byLabel: Record<string, number>;
}

export interface TopLlmFailure {
  provider: string;
  label: string;
  count: number;
}

interface FailureEvent {
  at: number;
  provider: string;
  label: string;
}

interface LogMark {
  at: number;
  suppressed: number;
}

let events: FailureEvent[] = [];
const logMarks = new Map<string, LogMark>();

function statusOf(err: unknown): number | null {
  if (typeof err !== "object" || err === null || !("status" in err)) return null;
  const status = (err as { status: unknown }).status;
  return typeof status === "number" ? status : null;
}

function codeOf(err: unknown, status: number | null): LlmFailureCode {
  if (isCreditError(err)) return "credits_exhausted";
  if (isKeyLimitError(err)) return "rate_limited";
  if (isModelUnavailableError(err)) return "model_unavailable";
  if (isConnectionError(err)) return "connection";
  if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) return "auth_rejected";
  if (status !== null && status >= HTTP_SERVER_ERROR_MIN) return "upstream_error";
  if (status === HTTP_BAD_REQUEST) return "bad_request";
  return "other";
}

/** Classify a provider failure without reading anything content-bearing out. */
export function classifyLlmFailure(err: unknown): LlmFailureClass {
  const status = statusOf(err);
  const code = codeOf(err, status);
  const label = status === null ? CODE_LABEL[code] : `${status} ${CODE_LABEL[code]}`;
  return { errorClass: describeLlmFailure(err), status, code, label };
}

function pruneEvents(now: number): void {
  const fresh = events.filter((e) => now - e.at < LLM_FAILURE_WINDOW_MS);
  events = fresh.length > LLM_FAILURE_MAX_EVENTS ? fresh.slice(-LLM_FAILURE_MAX_EVENTS) : fresh;
}

function logRateLimited(provider: string, model: string, cls: LlmFailureClass, now: number): void {
  const key = `${provider}|${cls.code}|${cls.status ?? "-"}`;
  const mark = logMarks.get(key);
  if (mark && now - mark.at < LLM_FAILURE_LOG_INTERVAL_MS) {
    logMarks.set(key, { at: mark.at, suppressed: mark.suppressed + 1 });
    return;
  }
  console.warn(
    `${LOG_PREFIX} ${JSON.stringify({
      provider,
      model,
      errorClass: cls.errorClass,
      status: cls.status,
      code: cls.code,
      suppressedSinceLast: mark?.suppressed ?? 0,
    })}`,
  );
  if (!mark && logMarks.size >= LOG_KEY_CAP) logMarks.clear();
  logMarks.set(key, { at: now, suppressed: 0 });
}

function providerKey(ctx: LlmFailureContext): string {
  return ctx.ownedByUser ? `${ctx.provider}:user` : ctx.provider;
}

/**
 * Log one failed provider dispatch attempt (rate-limited, content-free).
 * Never throws: it runs inside the provider-call catch path.
 */
export function logLlmCallFailure(
  ctx: LlmFailureContext,
  err: unknown,
  now: number = Date.now(),
): void {
  try {
    logRateLimited(providerKey(ctx), ctx.model, classifyLlmFailure(err), now);
  } catch (recorderErr) {
    // Observability must never break the call path it observes.
    console.warn(`${LOG_PREFIX} logger failed: ${describeLlmFailure(recorderErr)}`);
  }
}

/**
 * Count one attempt of a call that failed overall toward the top-error tally.
 * Never throws.
 */
export function tallyLlmFailure(
  ctx: LlmFailureContext,
  err: unknown,
  now: number = Date.now(),
): void {
  try {
    const { label } = classifyLlmFailure(err);
    events = [...events, { at: now, provider: providerKey(ctx), label }];
    pruneEvents(now);
  } catch (recorderErr) {
    console.warn(`${LOG_PREFIX} tally failed: ${describeLlmFailure(recorderErr)}`);
  }
}

export interface DispatchFailureTracker {
  /** A dispatch attempt failed: log it now, hold it until the call settles. */
  note(ctx: LlmFailureContext, err: unknown): void;
  /** The call failed overall: tally every held attempt (idempotent). */
  settleUnrecovered(): void;
}

/**
 * Per-call tracker. A call that later succeeds on a fallback provider is simply
 * never settled, so its failed hops are logged but never tallied.
 */
export function trackDispatchFailures(): DispatchFailureTracker {
  let held: Array<{ ctx: LlmFailureContext; err: unknown }> = [];
  return {
    note(ctx, err) {
      logLlmCallFailure(ctx, err);
      held = [...held, { ctx, err }];
    },
    settleUnrecovered() {
      for (const { ctx, err } of held) tallyLlmFailure(ctx, err);
      held = [];
    },
  };
}

/** Failures per provider inside the rolling window. */
export function getLlmFailureCounts(now: number = Date.now()): LlmFailureTally[] {
  const byProvider = new Map<string, Record<string, number>>();
  for (const e of events) {
    if (now - e.at >= LLM_FAILURE_WINDOW_MS) continue;
    const labels = byProvider.get(e.provider) ?? {};
    byProvider.set(e.provider, { ...labels, [e.label]: (labels[e.label] ?? 0) + 1 });
  }
  return [...byProvider.entries()].map(([provider, byLabel]) => ({
    provider,
    total: Object.values(byLabel).reduce((n, c) => n + c, 0),
    byLabel,
  }));
}

/** The most frequent (provider, failure class) inside the window, or null. */
export function getTopLlmFailure(now: number = Date.now()): TopLlmFailure | null {
  let top: TopLlmFailure | null = null;
  for (const tally of getLlmFailureCounts(now)) {
    for (const [label, count] of Object.entries(tally.byLabel)) {
      if (!top || count > top.count) top = { provider: tally.provider, label, count };
    }
  }
  return top;
}

/** Test-only: forget all failures and rate-limit marks. */
export function __resetLlmFailureLog(): void {
  events = [];
  logMarks.clear();
}
