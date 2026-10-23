/**
 * preHandler that keeps a feature in `cohort` mode (config.ts `flagMode`,
 * decision L23) to the users in ROLLOUT_COHORT_USER_IDS. It runs after
 * requireAuth, since it needs the user: anyone outside the cohort gets the
 * same default 404 as the flag off (darkRouteGate), byte for byte in the body.
 * Unlike darkRouteGate it cannot answer before authentication, so in cohort
 * mode a request without a session gets requireAuth's 401: the route's
 * existence shows, its content does not.
 */

import type { preHandlerAsyncHookHandler } from "fastify";
import { getUserId } from "../auth.js";
import { featureOpenTo } from "../config.js";
import { replyRouteNotFound } from "./dark-route-gate.js";

export function cohortGate(envNames: readonly string[]): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    if (!featureOpenTo(getUserId(request), envNames)) return replyRouteNotFound(request, reply);
  };
}
