/**
 * Every drive route checks the rollout cohort (L23) after authentication, so a
 * route added later cannot skip it. The one exception is unlinking a Google
 * account: auth only, so a user outside the cohort can always remove a grant.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const source = (path: string) =>
  readFileSync(new URL(`../routes/${path}`, import.meta.url), "utf8");

describe("the drive routes and the cohort", () => {
  it.each([
    "drive.ts",
    "klorn-drive.ts",
    "google-drive-link.ts",
  ])("%s checks the cohort right after requireAuth on every route", (file) => {
    const text = source(file);
    const chains = [...text.matchAll(/preHandler:\s*(\[[^\]]*\]|requireAuth)/g)].map((m) =>
      (m[1] ?? "").replace(/\s+/g, " ").replace("[ ", "["),
    );
    expect(chains.length).toBeGreaterThan(0);
    const exempt = chains.filter((chain) => !/^\[requireAuth, cohortGate\(/.test(chain));
    expect(exempt).toEqual(file === "google-drive-link.ts" ? ["requireAuth"] : []);
  });

  it("exempts only the Google unlink", () => {
    const text = source("google-drive-link.ts");
    const deleteRoute = text.slice(text.indexOf("app.delete("), text.indexOf("app.delete(") + 300);
    expect(deleteRoute).toMatch(/preHandler: requireAuth,/);
  });
});

describe("reportRolloutCohort", () => {
  it("warns when a flag is in cohort mode and the cohort is empty", async () => {
    const { reportRolloutCohort } = await import("../routes/cohort-gate.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("DRIVE_ENABLED", "cohort");
    vi.stubEnv("ROLLOUT_COHORT_USER_IDS", "");
    reportRolloutCohort(["DRIVE_ENABLED"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no one gets these features"));
    vi.unstubAllEnvs();
    warn.mockRestore();
  });
});
