/**
 * Centralized runtime config.
 *
 * All numeric thresholds and tuning knobs scattered across the engine live
 * here. Each value reads from an env var first, then falls back to a
 * documented default. This makes it possible to:
 *   - tune the agent without a code deploy
 *   - run experiments by overriding values on a single dyno
 *   - audit "what's our current threshold for X" from one file
 *
 * Conventions:
 *   - Durations are exposed in ms (suffix _MS) for direct use.
 *   - Anything user-facing or behavior-changing must document its purpose.
 *   - Do NOT add anything secret here; secrets stay in their own modules.
 */

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function floatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ── Push notifications ────────────────────────────────────────────────
// Caps how often a single user's phone can ring across a sliding window.
// Originally tuned 2026-04-21 after the notification-flood incident.
export const PUSH_WINDOW_10MIN_MS = intEnv("PUSH_WINDOW_10MIN_MS", 10 * 60 * 1000);
export const PUSH_WINDOW_60MIN_MS = intEnv("PUSH_WINDOW_60MIN_MS", 60 * 60 * 1000);
export const PUSH_CAP_10MIN = intEnv("PUSH_CAP_10MIN", 3);
export const PUSH_CAP_60MIN = intEnv("PUSH_CAP_60MIN", 6);

// ── Proactive actions (rule-based, no LLM) ────────────────────────────
export const UNANSWERED_THRESHOLD_HOURS = intEnv("PROACTIVE_UNANSWERED_HOURS", 48);
export const MEETING_PREP_MINUTES = intEnv("PROACTIVE_MEETING_PREP_MIN", 60);
export const DEADLINE_WARNING_DAYS = intEnv("PROACTIVE_DEADLINE_WARN_DAYS", 3);
export const EOD_HOUR = intEnv("PROACTIVE_EOD_HOUR", 18);
export const WEEKLY_REVIEW_DAY = intEnv("PROACTIVE_WEEKLY_DAY", 1); // 1 = Monday

// ── Pattern learner ───────────────────────────────────────────────────
export const PATTERN_ANALYSIS_HOURS = intEnv("PATTERN_ANALYSIS_HOURS", 168);
export const PATTERN_MIN_OCCURRENCES = intEnv("PATTERN_MIN_OCCURRENCES", 3);

// ── Trust score ───────────────────────────────────────────────────────
export const TRUST_MIN_DATA_POINTS = intEnv("TRUST_MIN_DATA_POINTS", 3);
export const TRUST_RELIABLE_THRESHOLD = floatEnv("TRUST_RELIABLE_THRESHOLD", 0.8);
export const TRUST_MOSTLY_RELIABLE_THRESHOLD = floatEnv("TRUST_MOSTLY_RELIABLE_THRESHOLD", 0.5);
// Half-life in days for recency-weighted on-time rate. Older commitments
// contribute exponentially less so a stale "reliable" badge doesn't outlive
// a recent pattern of misses.
export const TRUST_HALF_LIFE_DAYS = intEnv("TRUST_HALF_LIFE_DAYS", 60);

// ── Feedback adaptor ──────────────────────────────────────────────────
export const FEEDBACK_DISMISS_THRESHOLD = intEnv("FEEDBACK_DISMISS_THRESHOLD", 4);
export const FEEDBACK_WINDOW_DAYS = intEnv("FEEDBACK_WINDOW_DAYS", 30);

// ── Autonomous agent ──────────────────────────────────────────────────
export const AGENT_CHECK_INTERVAL_MS = intEnv("AGENT_CHECK_INTERVAL_MS", 60_000);
export const AGENT_MAX_TOOLS_PER_LOOP = intEnv("AGENT_MAX_TOOLS_PER_LOOP", 10);
export const AGENT_MAX_CONTEXT_ITEMS = intEnv("AGENT_MAX_CONTEXT_ITEMS", 10);

// ── Cost / quota ──────────────────────────────────────────────────────
// Hard cap on LLM spend per user per UTC day, in cents (USD).
// 0 disables the gate. Default is 100¢ = $1.00/day per user — enough for
// briefing + classification + a few agent loops on paid models. Free models
// bypass the gate because their cost-per-token is 0.
export const DAILY_COST_CAP_CENTS = intEnv("DAILY_COST_CAP_CENTS", 100);

// ── Email classifier ──────────────────────────────────────────────────
export const EMAIL_CLASSIFY_BATCH_SIZE = intEnv("EMAIL_CLASSIFY_BATCH_SIZE", 15);

// ── Scheduler ─────────────────────────────────────────────────────────
export const SCHEDULER_CHECK_INTERVAL_MS = intEnv("SCHEDULER_CHECK_INTERVAL_MS", 60_000);
export const SCHEDULER_EMAIL_SYNC_INTERVAL_MS = intEnv(
  "SCHEDULER_EMAIL_SYNC_INTERVAL_MS",
  3 * 60 * 1000,
);
export const SCHEDULER_CALENDAR_SYNC_INTERVAL_MS = intEnv(
  "SCHEDULER_CALENDAR_SYNC_INTERVAL_MS",
  15 * 60 * 1000,
);
export const SCHEDULER_RECONCILE_INTERVAL_MS = intEnv(
  "SCHEDULER_RECONCILE_INTERVAL_MS",
  30 * 60 * 1000,
);
export const SCHEDULER_WATCH_RENEWAL_INTERVAL_MS = intEnv(
  "SCHEDULER_WATCH_RENEWAL_INTERVAL_MS",
  60 * 60 * 1000,
);
