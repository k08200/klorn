import Stripe from "stripe";

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
    deviceLimit: 5,
  },
  PRO: {
    name: "Pro",
    priceId: process.env.STRIPE_PRO_PRICE_ID || "",
    testLimit: 500,
    messageLimit: 2000,
    tokenLimit: 10_000_000,
    deviceLimit: 10,
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
  | "meeting_tools";

export const PLAN_FEATURES: Record<string, Set<FeatureKey>> = {
  FREE: new Set<FeatureKey>([
    "email_read",
    "calendar_read",
    "calendar_create",
    "daily_briefing",
    "email_auto_classify",
    "autonomous_agent",
    "pattern_learning",
  ]),
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
