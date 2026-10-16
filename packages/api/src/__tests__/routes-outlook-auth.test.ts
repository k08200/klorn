/**
 * Phase 3: the Outlook link surface is dark until OUTLOOK_INBOX_ENABLED.
 * While OFF, every /api/auth/outlook route — authenticated or not — answers
 * Fastify's default 404 byte-for-byte (CASA surface freeze; same contract
 * as the iCloud surface). With the flag on, the flow mirrors the Google
 * link-inbox route: signed-state CSRF, the code parked by the callback and
 * finished by the starting user's own session (POST /api/auth/link/complete),
 * TOCTOU entitlement re-check at completion, new-links-only cap, OUTLOOK-scoped
 * rows, encrypted tokens.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callbackThenComplete } from "./helpers/link-complete.js";
import { type LinkedRowFixture, linkedRowsFindFirst } from "./helpers/linked-rows-find-first.js";

const state = vi.hoisted(() => ({ plan: "PRO", role: "USER" }));
/** The LinkedInboxAccount rows this user owns (read by every findFirst). */
const rows = vi.hoisted(() => ({ list: [] as LinkedRowFixture[] }));
// The primary Google token: present = the user already has their first mailbox.
const tokenFindFirst = vi.hoisted(() => vi.fn(async (_args?: unknown) => null as unknown));

const db = vi.hoisted(() => ({
  findMany: vi.fn(async () => []),
  findFirst: vi.fn(async (_args?: unknown) => null as unknown),
  findUnique: vi.fn(async () => null),
  count: vi.fn(async () => 0),
  upsert: vi.fn(async (_args?: unknown) => ({ id: "row-1" })),
  deleteMany: vi.fn(async () => ({ count: 0 })),
}));

const oauth = vi.hoisted(() => ({
  exchangeOutlookCode: vi.fn(async () => ({
    accessToken: "graph-at",
    refreshToken: "graph-rt",
    expiresAt: new Date("2026-08-06T12:00:00Z"),
  })),
  fetchOutlookAccountEmail: vi.fn(async () => "Me@Outlook.com"),
  getOutlookAuthUrl: vi.fn((s: string) => `https://login.microsoftonline.com/authorize?state=${s}`),
  outlookConfigured: vi.fn(() => true),
}));

vi.mock("../db.js", () => {
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({ id: "user-1", plan: state.plan, role: state.role })),
      update: vi.fn(async () => ({ id: "user-1" })),
    },
    userToken: { findFirst: tokenFindFirst },
    linkedInboxAccount: db,
    device: {
      findUnique: vi.fn(async () => ({ id: "device-1" })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../crypto-tokens.js", () => ({
  encryptToken: vi.fn((t: string) => `enc:${t}`),
  encryptOptional: vi.fn((t: string | null | undefined) => (t ? `enc:${t}` : null)),
}));
vi.mock("../mail/outlook-oauth.js", () => oauth);

const ORIGINAL_FLAG = process.env.OUTLOOK_INBOX_ENABLED;
const ORIGINAL_WEB_URL = process.env.WEB_URL;

async function buildApp() {
  vi.resetModules();
  process.env.WEB_URL = "https://app.example.com";
  const { signToken } = await import("../auth.js");
  const { outlookAuthRoutes } = await import("../routes/outlook-auth.js");
  const { outlookInboxEnabled } = await import("../config.js");
  const { linkCompleteRoutes } = await import("../routes/link-complete.js");
  const app = Fastify();
  await app.register(outlookAuthRoutes({ gate: outlookInboxEnabled }), {
    prefix: "/api/auth/outlook",
  });
  await app.register(linkCompleteRoutes(), { prefix: "/api/auth" });
  await app.ready();
  const token = signToken({ userId: "user-1", email: "test@example.com" });
  const linkState = signToken({ userId: "user-1", email: "__link_outlook__" }, "10m");
  return { app, headers: { authorization: `Bearer ${token}` }, token, linkState };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.findMany.mockResolvedValue([]);
  db.findUnique.mockResolvedValue(null);
  db.count.mockResolvedValue(0);
  db.deleteMany.mockResolvedValue({ count: 0 });
  rows.list = [];
  db.findFirst.mockImplementation(linkedRowsFindFirst(() => rows.list));
  db.upsert.mockImplementation(async () => ({ id: "row-1" }));
  tokenFindFirst.mockResolvedValue(null);
  oauth.outlookConfigured.mockReturnValue(true);
  oauth.fetchOutlookAccountEmail.mockResolvedValue("Me@Outlook.com");
  state.plan = "PRO";
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.OUTLOOK_INBOX_ENABLED;
  else process.env.OUTLOOK_INBOX_ENABLED = ORIGINAL_FLAG;
  if (ORIGINAL_WEB_URL === undefined) delete process.env.WEB_URL;
  else process.env.WEB_URL = ORIGINAL_WEB_URL;
  vi.resetModules();
});

describe("flag OFF (default) — the surface does not exist", () => {
  it.each([
    ["POST", "/api/auth/outlook/link-inbox"],
    ["GET", "/api/auth/outlook/callback"],
    ["GET", "/api/auth/outlook/linked-inboxes"],
    ["DELETE", "/api/auth/outlook/linked-inboxes/some-id"],
  ] as const)("%s %s answers 404 even when authenticated", async (method, url) => {
    delete process.env.OUTLOOK_INBOX_ENABLED;
    const { app, headers } = await buildApp();
    const res = await app.inject({ method, url, headers });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("is byte-identical to Fastify's default 404 (no body-diff fingerprint)", async () => {
    delete process.env.OUTLOOK_INBOX_ENABLED;
    const { app } = await buildApp();
    const gated = await app.inject({ method: "GET", url: "/api/auth/outlook/linked-inboxes" });
    const unregistered = await app.inject({ method: "GET", url: "/api/auth/outlook/nope" });
    expect(gated.json()).toEqual({
      message: "Route GET:/api/auth/outlook/linked-inboxes not found",
      error: "Not Found",
      statusCode: 404,
    });
    expect(unregistered.json()).toEqual({
      message: "Route GET:/api/auth/outlook/nope not found",
      error: "Not Found",
      statusCode: 404,
    });
    await app.close();
  });
});

describe("flag ON — link start", () => {
  beforeEach(() => {
    process.env.OUTLOOK_INBOX_ENABLED = "true";
  });

  it("returns the MS authorize URL with a signed state", async () => {
    const { app, headers } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/outlook/link-inbox",
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toContain("login.microsoftonline.com");
    expect(oauth.getOutlookAuthUrl).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("503s loudly when the Azure registration is not configured", async () => {
    oauth.outlookConfigured.mockReturnValue(false);
    const { app, headers } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/outlook/link-inbox",
      headers,
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("refuses a FREE user who already has a mailbox (a second one is Pro → 403)", async () => {
    state.plan = "FREE";
    tokenFindFirst.mockResolvedValue({ id: "google-token" });
    process.env.PAYWALL_ENABLED = "true";
    try {
      const { app, headers } = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/outlook/link-inbox",
        headers,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("ENTITLEMENT_REQUIRED");
      await app.close();
    } finally {
      delete process.env.PAYWALL_ENABLED;
    }
  });

  it("lets a FREE user with no mailbox start linking Outlook as their first", async () => {
    state.plan = "FREE";
    process.env.PAYWALL_ENABLED = "true";
    try {
      const { app, headers } = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/outlook/link-inbox",
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().url).toContain("login.microsoftonline.com");
      await app.close();
    } finally {
      delete process.env.PAYWALL_ENABLED;
    }
  });
});

describe("flag ON — callback → complete", () => {
  beforeEach(() => {
    process.env.OUTLOOK_INBOX_ENABLED = "true";
  });

  it("exchanges the code and upserts an OUTLOOK row with encrypted tokens", async () => {
    const { app, headers, linkState } = await buildApp();
    const res = await callbackThenComplete(
      app,
      `/api/auth/outlook/callback?code=auth-code&state=${encodeURIComponent(linkState)}`,
      headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().next).toBe("/settings?inbox=success");
    expect(db.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_provider_email: {
            userId: "user-1",
            provider: "OUTLOOK",
            // normalized from Me@Outlook.com
            email: "me@outlook.com",
          },
        },
        create: expect.objectContaining({
          provider: "OUTLOOK",
          accessToken: "enc:graph-at",
          refreshToken: "enc:graph-rt",
        }),
        update: expect.objectContaining({ needsReconnect: false }),
      }),
    );
    await app.close();
  });

  it("400s on a missing or unverifiable state", async () => {
    const { app } = await buildApp();
    const noState = await app.inject({
      method: "GET",
      url: "/api/auth/outlook/callback?code=auth-code",
    });
    expect(noState.statusCode).toBe(400);
    const badState = await app.inject({
      method: "GET",
      url: "/api/auth/outlook/callback?code=auth-code&state=garbage",
    });
    expect(badState.statusCode).toBe(400);
    await app.close();
  });

  it("rejects an ordinary session JWT replayed as state (marker mismatch)", async () => {
    const { app, token } = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/outlook/callback?code=auth-code&state=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(400);
    expect(db.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("maps a provider error to the fixed outlook_denied marker, never reflected", async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/outlook/callback?error=access_denied%3Cscript%3E",
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("https://app.example.com/settings?inbox=outlook_denied");
    await app.close();
  });

  it("redirects ?inbox=failed when the code exchange fails, without writing", async () => {
    oauth.exchangeOutlookCode.mockResolvedValueOnce({ error: "invalid_grant" } as never);
    const { app, headers, linkState } = await buildApp();
    const res = await callbackThenComplete(
      app,
      `/api/auth/outlook/callback?code=bad&state=${encodeURIComponent(linkState)}`,
      headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().next).toBe("/settings?inbox=failed");
    expect(db.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("redirects ?inbox=failed when Graph /me yields no address, without writing", async () => {
    oauth.fetchOutlookAccountEmail.mockResolvedValueOnce(null);
    const { app, headers, linkState } = await buildApp();
    const res = await callbackThenComplete(
      app,
      `/api/auth/outlook/callback?code=c&state=${encodeURIComponent(linkState)}`,
      headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().next).toBe("/settings?inbox=failed");
    expect(db.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    [
      "the code exchange",
      () => oauth.exchangeOutlookCode.mockRejectedValueOnce(new TypeError("fetch failed")),
    ],
    [
      "the /me lookup",
      () => oauth.fetchOutlookAccountEmail.mockRejectedValueOnce(new TypeError("fetch failed")),
    ],
  ])("a refused redirect or any network failure in %s lands on ?inbox=failed, not an unhandled error", async (_label, arrange) => {
    arrange();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, headers, linkState } = await buildApp();

    const res = await callbackThenComplete(
      app,
      `/api/auth/outlook/callback?code=c&state=${encodeURIComponent(linkState)}`,
      headers,
    );

    expect(res.statusCode).toBe(200);
    expect(res.json().next).toBe("/settings?inbox=failed");
    expect(db.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  const runCallback = async () => {
    const { app, headers, linkState } = await buildApp();
    const res = await callbackThenComplete(
      app,
      `/api/auth/outlook/callback?code=c&state=${encodeURIComponent(linkState)}`,
      headers,
    );
    await app.close();
    return res;
  };

  it("re-checks at callback time: a FREE user who has a mailbox by now cannot finish", async () => {
    state.plan = "FREE";
    tokenFindFirst.mockResolvedValue({ id: "google-token" });
    process.env.PAYWALL_ENABLED = "true";
    try {
      const res = await runCallback();
      expect(res.statusCode).toBe(200);
      expect(res.json().next).toBe("/settings?inbox=pro");
      expect(db.upsert).not.toHaveBeenCalled();
    } finally {
      delete process.env.PAYWALL_ENABLED;
    }
  });

  it("lets a FREE user with no mailbox link Outlook as their first (free)", async () => {
    state.plan = "FREE";
    process.env.PAYWALL_ENABLED = "true";
    try {
      const res = await runCallback();
      expect(res.json().next).toBe("/settings?inbox=success");
      expect(db.upsert).toHaveBeenCalledTimes(1);
      expect(db.deleteMany).not.toHaveBeenCalled();
    } finally {
      delete process.env.PAYWALL_ENABLED;
    }
  });

  it("re-links a legacy mixed-case row instead of adding a duplicate (keeps the stored case)", async () => {
    state.plan = "FREE";
    tokenFindFirst.mockResolvedValue({ id: "google-token" });
    rows.list = [{ id: "legacy", provider: "OUTLOOK", email: "ME@Outlook.com" }];
    process.env.PAYWALL_ENABLED = "true";
    try {
      const res = await runCallback();
      expect(res.json().next).toBe("/settings?inbox=success");
      expect(db.upsert.mock.calls[0]?.[0]).toMatchObject({
        where: {
          userId_provider_email: { userId: "user-1", provider: "OUTLOOK", email: "ME@Outlook.com" },
        },
      });
      expect(db.deleteMany).not.toHaveBeenCalled();
    } finally {
      delete process.env.PAYWALL_ENABLED;
    }
  });

  it("removes a NEW row when a parallel first connect committed meanwhile", async () => {
    state.plan = "FREE";
    db.upsert.mockImplementation(async () => {
      rows.list = [
        { id: "row-1", provider: "OUTLOOK", email: "me@outlook.com" },
        { id: "parallel-row", provider: "ICLOUD", email: "me@icloud.com" },
      ];
      return { id: "row-1" };
    });
    process.env.PAYWALL_ENABLED = "true";
    try {
      const res = await runCallback();
      expect(res.json().next).toBe("/settings?inbox=pro");
      expect(db.deleteMany).toHaveBeenCalledWith({ where: { id: "row-1", userId: "user-1" } });
    } finally {
      delete process.env.PAYWALL_ENABLED;
    }
  });

  it("caps NEW links at 10 but always allows a re-link", async () => {
    db.count.mockResolvedValue(10);
    const { app, headers, linkState } = await buildApp();
    // New address at the cap → limit redirect, no write.
    const blocked = await callbackThenComplete(
      app,
      `/api/auth/outlook/callback?code=c&state=${encodeURIComponent(linkState)}`,
      headers,
    );
    expect(blocked.json().next).toBe("/settings?inbox=limit");
    expect(db.upsert).not.toHaveBeenCalled();
    // Existing row → update path is allowed even at the cap.
    db.findUnique.mockResolvedValue({ id: "existing-row" } as never);
    const relink = await callbackThenComplete(
      app,
      `/api/auth/outlook/callback?code=c&state=${encodeURIComponent(linkState)}`,
      headers,
    );
    expect(relink.json().next).toBe("/settings?inbox=success");
    expect(db.upsert).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

describe("flag ON — list & unlink", () => {
  beforeEach(() => {
    process.env.OUTLOOK_INBOX_ENABLED = "true";
  });

  it("GET /linked-inboxes stays open to FREE and says whether a new mailbox may be connected", async () => {
    state.plan = "FREE";
    tokenFindFirst.mockResolvedValue({ id: "google-token" });
    process.env.PAYWALL_ENABLED = "true";
    try {
      const { app, headers } = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/outlook/linked-inboxes",
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().canConnect).toBe(false);
      await app.close();
    } finally {
      delete process.env.PAYWALL_ENABLED;
    }
  });

  it("GET /linked-inboxes reads only OUTLOOK rows and never tokens", async () => {
    const { app, headers } = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/outlook/linked-inboxes",
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(db.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", provider: "OUTLOOK" },
        select: expect.not.objectContaining({ accessToken: true }),
      }),
    );
    await app.close();
  });

  it("DELETE is OUTLOOK-scoped and 404s when nothing matched", async () => {
    const { app, headers } = await buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/auth/outlook/linked-inboxes/row-9",
      headers,
    });
    expect(res.statusCode).toBe(404);
    expect(db.deleteMany).toHaveBeenCalledWith({
      where: { id: "row-9", userId: "user-1", provider: "OUTLOOK" },
    });
    await app.close();
  });
});
