import Stripe from "stripe";
import { PAYWALL_ENABLED } from "./config.js";

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn("STRIPE_SECRET_KEY not set — billing endpoints will fail");
}

export const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2025-08-27.basil" })
  : (null as unknown as Stripe);

export const PLANS = {
  FREE: {
    name: "Free",
    priceId: null,
    testLimit: 10,
    messageLimit: 50,
    tokenLimit: 500_000,
    deviceLimit: 1,
  },
  PRO: {
    name: "Pro",
    priceId: process.env.STRIPE_PRO_PRICE_ID || "",
    testLimit: 500,
    messageLimit: 2000,
    tokenLimit: 10_000_000,
    deviceLimit: 3,
  },
  TEAM: {
    name: "Team",
    priceId: process.env.STRIPE_TEAM_PRICE_ID || "",
    testLimit: 5000,
    messageLimit: 10000,
    tokenLimit: 50_000_000,
    deviceLimit: 25,
  },
  ENTERPRISE: {
    name: "Enterprise",
    priceId: null,
    testLimit: Infinity,
    messageLimit: Infinity,
    tokenLimit: Infinity,
    deviceLimit: Infinity,
  },
} as const;

/** Get the effective plan config for a user. ADMIN role always gets ENTERPRISE limits. */
export function getEffectivePlan(plan: string, role?: string): (typeof PLANS)[keyof typeof PLANS] {
  if (role === "ADMIN") return PLANS.ENTERPRISE;
  return PLANS[plan as keyof typeof PLANS] || PLANS.FREE;
}

/**
 * Feature gates per plan.
 *
 * Tools are grouped into categories. Each plan specifies which categories are allowed.
 * "read" variants allow viewing data; "write" variants allow modifications.
 */
export type FeatureKey =
  | "email_read"
  | "email_write"
  | "calendar_read"
  | "calendar_create"
  | "calendar_write"
  | "autonomous_agent"
  | "agent_mode_auto"
  | "daily_briefing"
  | "email_auto_classify"
  | "email_auto_reply"
  | "pattern_learning"
  | "web_search"
  | "write_document"
  | "slack"
  | "notion"
  | "meeting_tools"
  // Connect more than one mail account (e.g. a Naver inbox or a secondary
  // Google account) so the firewall runs across all of them. Free = the single
  // primary Google account only; multi-account is a paid differentiator.
  | "multi_account";

// The free tier is a real, continuously-usable product — not just a trial. When
// the paywall is ON, FREE still grants the core "firewall" experience so a new
// user can feel Klorn sort their inbox and auto-handle the noise: read the
// classified mail, the daily briefing, and AUTO (reversible actions only). What
// stays Pro is everything that costs us more or is the moat: sending/replying,
// calendar writes, pattern learning, and all integrations. Free volume is
// bounded by FREE_DAILY_COST_CAP_CENTS (see cost-guard), which is the real
// "daily N emails" limit. Setting this list to [] restores a pure
// subscriber-only model (isHardPaywalled then hard-walls free users on entry).
const FREE_TASTER: FeatureKey[] = [
  "email_read",
  "calendar_read",
  "daily_briefing",
  "email_auto_classify",
  "autonomous_agent",
  "agent_mode_auto",
];

// When the paywall is OFF (pre-launch default) FREE keeps its historical fuller
// set so merging changes nothing until launch flips PAYWALL_ENABLED.
const FREE_FEATURES: FeatureKey[] = PAYWALL_ENABLED
  ? FREE_TASTER
  : [
      "email_read",
      "calendar_read",
      "calendar_create",
      "daily_briefing",
      "email_auto_classify",
      "autonomous_agent",
      "pattern_learning",
    ];

export const PLAN_FEATURES: Record<string, Set<FeatureKey>> = {
  FREE: new Set<FeatureKey>(FREE_FEATURES),
  // PRO now includes every paid feature (TEAM tier merged in). TEAM key retained
  // only for existing subscribers on the legacy price; new signups go to PRO.
  PRO: new Set<FeatureKey>([
    "email_read",
    "email_write",
    "calendar_read",
    "calendar_create",
    "calendar_write",
    "autonomous_agent",
    "agent_mode_auto",
    "daily_briefing",
    "email_auto_classify",
    "email_auto_reply",
    "pattern_learning",
    "web_search",
    "write_document",
    "slack",
    "notion",
    "meeting_tools",
    "multi_account",
  ]),
  TEAM: new Set<FeatureKey>([
    "email_read",
    "email_write",
    "calendar_read",
    "calendar_create",
    "calendar_write",
    "autonomous_agent",
    "agent_mode_auto",
    "daily_briefing",
    "email_auto_classify",
    "email_auto_reply",
    "pattern_learning",
    "web_search",
    "write_document",
    "slack",
    "notion",
    "meeting_tools",
    "multi_account",
  ]),
  ENTERPRISE: new Set<FeatureKey>([
    "email_read",
    "email_write",
    "calendar_read",
    "calendar_create",
    "calendar_write",
    "autonomous_agent",
    "agent_mode_auto",
    "daily_briefing",
    "email_auto_classify",
    "email_auto_reply",
    "pattern_learning",
    "web_search",
    "write_document",
    "slack",
    "notion",
    "meeting_tools",
    "multi_account",
  ]),
};

/** Check if a plan has a specific feature. ADMIN role bypasses all gates. */
export function planHasFeature(plan: string, feature: FeatureKey, role?: string): boolean {
  if (role === "ADMIN") return true;
  const features = PLAN_FEATURES[plan];
  if (!features) return false;
  return features.has(feature);
}

/**
 * True if the user may use any paid feature — i.e. is on a paid/trialing/comped
 * plan (PRO/TEAM/ENTERPRISE), or is an admin. The single gate behind BYOK and
 * other subscriber-only capabilities. When the paywall is OFF (pre-launch) this
 * is always true, so nothing is gated until launch flips PAYWALL_ENABLED.
 * Comped accounts work for free: an admin sets `plan` to a paid tier from
 * /admin and `isEntitled` returns true without any Stripe subscription.
 */
export function isEntitled(plan: string, role?: string): boolean {
  if (!PAYWALL_ENABLED) return true;
  if (role === "ADMIN") return true;
  return plan === "PRO" || plan === "TEAM" || plan === "ENTERPRISE";
}

/**
 * True only when a signed-in user should be hard-walled out of the app on
 * entry (shown the full PaywallScreen). This happens ONLY when the paywall is
 * on, the user is not entitled (not paid/trial/admin), AND the free tier grants
 * no features at all — i.e. a pure subscriber-only model. With the usable free
 * tier (FREE grants the taster set) this is always false: free users get into
 * the app and are bounded by the free daily cost cap, not blocked at the door.
 * Flipping FREE to [] is the single switch back to subscriber-only.
 */
export function isHardPaywalled(plan: string, role?: string): boolean {
  if (isEntitled(plan, role)) return false;
  return PLAN_FEATURES.FREE.size === 0;
}

/**
 * Map tool names to the feature gate that controls them.
 * Tools not listed here are always available (tasks, notes, reminders, contacts, memory, utilities, time).
 */
export const TOOL_FEATURE_MAP: Record<string, FeatureKey> = {
  // Email
  list_emails: "email_read",
  read_email: "email_read",
  classify_emails: "email_read",
  mark_read: "email_read",
  send_email: "email_write",
  // Calendar
  list_events: "calendar_read",
  check_calendar_conflicts: "calendar_read",
  create_event: "calendar_create",
  delete_event: "calendar_write",
  // Web search
  web_search: "web_search",
  // Document writing
  write_document: "write_document",
  // Slack
  send_slack_message: "slack",
  list_slack_channels: "slack",
  read_slack_messages: "slack",
  // Notion
  search_notion: "notion",
  create_notion_page: "notion",
  list_notion_databases: "notion",
  // Meetings
  get_upcoming_meetings: "meeting_tools",
  join_meeting: "meeting_tools",
  summarize_meeting: "meeting_tools",
};
