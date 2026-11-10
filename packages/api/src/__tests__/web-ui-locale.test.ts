/**
 * The web client tells the API which language its screen is in: apiFetch
 * sends the Settings → Language choice as Accept-Language, so server-composed
 * reasons (firewall, reader-context, email detail) arrive in the UI language
 * rather than the stored notification language.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

function stubBrowser(profile?: unknown) {
  const storage = memoryStorage(
    profile === undefined
      ? {}
      : { "klorn-profile": typeof profile === "string" ? profile : JSON.stringify(profile) },
  );
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", { localStorage: storage, location: { pathname: "/", search: "" } });
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("activeUiLocale", () => {
  it("is the language picked in Settings", async () => {
    stubBrowser({ language: "ko" });
    const { activeUiLocale } = await import("../../../web/src/lib/ui-locale");
    expect(activeUiLocale()).toBe("ko");
  });

  it("is English with no profile, an unknown language, a malformed profile, or on the server", async () => {
    const { activeUiLocale } = await import("../../../web/src/lib/ui-locale");
    expect(activeUiLocale()).toBe("en"); // no window
    stubBrowser();
    expect(activeUiLocale()).toBe("en");
    stubBrowser({ language: "pt" });
    expect(activeUiLocale()).toBe("en");
    stubBrowser("{not json");
    expect(activeUiLocale()).toBe("en");
  });
});

describe("apiFetch", () => {
  it("sends the UI locale as Accept-Language", async () => {
    stubBrowser({ language: "ja" });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("../../../web/src/lib/api");
    await apiFetch("/api/inbox/firewall/");
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["Accept-Language"]).toBe("ja");
  });

  it("lets a caller override the header", async () => {
    stubBrowser({ language: "ja" });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("../../../web/src/lib/api");
    await apiFetch("/api/x", { headers: { "Accept-Language": "de" } });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["Accept-Language"]).toBe("de");
  });
});
