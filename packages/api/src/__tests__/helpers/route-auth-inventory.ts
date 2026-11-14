import Fastify, { type FastifyInstance, type RouteOptions } from "fastify";
import { isRouteAuthExempt, ROUTE_AUTH_EXEMPTIONS } from "../../security/route-auth-exemptions.js";
import { hasActiveSessionGuard } from "../../security/route-auth-guard.js";

export interface InventoryRoute {
  readonly methods: readonly string[];
  readonly url: string;
  /** The live route options: the guard mutates them after this hook saw them. */
  readonly options: RouteOptions;
}

export function routeLabel(route: Pick<InventoryRoute, "methods" | "url">): string {
  return `${route.methods.join(",")} ${route.url}`;
}

/**
 * Build a Fastify instance, record every route `register` declares, and wait
 * for ready. The recorder is added before `register` runs, so it sees each
 * route before the route-auth guard does; method and URL are copied at that
 * moment (Fastify rewrites `url` later for a prefix's trailing-slash twin),
 * while `options` is kept by reference so the guard's onRequest change shows.
 */
export async function collectRoutes(
  register: (app: FastifyInstance) => Promise<void> | void,
): Promise<{ app: FastifyInstance; routes: readonly InventoryRoute[] }> {
  const app = Fastify();
  const routes: InventoryRoute[] = [];
  app.addHook("onRoute", (options) => {
    const methods = typeof options.method === "string" ? [options.method] : [...options.method];
    routes.push({ methods, url: options.url, options });
  });
  await register(app);
  await app.ready();
  return { app, routes };
}

/** Routes that are neither behind the active-session guard nor exempt. */
export function findUnguardedRoutes(routes: readonly InventoryRoute[]): string[] {
  return routes
    .filter((route) => !hasActiveSessionGuard(route.options))
    .filter((route) => !isRouteAuthExempt(route.methods, route.url))
    .map(routeLabel);
}

/** Exemption keys that match no registered route (renamed or removed). */
export function findStaleExemptions(routes: readonly InventoryRoute[]): string[] {
  const registered = new Set(
    routes.flatMap((route) => route.methods.map((method) => `${method} ${route.url}`)),
  );
  return Object.keys(ROUTE_AUTH_EXEMPTIONS).filter((key) => !registered.has(key));
}
