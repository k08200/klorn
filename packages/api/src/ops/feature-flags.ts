/**
 * One truthful snapshot of every operator feature flag — the answer to "what
 * is actually on right now?" without grepping Render env or probing behavior.
 *
 * Two source kinds, reported as such:
 * - `importTime`: config.ts consts frozen when the process booted. An env edit
 *   without a restart does NOT change these — reporting the const (not the
 *   live env) is what makes the endpoint truthful.
 * - `dynamic`: flags the code re-reads per call (togglable without restart).
 */

import {
  CONTACT_ENGAGEMENT_IN_JUDGE,
  FALLBACK_REJUDGE_SWEEP,
  LEARNED_RULES_IN_JUDGE,
  MULTI_INBOX_SYNC_ENABLED,
  PAYWALL_ENABLED,
  SENDER_TRAITS_IN_JUDGE,
} from "../config.js";

export interface FlagsReport {
  importTime: Record<string, boolean>;
  dynamic: Record<string, boolean>;
  /** Non-flag operational config presence (never the values). */
  configured: Record<string, boolean>;
}

const TRUTHY = new Set(["true", "1", "yes", "on"]);

/** Dynamic env flag as its reading site interprets it. Pure over `env`. */
export function dynamicFlag(env: NodeJS.ProcessEnv, key: string): boolean {
  return TRUTHY.has((env[key] ?? "").toLowerCase());
}

export function collectFeatureFlags(env: NodeJS.ProcessEnv = process.env): FlagsReport {
  // Every key below is the EXACT env variable name — copy-paste-able into
  // Render. (A prettified display name already caused an operator to create
  // `DB_HEARTBEAT`/`SENTRY` vars that nothing reads, 2026-07-20.)
  return {
    importTime: {
      SENDER_TRAITS_IN_JUDGE,
      LEARNED_RULES_IN_JUDGE,
      CONTACT_ENGAGEMENT_IN_JUDGE,
      FALLBACK_REJUDGE_SWEEP,
      MULTI_INBOX_SYNC_ENABLED,
      PAYWALL_ENABLED,
      // Scheduler-scoped consts (module-private there; same boot-time freeze).
      PROACTIVE_ACTIONS_ENABLED: env.PROACTIVE_ACTIONS_ENABLED === "true",
      DB_HEARTBEAT_ENABLED: env.DB_HEARTBEAT_ENABLED === "true",
    },
    dynamic: {
      JUDGE_INCLUDE_BODY: dynamicFlag(env, "JUDGE_INCLUDE_BODY"),
      AUTO_TIER_EXECUTION: env.AUTO_TIER_EXECUTION === "true",
      CI_NOISE_SILENT_FLOOR: dynamicFlag(env, "CI_NOISE_SILENT_FLOOR"),
      SENDER_ADDRESS_INDEX_ENABLED: dynamicFlag(env, "SENDER_ADDRESS_INDEX_ENABLED"),
      LOG_RETENTION_ENABLED:
        env.LOG_RETENTION_ENABLED === "true" || env.LOG_RETENTION_ENABLED === "1",
      PHONE_ESCALATION_ENABLED: dynamicFlag(env, "PHONE_ESCALATION_ENABLED"),
    },
    configured: {
      GMAIL_PUBSUB_TOPIC: Boolean(env.GMAIL_PUBSUB_TOPIC),
      EMBEDDING_MODEL: Boolean(env.EMBEDDING_MODEL),
      TWILIO_ACCOUNT_SID: Boolean(env.TWILIO_ACCOUNT_SID),
      SENTRY_DSN: Boolean(env.SENTRY_DSN),
    },
  };
}
