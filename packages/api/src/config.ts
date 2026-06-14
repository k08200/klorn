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
// Scheduler tick. Used to be 1 min, which meant 24 dogfood users × 5–10 LLM
// calls/cycle = 7k–14k calls/hour, blowing through the free OpenRouter daily
// cap of 50 within minutes. 10 min is a 10× reduction at the scheduler level.
export const AGENT_CHECK_INTERVAL_MS = intEnv("AGENT_CHECK_INTERVAL_MS", 10 * 60_000);
// Hard cap on tool calls per cycle. Used to be 10 which let one cycle fire
// 10 follow-up completions; 3 is enough for "read inbox → classify → propose"
// without runaway fan-out.
export const AGENT_MAX_TOOLS_PER_LOOP = intEnv("AGENT_MAX_TOOLS_PER_LOOP", 3);
export const AGENT_MAX_CONTEXT_ITEMS = intEnv("AGENT_MAX_CONTEXT_ITEMS", 10);
// Skip autonomous-agent cycles for users whose last device activity is older
// than this. Catches the 24-user dogfood case where most accounts never log
// in but still trigger background LLM calls every minute. 24h is conservative
// — anyone who opened the app in the last day still gets full background.
export const AGENT_IDLE_THRESHOLD_MS = intEnv("AGENT_IDLE_THRESHOLD_MS", 24 * 60 * 60 * 1000);

// ── Cost / quota ──────────────────────────────────────────────────────
// Hard cap on LLM spend per user per UTC day, in cents (USD).
// 0 disables the gate. Default is 100¢ = $1.00/day per user — enough for
// briefing + classification + a few agent loops on paid models. Free models
// bypass the gate because their cost-per-token is 0.
export const DAILY_COST_CAP_CENTS = intEnv("DAILY_COST_CAP_CENTS", 100);

// Global hard cap across ALL users + system-initiated calls per UTC day, in
// cents (USD). The per-user gate can't see calls made without a userId
// (background reconcilers, system briefings), so a runaway system loop is
// invisible to it. This ceiling catches the aggregate. 0 disables it.
// Default 1000¢ = $10/day — generous for a small beta, fatal-bill-proof.
export const GLOBAL_DAILY_COST_CAP_CENTS = intEnv("GLOBAL_DAILY_COST_CAP_CENTS", 1000);

// ── Email classifier ──────────────────────────────────────────────────
export const EMAIL_CLASSIFY_BATCH_SIZE = intEnv("EMAIL_CLASSIFY_BATCH_SIZE", 15);

// ── Scheduler ─────────────────────────────────────────────────────────
export const SCHEDULER_CHECK_INTERVAL_MS = intEnv("SCHEDULER_CHECK_INTERVAL_MS", 60_000);
// Email sync cadence. Dropped from 3min to 1min so a fresh email is
// classified + (if PUSH-tier) notified within ~1 minute. The scheduler tick
// is 60s, so 60_000 means email sync runs on essentially every tick — the
// practical floor for the poll path. For sub-second delivery, configure Gmail
// Pub/Sub (GMAIL_PUBSUB_TOPIC); the poll is the fallback. Env-overridable for
// self-hosters who want to trade latency for Gmail API quota.
export const SCHEDULER_EMAIL_SYNC_INTERVAL_MS = intEnv(
  "SCHEDULER_EMAIL_SYNC_INTERVAL_MS",
  60 * 1000,
);
export const SCHEDULER_CALENDAR_SYNC_INTERVAL_MS = intEnv(
  "SCHEDULER_CALENDAR_SYNC_INTERVAL_MS",
  15 * 60 * 1000,
);
export const SCHEDULER_RECONCILE_INTERVAL_MS = intEnv(
  "SCHEDULER_RECONCILE_INTERVAL_MS",
  30 * 60 * 1000,
);
// LLM per-user rate limit (token bucket). Protects against runaway loops and
// avoids tripping upstream provider RPM caps. Numbers chosen for OpenRouter
// free tier (20 RPM upstream) — we cap each user well below so background
// agents can still progress under load.
export const LLM_USER_RPM = intEnv("LLM_USER_RPM", 15);

// Daily quota is split into two independent buckets so background workers
// (autonomous-agent, classifier, briefing, pattern-learner) can never starve
// foreground chat. If background exhausts its cap, chat keeps working.
//
// Defaults total 500/user/day (same as before the split); the new property is
// that foreground gets a reserved 300 even when background has burned its 200.
export const LLM_USER_FOREGROUND_DAILY_CAP = intEnv("LLM_USER_FOREGROUND_DAILY_CAP", 300);
export const LLM_USER_BACKGROUND_DAILY_CAP = intEnv("LLM_USER_BACKGROUND_DAILY_CAP", 200);
// Legacy env var, kept so existing deployments don't break — when set, it
// overrides the combined-total view used by the deprecated single-bucket API.
const legacyDailyCap = intEnv("LLM_USER_DAILY_CAP", 0);
export const LLM_USER_DAILY_CAP =
  legacyDailyCap > 0
    ? legacyDailyCap
    : LLM_USER_FOREGROUND_DAILY_CAP + LLM_USER_BACKGROUND_DAILY_CAP;

export const SCHEDULER_WATCH_RENEWAL_INTERVAL_MS = intEnv(
  "SCHEDULER_WATCH_RENEWAL_INTERVAL_MS",
  60 * 60 * 1000,
);
