/**
 * Every drive, smart-action, vault-export and rules-dsl route checks the rollout cohort
 * (L23) after authentication, so a route added later cannot skip it. The one exception is unlinking a Google
 * account: auth only, so a user outside the cohort can always remove a grant. The KakaoTalk
 * import's list and delete check the cohort with ownerExitCohortGate instead: the cohort, or a
 * user who owns an import (routes/owner-exit-gate.ts), so a narrowed cohort never traps a chat.
 */

/** Routes whose cohort check also lets an owner out, by file: the gate each one uses. */
const OWNER_EXIT_CHAINS: Record<string, string[]> = {
  "kakao-import.ts": ["ownerExitCohortGate", "ownerExitCohortGate"],
};

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const source = (path: string) =>
  readFileSync(new URL(`../routes/${path}`, import.meta.url), "utf8");

describe("the cohort-gated routes", () => {
  it.each([
    "drive.ts",
    "klorn-drive.ts",
    "google-drive-link.ts",
    "smart-actions.ts",
    "vault-export.ts",
    "rules-dsl.ts",
    "slack-connection.ts",
    "kakao-import.ts",
  ])("%s checks the cohort right after requireAuth on every route", (file) => {
    const text = source(file);
    const chains = [...text.matchAll(/preHandler:\s*(\[[^\]]*\]|requireAuth)/g)].map((m) =>
      (m[1] ?? "").replace(/\s+/g, " ").replace("[ ", "["),
    );
    expect(chains.length).toBeGreaterThan(0);
    const exempt = chains.filter((chain) => !/^\[requireAuth, cohortGate\(/.test(chain));
    const ownerExits = exempt.filter((chain) =>
      /^\[requireAuth, ownerExitCohortGate\(/.test(chain),
    );
    expect(ownerExits.map(() => "ownerExitCohortGate")).toEqual(OWNER_EXIT_CHAINS[file] ?? []);
    expect(exempt.filter((chain) => !ownerExits.includes(chain))).toEqual(
      file === "google-drive-link.ts" ? ["requireAuth"] : [],
    );
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
