/**
 * The web client's reaction to the API's session answers (packages/web
 * src/lib/api.ts apiFetch):
 *   - 401: the session ended — drop the token and go to sign-in;
 *   - 503 SESSION_CHECK_UNAVAILABLE (requireAuth could not reach the database):
 *     an error the caller may retry — the token stays and the page stays.
 * A 503 that signed the user out would turn every database blip into a logout.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const TOKEN_KEY = "klorn-token";

function browser(status: number, body: unknown) {
  const storage = new Map<string, string>([[TOKEN_KEY, "token-1"]]);
  const location = { pathname: "/today", search: "", href: "/today" };
  vi.stubGlobal("window", { location });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
  return { storage, location };
}

describe("apiFetch on session answers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("keeps the session on a 503 from the session check, and throws for the caller", async () => {
    const { storage, location } = browser(503, {
      error: "Couldn't verify your session right now. Please try again.",
      code: "SESSION_CHECK_UNAVAILABLE",
      retryable: true,
    });
    const { apiFetch } = await import("../../../web/src/lib/api");

    await expect(apiFetch("/api/notifications")).rejects.toThrow(/^API 503:/);
    expect(storage.get(TOKEN_KEY)).toBe("token-1");
    expect(location.href).toBe("/today");
  });

  it("signs out on a 401 (the control: the session really ended)", async () => {
    const { storage, location } = browser(401, {
      error: "Session expired. Please log in again.",
      code: "DEVICE_KICKED",
    });
    const { apiFetch } = await import("../../../web/src/lib/api");

    await expect(apiFetch("/api/notifications")).rejects.toThrow(/^API 401:/);
    expect(storage.has(TOKEN_KEY)).toBe(false);
    expect(location.href).toMatch(/^\/login\?error=session_expired/);
  });
});
