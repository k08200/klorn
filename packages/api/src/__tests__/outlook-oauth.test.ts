/**
 * Unit tests for the Microsoft OAuth helper (Phase 3). No live Microsoft
 * endpoint — fetch is mocked; these pin the auth-URL parameters, the token
 * exchange result mapping (including the no-verbatim-error-body rule), and
 * the /me email fallback for personal accounts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = ["MS_CLIENT_ID", "MS_CLIENT_SECRET", "MS_REDIRECT_URI", "MS_TENANT"] as const;
const saved: Record<string, string | undefined> = {};

const fetchMock = vi.fn();

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.MS_CLIENT_ID = "client-123";
  process.env.MS_CLIENT_SECRET = "secret-456";
  process.env.MS_REDIRECT_URI = "https://api.example.com/api/auth/outlook/callback";
  delete process.env.MS_TENANT;
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

const mod = await import("../mail/outlook-oauth.js");

describe("getOutlookAuthUrl", () => {
  it("builds the v2.0 authorize URL with the delegated mail scopes", () => {
    const url = new URL(mod.getOutlookAuthUrl("signed-state"));
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://api.example.com/api/auth/outlook/callback",
    );
    expect(url.searchParams.get("state")).toBe("signed-state");
    const scope = url.searchParams.get("scope") ?? "";
    expect(scope).toContain("offline_access");
    expect(scope).toContain("https://graph.microsoft.com/Mail.Read");
    expect(scope).toContain("https://graph.microsoft.com/Mail.ReadWrite");
    expect(scope).toContain("https://graph.microsoft.com/Mail.Send");
    // Never the elevated scope — Klorn doesn't edit delivered mail.
    expect(scope).not.toContain("Mail-Advanced");
  });

  it("respects MS_TENANT", () => {
    process.env.MS_TENANT = "my-tenant-id";
    const url = new URL(mod.getOutlookAuthUrl("s"));
    expect(url.pathname.startsWith("/my-tenant-id/")).toBe(true);
  });

  it("never embeds the client secret in the redirect URL", () => {
    expect(mod.getOutlookAuthUrl("s")).not.toContain("secret-456");
  });
});

describe("exchangeOutlookCode", () => {
  it("maps a successful token response, computing expiresAt from expires_in", async () => {
    const before = Date.now();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "at", refresh_token: "rt", expires_in: 3600 }),
    });
    const result = await mod.exchangeOutlookCode("auth-code");
    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("unreachable");
    expect(result.accessToken).toBe("at");
    expect(result.refreshToken).toBe("rt");
    expect(result.expiresAt?.getTime()).toBeGreaterThanOrEqual(before + 3600_000);
    // The exchange POSTs the secret to the token endpoint (server-to-server).
    const [tokenUrl, init] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    expect(String(init.body)).toContain("grant_type=authorization_code");
  });

  it("returns only MS's short error code on failure — never the body verbatim", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: "invalid_grant",
        error_description: "AADSTS70008: long attacker-visible description",
      }),
    });
    const result = await mod.exchangeOutlookCode("bad-code");
    expect(result).toEqual({ error: "invalid_grant" });
  });

  it("handles a missing refresh_token (no offline_access grant) as null", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "at", expires_in: 3600 }),
    });
    const result = await mod.exchangeOutlookCode("code");
    if ("error" in result) throw new Error("unreachable");
    expect(result.refreshToken).toBeNull();
  });
});

describe("refreshOutlookTokens", () => {
  it("posts the refresh grant and maps the rotated tokens", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "at2", refresh_token: "rt2", expires_in: 3600 }),
    });
    const result = await mod.refreshOutlookTokens("rt1");
    if ("error" in result) throw new Error("unreachable");
    expect(result.accessToken).toBe("at2");
    expect(result.refreshToken).toBe("rt2");
    const [, init] = fetchMock.mock.calls[0];
    expect(String(init.body)).toContain("grant_type=refresh_token");
    expect(String(init.body)).toContain("refresh_token=rt1");
  });

  it("returns only the short error code on a rejected grant", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_grant", error_description: "AADSTS long text" }),
    });
    expect(await mod.refreshOutlookTokens("dead")).toEqual({ error: "invalid_grant" });
  });
});

describe("fetchOutlookAccountEmail", () => {
  it("never follows a redirect: the bearer token goes only where it was sent", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ mail: "me@contoso.com" }), { status: 200 }),
    );

    await mod.fetchOutlookAccountEmail("at");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.redirect).toBe("error");
  });

  it("prefers mail, falls back to userPrincipalName (personal accounts)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ mail: null, userPrincipalName: "me@outlook.com" }),
    });
    expect(await mod.fetchOutlookAccountEmail("at")).toBe("me@outlook.com");
  });

  it("returns null on a Graph error or a non-address UPN", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
    expect(await mod.fetchOutlookAccountEmail("at")).toBeNull();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ mail: null, userPrincipalName: "no-at-sign" }),
    });
    expect(await mod.fetchOutlookAccountEmail("at")).toBeNull();
  });
});

describe("outlookConfigured", () => {
  it("requires both client id and secret", () => {
    expect(mod.outlookConfigured()).toBe(true);
    delete process.env.MS_CLIENT_SECRET;
    expect(mod.outlookConfigured()).toBe(false);
  });
});
