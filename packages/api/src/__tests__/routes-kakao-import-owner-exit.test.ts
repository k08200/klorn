/**
 * The KakaoTalk import's way out (owner-exit-gate.ts, as #1785 did for IMAP).
 * KAKAO_IMPORT_ENABLED turned off, or the cohort narrowed, made every route
 * answer 404, so a user who had imported a chat could no longer list or delete
 * it. The list and the delete now stay open to a user who owns an import;
 * everyone else gets the cloaked 404 as before, without a session too, and
 * preview, upload and the one-import read stay dark.
 *
 * Through the production route guard and the real session check, as the IMAP
 * way-out tests do.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => {
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({ id: "user-1", plan: "PRO", role: "USER" })),
      update: vi.fn(async () => ({ id: "user-1" })),
    },
    device: {
      findUnique: vi.fn(async () => ({ id: "device-1" })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});

const store = vi.hoisted(() => ({
  createKakaoImport: vi.fn(),
  listKakaoImports: vi.fn(),
  getKakaoImport: vi.fn(),
  deleteKakaoImport: vi.fn(),
  hasKakaoImport: vi.fn(),
}));
vi.mock("../kakao-import/store.js", () => ({ ...store, KAKAO_MAX_IMPORTS_PER_USER: 20 }));
vi.mock("../user-timezone.js", () => ({ getUserTimeZone: vi.fn(async () => "Asia/Seoul") }));

const ENV = ["KAKAO_IMPORT_ENABLED", "ROLLOUT_COHORT_USER_IDS"] as const;
const ORIGINAL = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
const IMPORT_ID = "11111111-2222-4333-8444-555555555555";

const DARK_ROUTES = [
  ["POST", "/api/kakao-import/preview"],
  ["POST", "/api/kakao-import"],
  ["GET", `/api/kakao-import/${IMPORT_ID}`],
] as const;
const WAY_OUT = [
  ["GET", "/api/kakao-import"],
  ["DELETE", `/api/kakao-import/${IMPORT_ID}`],
] as const;

async function buildGuardedApp() {
  vi.resetModules();
  const { signToken } = await import("../auth.js");
  const { installRouteAuthGuard } = await import("../security/route-auth-guard.js");
  const { kakaoImportRoutes } = await import("../routes/kakao-import.js");
  const { prisma } = await import("../db.js");
  const app = Fastify();
  installRouteAuthGuard(app);
  await app.register(kakaoImportRoutes, { prefix: "/api/kakao-import" });
  await app.ready();
  const token = signToken({ userId: "user-1", email: "test@example.com" });
  return { app, prisma, headers: { authorization: `Bearer ${token}` } };
}

/** The body Fastify gives a route that does not exist, for this method and url. */
function notFoundBody(method: string, url: string) {
  return { message: `Route ${method}:${url} not found`, error: "Not Found", statusCode: 404 };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.KAKAO_IMPORT_ENABLED;
  delete process.env.ROLLOUT_COHORT_USER_IDS;
  store.hasKakaoImport.mockResolvedValue(false);
  store.listKakaoImports.mockResolvedValue([{ id: IMPORT_ID, status: "DONE" }]);
  store.deleteKakaoImport.mockResolvedValue(true);
  store.getKakaoImport.mockResolvedValue({ id: IMPORT_ID });
});

afterEach(() => {
  for (const name of ENV) {
    const value = ORIGINAL[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.resetModules();
});

describe("flag turned off after users imported: the way out stays open to the owner", () => {
  it("no session: every route is a route that does not exist, and nothing is looked up", async () => {
    store.hasKakaoImport.mockResolvedValue(true);
    const { app } = await buildGuardedApp();
    for (const authorization of [undefined, "Bearer not-a-token", "Basic abc"]) {
      for (const [method, url] of [...WAY_OUT, ...DARK_ROUTES]) {
        const res = await app.inject({
          method,
          url,
          headers: authorization ? { authorization } : {},
        });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
        expect(res.json()).toEqual(notFoundBody(method, url));
      }
    }
    expect(store.hasKakaoImport).not.toHaveBeenCalled();
    expect(store.deleteKakaoImport).not.toHaveBeenCalled();
  });

  it("an owner can list and delete; preview, upload and the one-import read stay dark", async () => {
    store.hasKakaoImport.mockResolvedValue(true);
    const { app, headers } = await buildGuardedApp();
    const list = await app.inject({ method: "GET", url: "/api/kakao-import", headers });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ imports: [{ id: IMPORT_ID, status: "DONE" }] });
    expect(store.listKakaoImports).toHaveBeenCalledWith("user-1");
    const del = await app.inject({
      method: "DELETE",
      url: `/api/kakao-import/${IMPORT_ID}`,
      headers,
    });
    expect(del.statusCode).toBe(204);
    expect(store.deleteKakaoImport).toHaveBeenCalledWith("user-1", IMPORT_ID);
    expect(store.hasKakaoImport).toHaveBeenCalledWith("user-1");
    for (const [method, url] of DARK_ROUTES) {
      const res = await app.inject({ method, url, headers });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json()).toEqual(notFoundBody(method, url));
    }
    expect(store.createKakaoImport).not.toHaveBeenCalled();
    expect(store.getKakaoImport).not.toHaveBeenCalled();
  });

  it("an owner deleting an id that is not theirs gets the route's own 404", async () => {
    store.hasKakaoImport.mockResolvedValue(true);
    store.deleteKakaoImport.mockResolvedValue(false);
    const { app, headers } = await buildGuardedApp();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/kakao-import/${IMPORT_ID}`,
      headers,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Import not found.", code: "not-found" });
  });

  it("an owner whose session ended gets the guard's 401, and nothing is deleted", async () => {
    store.hasKakaoImport.mockResolvedValue(true);
    const { app, prisma, headers } = await buildGuardedApp();
    vi.mocked(prisma.device.findUnique).mockResolvedValueOnce(null as never);
    const res = await app.inject({
      method: "DELETE",
      url: `/api/kakao-import/${IMPORT_ID}`,
      headers,
    });
    expect(res.statusCode).toBe(401);
    expect(store.deleteKakaoImport).not.toHaveBeenCalled();
  });

  it("a signed-in non-owner gets the cloaked 404, and the answer is remembered (one lookup)", async () => {
    const { app, headers } = await buildGuardedApp();
    for (let probe = 0; probe < 3; probe++) {
      for (const [method, url] of WAY_OUT) {
        const res = await app.inject({ method, url, headers });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
        expect(res.json()).toEqual(notFoundBody(method, url));
      }
    }
    expect(store.hasKakaoImport).toHaveBeenCalledTimes(1);
    expect(store.listKakaoImports).not.toHaveBeenCalled();
    expect(store.deleteKakaoImport).not.toHaveBeenCalled();
  });

  it("a database failure in the ownership check is the cloaked 404, not a 500, and is not remembered", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    store.hasKakaoImport.mockRejectedValueOnce(new Error("pool timeout"));
    const { app, headers } = await buildGuardedApp();
    const res = await app.inject({ method: "GET", url: "/api/kakao-import", headers });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(notFoundBody("GET", "/api/kakao-import"));
    store.hasKakaoImport.mockResolvedValue(true);
    const retry = await app.inject({ method: "GET", url: "/api/kakao-import", headers });
    expect(retry.statusCode).toBe(200);
  });
});

describe("cohort mode", () => {
  beforeEach(() => {
    process.env.KAKAO_IMPORT_ENABLED = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = "someone-else";
  });

  it("an owner outside the cohort can still list and delete, but not upload", async () => {
    store.hasKakaoImport.mockResolvedValue(true);
    const { app, headers } = await buildGuardedApp();
    expect(
      (await app.inject({ method: "GET", url: "/api/kakao-import", headers })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/kakao-import/${IMPORT_ID}`, headers }))
        .statusCode,
    ).toBe(204);
    for (const [method, url] of DARK_ROUTES) {
      expect((await app.inject({ method, url, headers })).statusCode, `${method} ${url}`).toBe(404);
    }
    expect(store.createKakaoImport).not.toHaveBeenCalled();
  });

  it("a non-owner outside the cohort gets 404 everywhere", async () => {
    const { app, headers } = await buildGuardedApp();
    for (const [method, url] of [...WAY_OUT, ...DARK_ROUTES]) {
      expect((await app.inject({ method, url, headers })).statusCode, `${method} ${url}`).toBe(404);
    }
    expect(store.listKakaoImports).not.toHaveBeenCalled();
    expect(store.deleteKakaoImport).not.toHaveBeenCalled();
  });

  it("a cohort user is let in without an ownership lookup", async () => {
    process.env.ROLLOUT_COHORT_USER_IDS = "user-1";
    const { app, headers } = await buildGuardedApp();
    expect(
      (await app.inject({ method: "GET", url: "/api/kakao-import", headers })).statusCode,
    ).toBe(200);
    expect(store.hasKakaoImport).not.toHaveBeenCalled();
  });
});
