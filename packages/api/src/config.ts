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

// Self-heal provider-outage residue: re-judge recent keyword-fallback
// decisions (human-untouched, still OPEN) through the real judge once the
// provider is back — without this a degraded tier is permanent (the backfill
// sweep only judges emails with NO AttentionItem). OFF by default: flipping
// re-tiers mail the user may have already seen. Measured 2026-07-16: one RPM
// starvation window left 11.5% of the dogfood ledger (and 25 rows of a real
// user's) on keyword-fallback tiers. Manual repair: scripts/rejudge-fallback.ts.
export const FALLBACK_REJUDGE_SWEEP = process.env.FALLBACK_REJUDGE_SWEEP === "true";

// How far back the sweep looks for keyword-fallback residue, in days.
// The 14-day default was sized for the 2026-07-16 RPM starvation, which lasted
// hours. The key-cap outage that followed lasted ~19 days, so by the time it
// was diagnosed the oldest residue had already aged out — and nothing else
// re-judges a row that already carries an AttentionItem, so what falls out of
// this window stays mis-tiered forever. Tunable so an operator can widen it to
// the actual outage from the dashboard, without shell access to the database.
// Capped: a typo here would re-judge (and re-bill) the whole ledger.
// A zero or negative value would push the cutoff into the future and silently
// disable the repair while the flag still reads ON — fall back to the default
// instead of failing quiet.
export const FALLBACK_REJUDGE_LOOKBACK_MAX_DAYS = 90;
const FALLBACK_REJUDGE_LOOKBACK_DEFAULT_DAYS = 14;
const rejudgeLookbackRaw = intEnv(
  "FALLBACK_REJUDGE_LOOKBACK_DAYS",
  FALLBACK_REJUDGE_LOOKBACK_DEFAULT_DAYS,
);
export const FALLBACK_REJUDGE_LOOKBACK_DAYS =
  rejudgeLookbackRaw > 0
    ? Math.min(rejudgeLookbackRaw, FALLBACK_REJUDGE_LOOKBACK_MAX_DAYS)
    : FALLBACK_REJUDGE_LOOKBACK_DEFAULT_DAYS;

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
// Auto-reply for linked GOOGLE inboxes (Phase 1 per-account send routing).
// OFF by default (repo doctrine); only meaningful alongside
// MULTI_INBOX_SYNC_ENABLED — without that, linked rows never see new mail.
export const AUTO_REPLY_LINKED_INBOX_ENABLED = ["true", "1", "yes", "on"].includes(
  (process.env.AUTO_REPLY_LINKED_INBOX_ENABLED ?? "").trim().toLowerCase(),
);
console.log(
  `[CONFIG] AUTO_REPLY_LINKED_INBOX_ENABLED=${AUTO_REPLY_LINKED_INBOX_ENABLED} (raw=${JSON.stringify(process.env.AUTO_REPLY_LINKED_INBOX_ENABLED)})`,
);
// Inbox selector shows non-Google (IMAP) mailboxes too (Phase 1 of the
// multi-provider plan). OFF by default (repo doctrine). Read at request time
// (BETA_GATE precedent) with the same lenient truthy parse as the flags above.
export function providerInboxSelectorEnabled(): boolean {
  return ["true", "1", "yes", "on"].includes(
    (process.env.PROVIDER_INBOX_SELECTOR_ENABLED ?? "").trim().toLowerCase(),
  );
}
// iCloud Mail connect + sync (IMAP with an app-specific password) — Phase 2 of
// the multi-provider plan. OFF by default (repo doctrine) and it stays off
// until the CASA Letter of Assessment is issued: while OFF, every
// /api/icloud-imap route 404s and the IMAP poll never selects ICLOUD rows, so
// the DAST-scanned surface is unchanged. Read at request time
// (PROVIDER_INBOX_SELECTOR_ENABLED precedent) with the same lenient parse.
export function icloudInboxEnabled(): boolean {
  return ["true", "1", "yes", "on"].includes(
    (process.env.ICLOUD_INBOX_ENABLED ?? "").trim().toLowerCase(),
  );
}
// Outlook inbox linking via Microsoft Graph OAuth — Phase 3 of the
// multi-provider plan. OFF by default and dark until the CASA Letter of
// Assessment (same freeze as ICLOUD_INBOX_ENABLED): while OFF, every
// /api/auth/outlook route answers Fastify's default 404. Also requires
// MS_CLIENT_ID/MS_CLIENT_SECRET (Azure app registration — founder action);
// with the flag on but no credentials, /link-inbox answers 503.
export function outlookInboxEnabled(): boolean {
  return ["true", "1", "yes", "on"].includes(
    (process.env.OUTLOOK_INBOX_ENABLED ?? "").trim().toLowerCase(),
  );
}
// Outlook (Microsoft Graph) calendar, read-only — step C4 of
// docs/providers/unified-platform-plan.md. OFF by default (repo doctrine) and it
// ALSO needs OUTLOOK_INBOX_ENABLED, exactly as the Outlook mail path does: the
// calendar link rides the Outlook OAuth routes and app registration, so the inbox
// flag's CASA surface freeze must stay the outer gate. While either is off, every
// /api/auth/outlook/link-calendar and /linked-calendars route answers Fastify's
// default 404 and the calendar provider dispatcher answers the same unsupported
// result it did before C4 (no Graph call, no row). Syncing the linked account's
// events additionally needs LINKED_CALENDAR_SYNC_ENABLED, like Google's.
// Read at request time (PROVIDER_INBOX_SELECTOR_ENABLED precedent) with the same
// lenient truthy parse, so a flip needs no redeploy.
export function outlookCalendarEnabled(): boolean {
  return (
    outlookInboxEnabled() &&
    ["true", "1", "yes", "on"].includes(
      (process.env.OUTLOOK_CALENDAR_ENABLED ?? "").trim().toLowerCase(),
    )
  );
}
// iCloud and Naver calendars over CalDAV, read-only — step C3 of
// docs/providers/unified-platform-plan.md. OFF by default (repo doctrine). While
// off: every /api/caldav-calendar route answers Fastify's default 404
// (darkRouteGate), the calendar provider dispatcher answers ICLOUD and NAVER with
// the same unsupported result it did before C3 (no CalDAV request, no password
// decrypt, no row), every reader hides ICLOUD and NAVER rows already stored
// (CALENDAR_PROVIDER_ENABLED in pim/calendar-scope.ts), and no row is removed by
// the CalDAV window reconcile. Syncing events additionally needs
// LINKED_CALENDAR_SYNC_ENABLED and the user's entitlement, the C2 loop's own
// gates. Independent of ICLOUD_INBOX_ENABLED: the calendar routes are their own
// dark surface. Read at request time with the same lenient truthy parse, so a
// flip needs no redeploy.
export function caldavCalendarEnabled(): boolean {
  return ["true", "1", "yes", "on"].includes(
    (process.env.CALDAV_CALENDAR_ENABLED ?? "").trim().toLowerCase(),
  );
}
// Device calendars uploaded by the desktop app (EventKit), read-only — step C6 of
// docs/providers/unified-platform-plan.md. OFF by default (repo doctrine). While
// off: every /api/device-calendar route answers Fastify's default 404
// (darkRouteGate), so the Mac app hides its setting; no snapshot is stored; and
// every reader hides DEVICE rows already stored (CALENDAR_PROVIDER_ENABLED in
// pim/calendar-scope.ts). A device uploads only the calendars its user turned on
// (decision P4), so nothing reaches the server without that per-calendar opt-in.
// Independent of LINKED_CALENDAR_SYNC_ENABLED: nothing is fetched by the server.
// Read at request time with the same lenient truthy parse, so a flip needs no
// redeploy.
export function deviceCalendarEnabled(): boolean {
  return ["true", "1", "yes", "on"].includes(
    (process.env.DEVICE_CALENDAR_ENABLED ?? "").trim().toLowerCase(),
  );
}
// IMAP flag actions (read, unread, star) for Naver and iCloud — step B1 of
// docs/providers/unified-platform-plan.md. OFF by default (repo doctrine). While
// OFF, mail/providers/dispatch.ts routes NAVER and ICLOUD to the unsupported
// refusal exactly as before (501 at the routes). Generic IMAP stays unsupported
// either way. Read at request time (PROVIDER_INBOX_SELECTOR_ENABLED precedent)
// with the same lenient truthy parse, so a flip needs no redeploy.
export function imapActionsEnabled(): boolean {
  return ["true", "1", "yes", "on"].includes(
    (process.env.IMAP_ACTIONS_ENABLED ?? "").trim().toLowerCase(),
  );
}
// Send, reply and drafts for Naver and iCloud over SMTP and IMAP — step B3 of
// docs/providers/unified-platform-plan.md. OFF by default (repo doctrine) and
// independent of IMAP_ACTIONS_ENABLED. While OFF, mail/providers/dispatch.ts
// leaves NAVER and ICLOUD `sendEmail`, `createDraft` and `getReplyHeaders` as the
// unsupported stubs, exactly as before. ICLOUD additionally needs
// ICLOUD_INBOX_ENABLED (the CASA surface freeze). Generic IMAP stays unsupported
// either way. Read at request time (PROVIDER_INBOX_SELECTOR_ENABLED precedent)
// with the same lenient truthy parse, so a flip needs no redeploy.
export function imapSendEnabled(): boolean {
  return ["true", "1", "yes", "on"].includes(
    (process.env.IMAP_SEND_ENABLED ?? "").trim().toLowerCase(),
  );
}
// Generic IMAP with a user-supplied host — step B4 of
// docs/providers/unified-platform-plan.md. OFF by default (repo doctrine) and it
// stays off until the security review of its SSRF design (resolve-then-pin) signs
// off. While OFF, every /api/generic-imap route answers the cloaked 404, the poll
// never selects IMAP rows, and mail/providers/dispatch.ts leaves a generic mailbox
// on the unsupported stubs whatever IMAP_ACTIONS_ENABLED and
// IMAP_MOVE_ACTIONS_ENABLED say (those two still need to be on as well). Send never
// reaches a generic mailbox. Read at request time (PROVIDER_INBOX_SELECTOR_ENABLED
// precedent) with the same lenient truthy parse, so a flip needs no redeploy.
export function genericImapEnabled(): boolean {
  return ["true", "1", "yes", "on"].includes(
    (process.env.GENERIC_IMAP_ENABLED ?? "").trim().toLowerCase(),
  );
}
// Linked Google calendar sync — step C2 of docs/providers/unified-platform-plan.md.
// OFF by default (repo doctrine). While unset/false the scheduler's calendar step
// syncs the primary calendar exactly as before: no linked-account lookup, no
// extra Google call, no linked CalendarEvent row. When on, each linked GOOGLE
// calendar account is synced into rows too (same window and caps). Read at
// request time (PROVIDER_INBOX_SELECTOR_ENABLED precedent) with the same
// lenient truthy parse, so a flip needs no redeploy. Turning it off stops the
// syncing; rows already written stay until their account is unlinked.
export function linkedCalendarSyncEnabled(): boolean {
  return ["true", "1", "yes", "on"].includes(
    (process.env.LINKED_CALENDAR_SYNC_ENABLED ?? "").trim().toLowerCase(),
  );
}
// Removing events cancelled in Google on the next calendar sync — step C2b of
// docs/providers/unified-platform-plan.md. OFF by default (repo doctrine). While
// unset/false every calendar sync (the scheduler cycle, the login init-sync,
// POST /api/calendar/sync, linked accounts included) makes exactly the Google
// calls it always did and removes no row. When on, each sync also asks Google
// which events were cancelled (a second events.list) and deletes their rows and
// resolves their attention items. Read at sync time with the same lenient truthy
// parse, so a flip needs no redeploy. Flipping it is a founder action, after a
// check against a real Google calendar. Turning it off stops the scanning; rows
// already removed stay removed.
export function calendarCancellationSyncEnabled(): boolean {
  return ["true", "1", "yes", "on"].includes(
    (process.env.CALENDAR_CANCELLATION_SYNC_ENABLED ?? "").trim().toLowerCase(),
  );
}
// Archive, trash and their inverses for Naver and iCloud over IMAP MOVE — step B2
// of docs/providers/unified-platform-plan.md. OFF by default (repo doctrine) and
// independent of IMAP_ACTIONS_ENABLED and IMAP_SEND_ENABLED. While OFF,
// mail/providers/dispatch.ts leaves NAVER and ICLOUD `trash`, `untrash`,
// `archive` and `unarchive` as the unsupported stubs, exactly as before (501 at
// the routes). ICLOUD additionally needs ICLOUD_INBOX_ENABLED (the CASA surface
// freeze). Generic IMAP stays unsupported either way. Read at request time
// (PROVIDER_INBOX_SELECTOR_ENABLED precedent) with the same lenient truthy parse,
// so a flip needs no redeploy.
export function imapMoveActionsEnabled(): boolean {
  return ["true", "1", "yes", "on"].includes(
    (process.env.IMAP_MOVE_ACTIONS_ENABLED ?? "").trim().toLowerCase(),
  );
}
// One calendar read path — step C7 of docs/providers/unified-platform-plan.md.
// OFF by default (repo doctrine). While unset/false `list_events` calls Google
// live and `check_calendar_conflicts` asks Google free/busy only, exactly as
// before: no CalendarEvent row is read for either. When on, both read the synced
// CalendarEvent rows through pim/calendar-read.ts (the scope, the dedupe and
// provider/readOnly per event); the conflict check still asks Google free/busy
// as well. The price is freshness: rows are synced about every 15 minutes, and
// an event deleted upstream can stay in them until the sync removes it.
// REACH: the flag changes `listEvents` and `checkConflicts` for EVERY caller, not
// only the chat and the MCP tools: the autonomous agent's list_events and
// check_calendar_conflicts, create_event's enforced conflict check (a booking is
// refused on a row conflict, including a stale one), and the reading pane's
// meeting-context conflict line. Read at request time (PROVIDER_INBOX_SELECTOR_ENABLED
// precedent) with the same lenient truthy parse, so a flip needs no redeploy.
export function unifiedCalendarReadEnabled(): boolean {
  return ["true", "1", "yes", "on"].includes(
    (process.env.UNIFIED_CALENDAR_READ_ENABLED ?? "").trim().toLowerCase(),
  );
}
// MCP write tools — API key permission level and the MCP write set (steps A1
// and A2a of docs/providers/unified-platform-plan.md). OFF by default (repo
// doctrine). It gates minting a read-write API key, using one, the MCP-only
// write tools (mark_read today) and every audit write they cause: while OFF,
// POST /api/keys ignores the permission field (every new key is read), a stored
// read-write key acts as read at the MCP endpoint, no write tool is listed or
// callable, and nothing is inserted into McpWriteAudit on any path. Read at
// request time (PROVIDER_INBOX_SELECTOR_ENABLED precedent) with the same
// lenient truthy parse, so a flip needs no redeploy. The gate and the refused-
// call audit re-read it themselves (defence in depth).
export function mcpWriteToolsEnabled(): boolean {
  return ["true", "1", "yes", "on"].includes(
    (process.env.MCP_WRITE_TOOLS_ENABLED ?? "").trim().toLowerCase(),
  );
}
// Social LOGIN providers beyond Google (Sign in with Apple, Naver OAuth) —
// OFF by default (repo doctrine). While OFF, every /api/auth/apple/* and
// /api/auth/naver/* route 404s with the same cloak as the dark IMAP providers
// and GET /api/auth/providers omits them, so neither the DAST-scanned surface
// nor the login page changes until the provider apps are registered and the
// flags flip. Read at request time with the lenient truthy parse.
/// Team mode (saved teams + whole-team availability + invite-carrying
/// drafts) is a PAID team-tier capability (founder, 2026-08-20). No team
/// plan exists yet, so it ships DARK behind this flag; when team pricing
/// lands, replace call sites with a plan check (planHasFeature "team") —
/// the env flag then becomes the kill switch, not the seat gate.
export function teamModeEnabled(): boolean {
  return ["true", "1", "yes", "on"].includes(
    (process.env.TEAM_MODE_ENABLED ?? "").trim().toLowerCase(),
  );
}

export function appleLoginEnabled(): boolean {
  return ["true", "1", "yes", "on"].includes(
    (process.env.APPLE_LOGIN_ENABLED ?? "").trim().toLowerCase(),
  );
}
export function naverLoginEnabled(): boolean {
  return ["true", "1", "yes", "on"].includes(
    (process.env.NAVER_LOGIN_ENABLED ?? "").trim().toLowerCase(),
  );
}
// Attention aging sweep (hourly): auto-resolve firewall items the user
// already acted on elsewhere + age out SILENT/QUEUE email items. OFF by
// default — what leaves the board is a product decision; flipping is
// deliberate. Read at request time (same lenient parse as the flags above).
export function attentionAgingEnabled(): boolean {
  return ["true", "1", "yes", "on"].includes(
    (process.env.ATTENTION_AGING_ENABLED ?? "").trim().toLowerCase(),
  );
}
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
// Default 5000¢ = $50/day (founder decision 2026-08-10, raised from $10).
// Measured steady state at 100 users is ~$7/day (10k classifications at
// ~$0.00055 each + drafts + briefings — see docs/launch/launch-plan.md), so
// $10 left barely one heavy day of headroom and a spike stopped classifying
// FOR EVERYONE mid-day. A protective ceiling that trips in normal operation
// has stopped protecting and started breaking; $50 keeps ~7x headroom while
// staying fatal-bill-proof.
export const GLOBAL_DAILY_COST_CAP_CENTS = intEnv("GLOBAL_DAILY_COST_CAP_CENTS", 5000);

// Ground-truth usage log (LlmUsageLog, llm-usage.ts). OFF = writes happen
// (prod default). DB-less contexts (CI eval/canary jobs) set "true" so the
// fire-and-forget write doesn't warn + Sentry-capture on every LLM call.
export const LLM_USAGE_LOG_DISABLED = process.env.LLM_USAGE_LOG_DISABLED === "true";

// ── Playground key-free demo ──────────────────────────────────────────
// Server-paid, no-key demo path on POST /api/playground/classify. OFF by
// default (doctrine: new features ship dark) — while false the playground
// behaves exactly as before: bring-your-own-key or 401 key_required.
export const PLAYGROUND_NO_KEY_DEMO_ENABLED = process.env.PLAYGROUND_NO_KEY_DEMO_ENABLED === "true";

// Global daily budget for the key-free demo, in cents (USD), accumulated
// in-memory at 0.01¢ granularity. Default 50¢ = $0.50/day ≈ 260 gemini-flash
// classifications at the measured ~0.19¢ real cost — plenty of top-of-funnel
// demos, fatal-bill-proof. Exhausted ⇒ 429 demo_budget_exhausted and the
// landing falls back to the BYOK key UI.
export const DEMO_DAILY_BUDGET_CENTS = intEnv("DEMO_DAILY_BUDGET_CENTS", 50);

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

// Of the shared RPM window, this many slots are reserved for foreground chat —
// background workers (classifier, summarizer, briefing) can never consume them.
// Keeps chat responsive while a mail-sync burst drains through the queue below.
export const LLM_RPM_FOREGROUND_RESERVE = intEnv("LLM_RPM_FOREGROUND_RESERVE", 3);

// How long a BACKGROUND call may wait for a free RPM slot before giving up.
// Before this knob existed, a background call over the RPM cap failed
// instantly — a 58-email sync burst starved the judge and dropped 34 emails to
// the keyword fallback (permanently: fallback rows are never re-judged),
// measured on prod 2026-07-15. Waiting turns that burst into an ordered drain.
// 0 restores the old fail-fast behavior (kill switch).
export const LLM_BACKGROUND_RPM_MAX_WAIT_MS = intEnv("LLM_BACKGROUND_RPM_MAX_WAIT_MS", 300_000);

// Daily quota is split into two independent buckets so background workers
// (autonomous-agent, classifier, briefing, pattern-learner) can never starve
// foreground chat. If background exhausts its cap, chat keeps working.
//
// Defaults total 500/user/day (same as before the split); the new property is
// that foreground gets a reserved 300 even when background has burned its 200.
export const LLM_USER_FOREGROUND_DAILY_CAP = intEnv("LLM_USER_FOREGROUND_DAILY_CAP", 300);
export const LLM_USER_BACKGROUND_DAILY_CAP = intEnv("LLM_USER_BACKGROUND_DAILY_CAP", 200);
// Burst control for background-priority LLM calls (global, not per-user):
// bound concurrency and pace launches so background work can't slam the
// provider's own per-minute quota and cool-down-lock interactive calls too.
export const LLM_BACKGROUND_MAX_CONCURRENT = intEnv("LLM_BACKGROUND_MAX_CONCURRENT", 2);
export const LLM_BACKGROUND_MIN_INTERVAL_MS = intEnv("LLM_BACKGROUND_MIN_INTERVAL_MS", 4_000);
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
