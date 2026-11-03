/**
 * verifyAnthropicKey — the save-time upstream check for a BYOK key
 * (src/billing/verify-provider-key.ts). A definitive 401/403 rejects the key;
 * anything else fails open ("unreachable") so provider noise never blocks a
 * save. The key travels only in the x-api-key header and is never logged.
 */

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { verifyAnthropicKey } from "../billing/verify-provider-key.js";

const KEY = "sk-ant-api03-verify-test-secret-0123456789";

const fetchMock = vi.fn<typeof fetch>();
const consoleSpies: MockInstance[] = [];

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    consoleSpies.push(vi.spyOn(console, method).mockImplementation(() => {}));
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const spy of consoleSpies.splice(0)) spy.mockRestore();
});

/** Every argument any console method received, flattened to text. */
function everythingLogged(): string {
  return consoleSpies
    .flatMap((spy) => spy.mock.calls.flat())
    .map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg)))
    .join("\n");
}

describe("verifyAnthropicKey — shape check before any network call", () => {
  // A string that cannot be an Anthropic key never leaves the server: fetch
  // throws locally on header-invalid characters, which used to read as
  // "unreachable" and store the junk unverified.
  it.each([
    ["no sk-ant- prefix", "sk-or-v1-0123456789abcdef0123456789"],
    ["too short", "sk-ant-abc"],
    ["non-Latin-1 character", "sk-ant-api03-0123456789✓abcdef"],
    ["embedded newline", "sk-ant-api03-0123456789\nabcdef"],
    ["inner whitespace", "sk-ant-api03 0123456789abcdef"],
  ])("%s → malformed, no fetch", async (_label, key) => {
    await expect(verifyAnthropicKey(key)).resolves.toBe("malformed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts the documented key shapes (api and personal keys)", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await expect(verifyAnthropicKey(KEY)).resolves.toBe("valid");
    await expect(verifyAnthropicKey("sk-ant-usr-0123456789_abcdef-XYZ")).resolves.toBe("valid");
  });
});

describe("verifyAnthropicKey", () => {
  it("calls GET /v1/models with x-api-key and anthropic-version, and no Authorization header", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    await verifyAnthropicKey(KEY);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.anthropic.com/v1/models");
    // GET (no method override): /v1/models runs no model, so a save spends no tokens.
    expect(init?.method ?? "GET").toBe("GET");
    expect(init?.body).toBeUndefined();
    const headers = new Headers(init?.headers);
    expect(headers.get("x-api-key")).toBe(KEY);
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.has("authorization")).toBe(false);
    // Bounded: a hung provider cannot hold the save open.
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps 200 to valid", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    expect(await verifyAnthropicKey(KEY)).toBe("valid");
  });

  it.each([401, 403])("maps %i to invalid (a definitive rejection)", async (status) => {
    fetchMock.mockResolvedValue(new Response("{}", { status }));
    expect(await verifyAnthropicKey(KEY)).toBe("invalid");
  });

  it.each([
    429, 500, 529,
  ])("maps %i to unreachable (fail open on provider noise)", async (status) => {
    fetchMock.mockResolvedValue(new Response("{}", { status }));
    expect(await verifyAnthropicKey(KEY)).toBe("unreachable");
  });

  it("maps a thrown fetch error (network, timeout) to unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError(`fetch failed for key ${KEY}`));
    expect(await verifyAnthropicKey(KEY)).toBe("unreachable");
  });

  it("never logs the key, whatever the outcome", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockRejectedValueOnce(new TypeError(`fetch failed for key ${KEY}`));

    for (let i = 0; i < 4; i++) await verifyAnthropicKey(KEY);

    expect(everythingLogged()).not.toContain(KEY);
    expect(everythingLogged()).not.toContain("verify-test-secret");
  });
});
