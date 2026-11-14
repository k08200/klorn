import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerApiRoutes } from "../register-api-routes.js";
import {
  ROUTE_AUTH_EXEMPTION_KINDS,
  ROUTE_AUTH_EXEMPTIONS,
} from "../security/route-auth-exemptions.js";
import { hasActiveSessionGuard, installRouteAuthGuard } from "../security/route-auth-guard.js";
import {
  collectRoutes,
  findStaleExemptions,
  findUnguardedRoutes,
  type InventoryRoute,
  routeLabel,
} from "./helpers/route-auth-inventory.js";

// The route inventory: boots the production route set (registerApiRoutes, the
// same function index.ts calls) and checks every route Fastify registers. A
// route is acceptable only if it carries the active-session guard or is listed
// in security/route-auth-exemptions.ts with a reason. A route someone adds
// later is guarded by default; this test is what fails if a route ever escapes
// the guard (declared before it, or on an instance that does not inherit it).

const VALID_KINDS: ReadonlySet<string> = new Set(ROUTE_AUTH_EXEMPTION_KINDS);

// The routes found serving on a bare JWT signature check (getUserId without
// requireAuth) or with no check at all when the guard was introduced.
const FORMERLY_UNGUARDED = [
  "GET /api/briefing/feedback/summary",
  "POST /api/briefing/generate",
  "GET /api/briefing/data",
  "POST /api/briefing/:id/picks/:rank/open",
  "GET /api/briefing/:id/top-actions/feedback",
  "POST /api/briefing/:id/top-actions/:rank/feedback",
  "GET /api/briefing/status",
  "GET /api/notion/status",
];

let routes: readonly InventoryRoute[] = [];

beforeAll(async () => {
  ({ routes } = await collectRoutes((app) => registerApiRoutes(app)));
});

function findRoute(label: string): InventoryRoute | undefined {
  const [method, url] = label.split(" ");
  return routes.find((route) => route.url === url && route.methods.includes(method ?? ""));
}

describe("route-auth inventory — the real route set", () => {
  it("sees the whole API, not an empty or partial registration", () => {
    expect(routes.length).toBeGreaterThan(300);
    expect(findRoute("GET /api/health")).toBeDefined();
    expect(findRoute("GET /api/briefing/today")).toBeDefined();
    expect(findRoute("POST /api/mcp")).toBeDefined();
  });

  it("leaves no route without the active-session guard unless it is explicitly exempt", () => {
    expect(findUnguardedRoutes(routes)).toEqual([]);
  });

  it("guards the HEAD twin of a guarded GET and exempts the HEAD twin of an exempt GET", () => {
    const headOf = (url: string) =>
      routes.find((route) => route.url === url && route.methods.includes("HEAD"));
    const guardedHead = headOf("/api/briefing/status");
    const exemptHead = headOf("/api/health");
    expect(guardedHead && hasActiveSessionGuard(guardedHead.options)).toBe(true);
    expect(exemptHead && hasActiveSessionGuard(exemptHead.options)).toBe(false);
  });

  it("guards the routes that used to accept a bare JWT signature", () => {
    for (const label of FORMERLY_UNGUARDED) {
      const route = findRoute(label);
      expect(route, label).toBeDefined();
      expect(route && hasActiveSessionGuard(route.options), label).toBe(true);
    }
  });

  it("does not exempt any admin, data-export or account route", () => {
    const sensitive = Object.keys(ROUTE_AUTH_EXEMPTIONS).filter((key) =>
      /\/api\/(admin|user|sms|keys|devices|teams|billing)\b/.test(key),
    );
    expect(sensitive).toEqual([]);
  });

  it("has no stale exemption (every entry matches a registered route)", () => {
    expect(findStaleExemptions(routes)).toEqual([]);
  });

  it("justifies every exemption with a known kind and a reason", () => {
    for (const [key, exemption] of Object.entries(ROUTE_AUTH_EXEMPTIONS)) {
      expect(VALID_KINDS.has(exemption.kind), key).toBe(true);
      expect(exemption.why.trim().length, key).toBeGreaterThan(20);
      expect(key, key).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \/api\//);
    }
  });
});

describe("route-auth inventory — completeness", () => {
  it("index.ts declares no route of its own (all of them go through registerApiRoutes)", () => {
    // A route declared on the root app in index.ts is either before the guard
    // (unguarded) or after it (guarded, but outside this inventory).
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf-8");
    const declarations = source.match(
      /\bapp\.(get|post|put|patch|delete|head|options|all|route)\s*[(<]/g,
    );
    expect(declarations).toBeNull();
    // Nor does it register a route plugin after the routes: before the call
    // only the cross-cutting plugins (helmet, cors, rate-limit) are registered.
    const call = source.indexOf("await registerApiRoutes(app);");
    expect(call).toBeGreaterThan(-1);
    expect(source.indexOf("app.register(", call)).toBe(-1);
  });
});

describe("route-auth inventory — the checker itself", () => {
  it("reports a route the guard never saw (declared on an instance without it)", async () => {
    // A sibling plugin registered BEFORE the guard is installed on the root:
    // Fastify runs onRoute hooks only for routes declared after the hook.
    const { routes: escaped } = await collectRoutes(async (app) => {
      await app.register(async (scope) => {
        scope.get("/api/escaped", async () => ({ leaked: true }));
      });
      installRouteAuthGuard(app);
      await app.register(async (scope) => {
        scope.get("/api/covered", async () => ({ ok: true }));
      });
    });
    const unguarded = findUnguardedRoutes(escaped);
    expect(unguarded).toContain("GET /api/escaped");
    expect(unguarded).not.toContain("GET /api/covered");
  });

  it("guards both the prefix-root route and its trailing-slash twin", async () => {
    vi.stubEnv("ENABLE_DEMO_USER", "");
    const { app } = await collectRoutes(async (root) => {
      installRouteAuthGuard(root);
      await root.register(
        async (scope) => {
          scope.get("/", async () => ({ ok: true }));
        },
        { prefix: "/api/twin" },
      );
    });
    expect((await app.inject({ method: "GET", url: "/api/twin" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/twin/" })).statusCode).toBe(401);
    expect((await app.inject({ method: "HEAD", url: "/api/twin/" })).statusCode).toBe(401);
    await app.close();
    vi.unstubAllEnvs();
  });

  it("reports a synthetic route that carries no guard", () => {
    const bare: InventoryRoute = {
      methods: ["GET"],
      url: "/api/brand-new",
      options: { method: "GET", url: "/api/brand-new", handler: async () => ({}) },
    };
    expect(findUnguardedRoutes([bare])).toEqual([routeLabel(bare)]);
  });

  it("reports an exemption whose route no longer exists", () => {
    expect(findStaleExemptions([])).toEqual(Object.keys(ROUTE_AUTH_EXEMPTIONS));
  });
});
