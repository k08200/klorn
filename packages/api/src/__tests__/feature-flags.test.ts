/**
 * The flags report must answer "what is on?" truthfully: dynamic flags follow
 * the env passed in; configured entries report presence only (never values).
 * (Import-time entries reflect config.ts consts frozen at module load — their
 * truthfulness IS that they ignore later env edits, so they aren't re-derived
 * from the stubbed env here.)
 */

import { describe, expect, it } from "vitest";
import { collectFeatureFlags, dynamicFlag } from "../ops/feature-flags.js";

describe("collectFeatureFlags", () => {
  it("reads dynamic flags from the provided env", () => {
    const report = collectFeatureFlags({
      JUDGE_INCLUDE_BODY: "true",
      AUTO_TIER_EXECUTION: "true",
      CI_NOISE_SILENT_FLOOR: "yes",
      LOG_RETENTION_ENABLED: "1",
    } as NodeJS.ProcessEnv);
    expect(report.dynamic.JUDGE_INCLUDE_BODY).toBe(true);
    expect(report.dynamic.AUTO_TIER_EXECUTION).toBe(true);
    expect(report.dynamic.CI_NOISE_SILENT_FLOOR).toBe(true);
    expect(report.dynamic.LOG_RETENTION_ENABLED).toBe(true);
    expect(report.dynamic.PHONE_ESCALATION_ENABLED).toBe(false);
  });

  it("reports configured entries as presence booleans, never values", () => {
    const report = collectFeatureFlags({
      GMAIL_PUBSUB_TOPIC: "projects/x/topics/y",
      EMBEDDING_MODEL: "nomic-embed-text",
    } as NodeJS.ProcessEnv);
    expect(report.configured.GMAIL_PUBSUB_TOPIC).toBe(true);
    expect(report.configured.EMBEDDING_MODEL).toBe(true);
    expect(report.configured.TWILIO_ACCOUNT_SID).toBe(false);
    expect(JSON.stringify(report)).not.toContain("projects/x"); // no secret leakage

    // Every reported key must be the exact env var name — copy-paste-able.
    const keys = [
      ...Object.keys(report.importTime),
      ...Object.keys(report.dynamic),
      ...Object.keys(report.configured),
    ];
    for (const k of keys) {
      expect(k).toMatch(/^[A-Z0-9_]+$/);
    }
    expect(keys).toContain("DB_HEARTBEAT_ENABLED");
    expect(keys).toContain("SENTRY_DSN");
    expect(keys).not.toContain("DB_HEARTBEAT");
    expect(keys).not.toContain("SENTRY");
  });

  it("empty env → everything dynamic/configured is off", () => {
    const report = collectFeatureFlags({} as NodeJS.ProcessEnv);
    expect(Object.values(report.dynamic).every((v) => v === false)).toBe(true);
    expect(Object.values(report.configured).every((v) => v === false)).toBe(true);
  });
});

describe("dynamicFlag", () => {
  it("accepts the truthy spellings the reading sites accept", () => {
    for (const v of ["true", "1", "yes", "on"]) {
      expect(dynamicFlag({ K: v } as NodeJS.ProcessEnv, "K")).toBe(true);
    }
    expect(dynamicFlag({ K: "false" } as NodeJS.ProcessEnv, "K")).toBe(false);
    expect(dynamicFlag({} as NodeJS.ProcessEnv, "K")).toBe(false);
  });
});
