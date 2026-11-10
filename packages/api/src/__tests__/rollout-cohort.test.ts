/**
 * The rollout cohort (decision L23 of docs/providers/unified-platform-plan.md:
 * flip order founder account, then cohort, then everyone). A feature flag may
 * be `cohort` as well as on or off: then only the users in
 * ROLLOUT_COHORT_USER_IDS get the feature, and everyone else gets what they get
 * while it is off. Read per call, so a flip needs no redeploy.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cohortRestriction,
  driveEnabled,
  driveSummariesEnabled,
  featureOpenTo,
  flagMode,
  googleDriveEnabled,
  klornDriveEnabled,
  objectStorageEnabled,
  rolloutCohortUserIds,
} from "../config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("flagMode", () => {
  it.each(["true", "1", "yes", "on", " TRUE "])("reads %j as on", (value) => {
    vi.stubEnv("SOME_FLAG", value);
    expect(flagMode("SOME_FLAG")).toBe("on");
  });

  it.each(["cohort", " Cohort "])("reads %j as cohort", (value) => {
    vi.stubEnv("SOME_FLAG", value);
    expect(flagMode("SOME_FLAG")).toBe("cohort");
  });

  it.each(["", "false", "0", "off", "cohorts", "maybe"])("reads %j as off", (value) => {
    vi.stubEnv("SOME_FLAG", value);
    expect(flagMode("SOME_FLAG")).toBe("off");
  });

  it("reads an unset flag as off", () => {
    expect(flagMode("A_FLAG_NOBODY_SET")).toBe("off");
  });
});

describe("rolloutCohortUserIds", () => {
  it("splits on commas and whitespace and drops blanks", () => {
    vi.stubEnv("ROLLOUT_COHORT_USER_IDS", " u1, u2 ,,u3\nu4 ");
    expect([...rolloutCohortUserIds()]).toEqual(["u1", "u2", "u3", "u4"]);
  });

  it("is empty when unset", () => {
    vi.stubEnv("ROLLOUT_COHORT_USER_IDS", "");
    expect(rolloutCohortUserIds().size).toBe(0);
  });
});

describe("featureOpenTo", () => {
  const FLAGS = ["FLAG_A", "FLAG_B"] as const;

  it("is open to everyone when every flag is on", () => {
    vi.stubEnv("FLAG_A", "true");
    vi.stubEnv("FLAG_B", "on");
    expect(featureOpenTo("anyone", FLAGS)).toBe(true);
  });

  it("is closed to everyone when any flag is off, the cohort included", () => {
    vi.stubEnv("FLAG_A", "cohort");
    vi.stubEnv("FLAG_B", "false");
    vi.stubEnv("ROLLOUT_COHORT_USER_IDS", "founder");
    expect(featureOpenTo("founder", FLAGS)).toBe(false);
  });

  it("is open only to the cohort when any flag is cohort", () => {
    vi.stubEnv("FLAG_A", "true");
    vi.stubEnv("FLAG_B", "cohort");
    vi.stubEnv("ROLLOUT_COHORT_USER_IDS", "founder");
    expect(featureOpenTo("founder", FLAGS)).toBe(true);
    expect(featureOpenTo("someone-else", FLAGS)).toBe(false);
  });

  it("is closed to everyone when a flag is cohort and the cohort is empty", () => {
    vi.stubEnv("FLAG_A", "cohort");
    vi.stubEnv("FLAG_B", "cohort");
    vi.stubEnv("ROLLOUT_COHORT_USER_IDS", "");
    expect(featureOpenTo("founder", FLAGS)).toBe(false);
  });
});

describe("featureOpenTo with no flags", () => {
  it("is closed: a feature made of nothing is never on", () => {
    expect(featureOpenTo("anyone", [])).toBe(false);
  });
});

describe("cohortRestriction (what a job may touch)", () => {
  const FLAGS = ["FLAG_A", "FLAG_B"] as const;

  it("is every user when every flag is on, no one when any is off", () => {
    vi.stubEnv("FLAG_A", "true");
    vi.stubEnv("FLAG_B", "true");
    expect(cohortRestriction(FLAGS)).toEqual({ kind: "all" });
    vi.stubEnv("FLAG_B", "false");
    expect(cohortRestriction(FLAGS)).toEqual({ kind: "none" });
  });

  it("is the cohort's ids when any flag is cohort", () => {
    vi.stubEnv("FLAG_A", "true");
    vi.stubEnv("FLAG_B", "cohort");
    vi.stubEnv("ROLLOUT_COHORT_USER_IDS", "u1 u2");
    expect(cohortRestriction(FLAGS)).toEqual({ kind: "only", userIds: ["u1", "u2"] });
  });
});

describe("the drive flags", () => {
  it.each([
    ["DRIVE_ENABLED", driveEnabled],
    ["KLORN_DRIVE_ENABLED", klornDriveEnabled],
    ["GOOGLE_DRIVE_ENABLED", googleDriveEnabled],
    ["DRIVE_SUMMARIES_ENABLED", driveSummariesEnabled],
  ] as const)("count %s as live in cohort mode (the routes then check the user)", (name, read) => {
    vi.stubEnv(name, "cohort");
    expect(read()).toBe(true);
    vi.stubEnv(name, "false");
    expect(read()).toBe(false);
  });

  it("keep object storage on or off only: it is infrastructure, never a cohort", () => {
    vi.stubEnv("OBJECT_STORAGE_ENABLED", "cohort");
    expect(objectStorageEnabled()).toBe(false);
  });
});
