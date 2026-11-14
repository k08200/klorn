import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from "fastify";
import { isDemoAccessEnabled, requireAuth } from "../auth.js";
import { isRouteAuthExempt } from "./route-auth-exemptions.js";

/**
 * Default-deny authentication for every HTTP route.
 *
 * `getUserId` only checks a JWT's signature and expiry. A route that called it
 * without the `requireAuth` preHandler therefore kept serving a token whose
 * session had ended — logged out, kicked by the device limit, idle past the
 * window, or revoked by a password reset — until the token's own 7-day expiry.
 *
 * The guard closes that class of gap structurally instead of route by route:
 * an onRoute hook attaches `requireActiveSession` to EVERY route as it is
 * declared, unless the route is listed in route-auth-exemptions.ts with a
 * reason. A route added later without a guard is guarded anyway; making one
 * public takes an explicit, reviewed exemption entry.
 *
 * Why onRoute rather than a global onRequest hook that matches `/api/*` paths:
 * the decision is made once per route template at registration (exact method +
 * URL template, the strings Fastify itself routes on), so there is no runtime
 * string matching on the raw request path to get wrong (encoding, trailing
 * slashes, case, prefix overlap).
 *
 * It runs as a route-level onRequest hook, so an unauthenticated request is
 * rejected before its body is parsed. @fastify/rate-limit appends its own
 * onRequest hook from an onRoute hook registered earlier, so the limiter still
 * runs first. Routes that already declare `requireAuth` keep it: requireAuth
 * remembers a session it verified for the request, so the second call costs no
 * database round trip.
 */
export async function requireActiveSession(request: FastifyRequest, reply: FastifyReply) {
  // The demo-user fallback, kept exactly as getUserId has it: only where
  // isDemoAccessEnabled() holds (NODE_ENV development/test AND
  // ENABLE_DEMO_USER=true), and only for a request carrying no credentials.
  if (request.headers.authorization === undefined && isDemoAccessEnabled()) return;
  return requireAuth(request, reply);
}

/** One element of a hook option that takes a single hook or an array of them. */
type HookElement<T> = T extends ReadonlyArray<infer H> ? H : T;
type OnRequestHook = HookElement<NonNullable<RouteOptions["onRequest"]>>;

function hookList(hooks: RouteOptions["onRequest"]): OnRequestHook[] {
  if (hooks === undefined) return [];
  return Array.isArray(hooks) ? [...hooks] : [hooks as OnRequestHook];
}

/** True when the route's onRequest hooks already include the guard. */
export function hasActiveSessionGuard(routeOptions: Pick<RouteOptions, "onRequest">): boolean {
  return hookList(routeOptions.onRequest).includes(requireActiveSession as OnRequestHook);
}

/**
 * Install the guard. Must run before any route is declared: Fastify calls an
 * onRoute hook only for routes added after it, in this instance and its
 * children. registerApiRoutes calls it first.
 */
export function installRouteAuthGuard(app: FastifyInstance): void {
  app.addHook("onRoute", (routeOptions) => {
    if (isRouteAuthExempt(routeOptions.method, routeOptions.url)) return;
    if (hasActiveSessionGuard(routeOptions)) return;
    routeOptions.onRequest = [
      ...hookList(routeOptions.onRequest),
      requireActiveSession as OnRequestHook,
    ];
  });
}
