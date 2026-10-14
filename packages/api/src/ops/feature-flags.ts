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
  AUTO_REPLY_LINKED_INBOX_ENABLED,
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
      AUTO_REPLY_LINKED_INBOX_ENABLED,
      PAYWALL_ENABLED,
      // Scheduler-scoped consts (module-private there; same boot-time freeze).
      PROACTIVE_ACTIONS_ENABLED: env.PROACTIVE_ACTIONS_ENABLED === "true",
      DB_HEARTBEAT_ENABLED: env.DB_HEARTBEAT_ENABLED === "true",
    },
    dynamic: {
      ATTENTION_AGING_ENABLED: dynamicFlag(env, "ATTENTION_AGING_ENABLED"),
      ICLOUD_INBOX_ENABLED: dynamicFlag(env, "ICLOUD_INBOX_ENABLED"),
      OUTLOOK_INBOX_ENABLED: dynamicFlag(env, "OUTLOOK_INBOX_ENABLED"),
      JUDGE_INCLUDE_BODY: dynamicFlag(env, "JUDGE_INCLUDE_BODY"),
      AUTO_TIER_EXECUTION: env.AUTO_TIER_EXECUTION === "true",
      CI_NOISE_SILENT_FLOOR: dynamicFlag(env, "CI_NOISE_SILENT_FLOOR"),
      SENDER_ADDRESS_INDEX_ENABLED: dynamicFlag(env, "SENDER_ADDRESS_INDEX_ENABLED"),
      LOG_RETENTION_ENABLED:
        env.LOG_RETENTION_ENABLED === "true" || env.LOG_RETENTION_ENABLED === "1",
      PHONE_ESCALATION_ENABLED: dynamicFlag(env, "PHONE_ESCALATION_ENABLED"),
      // Read at request time by config.ts `providerInboxSelectorEnabled()`, so
      // it belongs here rather than in the boot-frozen map above.
      PROVIDER_INBOX_SELECTOR_ENABLED: dynamicFlag(env, "PROVIDER_INBOX_SELECTOR_ENABLED"),
      TIER_V2_ENABLED: defaultOnFlag(env, "TIER_V2_ENABLED"),
      AUTO_MODE_SEND_ENABLED: defaultOnFlag(env, "AUTO_MODE_SEND_ENABLED"),
      SPAM_INTAKE_ENABLED: defaultOnFlag(env, "SPAM_INTAKE_ENABLED"),
      // Read at classification time by mail/list-unsubscribe.ts
      // autoUnsubscribeEnabled(); one-click auto-unsubscribe of SILENT promo.
      AUTO_UNSUBSCRIBE_ENABLED: dynamicFlag(env, "AUTO_UNSUBSCRIBE_ENABLED"),
      // Read per message by agentcore/telegram-chat.ts telegramChatEnabled().
      TELEGRAM_CHAT_ENABLED: dynamicFlag(env, "TELEGRAM_CHAT_ENABLED"),
      // Read per call by config.ts objectStorageEnabled() (plan step D1). While
      // on, deleting an account deletes its stored objects first.
      OBJECT_STORAGE_ENABLED: dynamicFlag(env, "OBJECT_STORAGE_ENABLED"),
    },
    configured: {
      GMAIL_PUBSUB_TOPIC: Boolean(env.GMAIL_PUBSUB_TOPIC),
      EMBEDDING_MODEL: Boolean(env.EMBEDDING_MODEL),
      TWILIO_ACCOUNT_SID: Boolean(env.TWILIO_ACCOUNT_SID),
      SENTRY_DSN: Boolean(env.SENTRY_DSN),
      MS_CLIENT_ID: Boolean(env.MS_CLIENT_ID),
      OBJECT_STORAGE_BUCKET: Boolean(env.OBJECT_STORAGE_BUCKET),
    },
  };
}

/** Default-ON dynamic flag: set the env var to "false"/"0"/"off" to disable. */
function defaultOnFlag(env: NodeJS.ProcessEnv, key: string): boolean {
  const raw = (env[key] ?? "").toLowerCase();
  return !["false", "0", "off", "no"].includes(raw);
}

/**
 * Ontology v2 classification (5 tiers + autoEligible; docs/design/
 * tier-ontology-v2.md). Flipped default-ON 2026-08-18 by founder decision
 * ("분류 6개 왜 아직 안 했냐") — TIER_V2_ENABLED=false is the emergency
 * kill switch back to the v1 4-tier rule.
 */
export function tierV2Enabled(): boolean {
  return defaultOnFlag(process.env, "TIER_V2_ENABLED");
}

/**
 * auto 모드 unattended replies for autoEligible items. Default-ON since
 * 2026-08-18 (founder: "auto는 답장도 직접 알아서 하도록" — 한번에 싹 다).
 * The REAL gate is per-user: nothing sends unless the user set
 * attentionMode=AUTO in settings and holds the entitlement.
 * AUTO_MODE_SEND_ENABLED=false is the global kill switch.
 */
export function autoModeSendEnabled(): boolean {
  return defaultOnFlag(process.env, "AUTO_MODE_SEND_ENABLED");
}

/**
 * Spam-lane ingestion: sync the most recent SPAM-labeled Gmail messages so a
 * real mail Gmail wrongly spammed still reaches the queue (never PUSH — see
 * the judge's spam floor). Dynamic; OFF = the historical INBOX-only sync.
 */
export function spamIntakeEnabled(): boolean {
  // Default-ON since 2026-08-18 (same founder go as the tier flip; capped at
  // 10/sweep). SPAM_INTAKE_ENABLED=false disables.
  return defaultOnFlag(process.env, "SPAM_INTAKE_ENABLED");
}
