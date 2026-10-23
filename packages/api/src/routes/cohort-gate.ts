/**
 * preHandler that keeps a feature in `cohort` mode (config.ts `flagMode`,
 * decision L23) to the users in ROLLOUT_COHORT_USER_IDS. It runs after
 * requireAuth, since it needs the user: anyone outside the cohort gets the
 * same default 404 body as the flag off (darkRouteGate). It cannot answer
 * before authentication and schema validation, so in cohort mode a request
 * without a session gets requireAuth's 401 and a malformed one a 400: that the
 * route exists shows (the route list is public in the repo anyway), what it
 * holds does not.
 *
 * The data layer checks the cohort too (drive-scope.ts `driveProvidersFor`,
 * summary-policy.ts `driveSummariesOpenTo`, the jobs' `cohortRestriction`), so
 * a user outside it reaches nothing through any other path.
 */

import type { preHandlerAsyncHookHandler } from "fastify";
import { getUserId } from "../auth.js";
import { featureOpenTo, flagMode, rolloutCohortUserIds } from "../config.js";
import { replyRouteNotFound } from "./dark-route-gate.js";

export function cohortGate(envNames: readonly string[]): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    if (!featureOpenTo(getUserId(request), envNames)) return replyRouteNotFound(request, reply);
  };
}

/**
 * At boot: a flag in cohort mode with an empty cohort locks everyone out, the
 * founder included, without a word. Say so, with the cohort's size only.
 */
export function reportRolloutCohort(flagNames: readonly string[]): void {
  const cohortFlags = flagNames.filter((name) => flagMode(name) === "cohort");
  if (cohortFlags.length === 0) return;
  const size = rolloutCohortUserIds().size;
  const line = `[ROLLOUT] cohort mode for ${cohortFlags.join(", ")}: ${size} user(s) in ROLLOUT_COHORT_USER_IDS`;
  if (size === 0) console.warn(`${line}; no one gets these features.`);
  else console.log(line);
}
