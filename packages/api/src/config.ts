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

// ── Sender traits in judge (Phase 3b) ─────────────────────────────────
// Inject extracted SenderTrait facts into the judge prompt. OFF by default:
// flip only after sender-trait extraction has been measured (coverage + low
// conflict + evidence eyeball) so the classifier isn't grounded on unvalidated
// facts. The synthetic eval set has no traits, so this never affects the eval
// gate; the live guardrail is decision-metrics drift.
export const SENDER_TRAITS_IN_JUDGE = process.env.SENDER_TRAITS_IN_JUDGE === "true";

// Let APPLIED learned rules (learned-rule-store.ts) short-circuit the judge for
// emails they generalise to. OFF by default: a rule only fires once a human has
// APPLIED it, but the flag is the single kill-switch for the whole read path so
// a misbehaving rule can be cut without a deploy. The synthetic eval set has no
// APPLIED rules, so this never affects the eval gate.
export const LEARNED_RULES_IN_JUDGE = process.env.LEARNED_RULES_IN_JUDGE === "true";

// Ground the judge's senderTrust on the LEARNED contact-engagement graph — how
// much the user actually engages with this sender (outbound replies +, dismisses
// −), measured from real actions. OFF by default: it's a SOFT prompt fact for the
// LLM to weigh, never a hard tier override (buildPrior's short-circuit is
// untouched). The synthetic eval set has no engagement history, so this never
// affects the eval gate — the live guardrail is decision-metrics drift.
export const CONTACT_ENGAGEMENT_IN_JUDGE = process.env.CONTACT_ENGAGEMENT_IN_JUDGE === "true";

// ── Paywall / monetization ────────────────────────────────────────────
// Master kill-switch for the subscription paywall. OFF by default so merging
// to main (which auto-deploys to prod) changes NOTHING: FREE keeps its current
// feature set and BYOK stays open. Flip to "true" at launch — only once Stripe
// prices + the IAP products exist — to lock FREE (no free tier) and make BYOK a
// subscriber-only feature. ADMIN role bypasses regardless (see stripe.ts), and
// admins can comp any account's plan from /admin.
export const PAYWALL_ENABLED = process.env.PAYWALL_ENABLED === "true";

// Multi-account: fan the classify sync out over a user's LINKED secondary
// inboxes (Pro), not just the primary Google account. Default OFF — the linked
// sync path is built but stays dark until real-account testing flips it, so a
// bug in it can never touch the primary mail path in production.
// Lenient parse: a strict `=== "true"` silently treats "True", "TRUE", "1", or a
// value with a stray space as OFF — a classic dashboard-env footgun that makes
// the whole feature look dead despite the operator "setting it to true". Accept
// the common truthy spellings, and log BOTH the parsed boolean and the raw value
// on startup so a misconfig is visible in the deploy logs instead of a silent no-op.
export const MULTI_INBOX_SYNC_ENABLED = ["true", "1", "yes", "on"].includes(
  (process.env.MULTI_INBOX_SYNC_ENABLED ?? "").trim().toLowerCase(),
);
console.log(
  `[CONFIG] MULTI_INBOX_SYNC_ENABLED=${MULTI_INBOX_SYNC_ENABLED} (raw=${JSON.stringify(process.env.MULTI_INBOX_SYNC_ENABLED)})`,
);
// Fail-open is intentional pre-launch, but a lost/typo'd env var in production
// silently makes every paid feature free. Emit a loud startup signal so the
// operator notices a misconfigured deploy rather than discovering it via revenue.
if (process.env.NODE_ENV === "production" && !PAYWALL_ENABLED) {
  console.warn(
    "[PAYWALL] PAYWALL_ENABLED is not 'true' — all gated features are FREE. Set it at launch.",
  );
}
// Length of the card-required free trial granted by checkout (Stripe
// trial_period_days; the iOS IAP intro offer mirrors this at launch).
export const TRIAL_DAYS = intEnv("TRIAL_DAYS", 7);

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

// Free-tier daily LLM spend cap (cents), applied ONLY when PAYWALL_ENABLED and
// the user is not entitled (free plan). This is the free tier's "daily N emails"
// limit expressed as cost — ~10¢/day is roughly 50–100 gemini-flash
// classifications, enough to feel Klorn sort + auto-handle your inbox before
// the wall. Entitled users (paid/trial/admin) keep DAILY_COST_CAP_CENTS.
export const FREE_DAILY_COST_CAP_CENTS = intEnv("FREE_DAILY_COST_CAP_CENTS", 10);

// Global hard cap across ALL users + system-initiated calls per UTC day, in
// cents (USD). The per-user gate can't see calls made without a userId
// (background reconcilers, system briefings), so a runaway system loop is
// invisible to it. This ceiling catches the aggregate. 0 disables it.
// Default 1000¢ = $10/day — generous for a small beta, fatal-bill-proof.
export const GLOBAL_DAILY_COST_CAP_CENTS = intEnv("GLOBAL_DAILY_COST_CAP_CENTS", 1000);

// ── Email classifier ──────────────────────────────────────────────────
export const EMAIL_CLASSIFY_BATCH_SIZE = intEnv("EMAIL_CLASSIFY_BATCH_SIZE", 15);

// First-connect onboarding snapshot: how many most-recent inbox emails to pull
// AND classify on a user's very first sync, so the onboarding "review your
// classifications" step has a real sample to show and label. Env-overridable so
// a founder can widen the sample (e.g. 50/100) for more ground-truth labels
// without a redeploy. Default 30 keeps the prior first-sync behaviour. Each
// email is an LLM classify call, so this rides the same per-user daily cost cap.
export const INIT_SYNC_EMAIL_COUNT = intEnv("INIT_SYNC_EMAIL_COUNT", 30);

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
