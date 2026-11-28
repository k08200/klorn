/**
 * Daily Briefing - Klorn's autonomous planning feature
 *
 * Aggregates tasks, calendar events, commitments and the mail received since
 * the previous briefing into a daily summary. Can be triggered manually or
 * via cron.
 */

// The briefing is split by responsibility; this module keeps the public
// surface every caller imports (and every test mocks) unchanged:
// generation in briefing-generate.ts, delivery in briefing-delivery.ts, the
// HTTP routes in briefing-routes.ts.
export {
  __resetBriefingHealCooldownForTests,
  createDailyBriefingDelivery,
  ensureDailyBriefingNotification,
} from "./briefing-delivery.js";
export { listLocalBriefingEvents } from "./briefing-gather.js";
export {
  type BriefingLlmOutcome,
  buildSignalOnlyBriefing,
  default,
  FALLBACK_BRIEFING_SENTINEL,
  type GeneratedBriefing,
} from "./briefing-generate.js";
export { BRIEFING_SYSTEM_PROMPT } from "./briefing-prompt.js";
export { briefingRoutes } from "./briefing-routes.js";

// Tool for Klorn to generate briefing on demand
export const BRIEFING_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "generate_briefing",
      description:
        "Generate a daily briefing summarizing today's tasks, calendar events, emails, and notes. Use this when the user asks for a daily summary or morning briefing.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
];
