// Pins packages/web/src/lib/link-complete.ts, the pure half of the
// /link/complete page. The web package has no unit-test runner (Playwright e2e
// only), so its import-free helper is exercised from here.
import { describe, expect, it } from "vitest";
import {
  browserSessionStorage,
  clearPendingHandle,
  hasPendingHandle,
  LINK_COMPLETE_SIGN_IN_HREF,
  linkCompleteOutcome,
  PENDING_LINK_MAX_AGE_MS,
  PENDING_LINK_STORAGE_KEY,
  readLinkHandle,
  safeNextPath,
  storePendingHandle,
  takePendingHandle,
} from "../../../web/src/lib/link-complete";

const HANDLE = "0123456789abcdef".repeat(4);

describe("readLinkHandle", () => {
  it("reads a 64-hex handle from the fragment", () => {
    expect(readLinkHandle(`#h=${HANDLE}`)).toBe(HANDLE);
  });

  it.each([
    ["an empty fragment", ""],
    ["no h", "#x=1"],
    ["a short handle", "#h=abc"],
    ["upper-case hex", `#h=${HANDLE.toUpperCase()}`],
    ["a trailing extra", `#h=${HANDLE}x`],
    ["a query instead of a fragment", `?h=${HANDLE}`],
  ])("returns null for %s", (_label, hash) => {
    expect(readLinkHandle(hash)).toBeNull();
  });
});

describe("safeNextPath", () => {
  it.each([
    "/settings?inbox=success",
    "/calendar?linked=mismatch",
    "/settings?google=connected",
  ])("allows the relative path %s", (path) => {
    expect(safeNextPath(path)).toBe(path);
  });

  it.each([
    ["an absolute URL", "https://evil.example/settings"],
    ["a protocol-relative URL", "//evil.example/settings"],
    ["a backslash the URL parser reads as a slash", "/\\evil.example"],
    ["a tab the URL parser strips", "/\t/evil.example"],
    ["a newline", "/settings\n//evil.example"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a bare word", "settings"],
    ["an empty string", ""],
    ["a non-string", 42],
    ["null", null],
  ])("refuses %s", (_label, next) => {
    expect(safeNextPath(next)).toBeNull();
  });
});

describe("linkCompleteOutcome", () => {
  it("a 200 with a safe next redirects there", () => {
    expect(linkCompleteOutcome(200, { next: "/settings?inbox=success" })).toEqual({
      kind: "redirect",
      path: "/settings?inbox=success",
    });
  });

  it("a 200 with an unsafe next never redirects", () => {
    expect(linkCompleteOutcome(200, { next: "//evil.example" })).toEqual({ kind: "failed" });
  });

  it("a 409 is a mismatch, offering only a safe next", () => {
    expect(linkCompleteOutcome(409, { next: "/settings" })).toEqual({
      kind: "mismatch",
      path: "/settings",
    });
    expect(linkCompleteOutcome(409, { next: "https://evil.example" })).toEqual({
      kind: "mismatch",
      path: null,
    });
  });

  it.each([
    [404, { error: "x", code: "LINK_EXPIRED" }, "expired"],
    [404, { error: "User not found" }, "failed"],
    [401, { error: "x" }, "signIn"],
    [500, { error: "x" }, "failed"],
    [503, { error: "x" }, "failed"],
    [400, { error: "x" }, "failed"],
  ] as const)("a %d with %o is %s", (status, body, kind) => {
    expect(linkCompleteOutcome(status, body)).toEqual({ kind });
  });

  it("a 200 without a body is a failure, not a redirect", () => {
    expect(linkCompleteOutcome(200, null)).toEqual({ kind: "failed" });
  });
});

/** A Storage stand-in; `broken` throws like a browser with storage disabled. */
function fakeStorage(broken = false) {
  const items = new Map<string, string>();
  const guard = () => {
    if (broken) throw new Error("SecurityError");
  };
  return {
    items,
    getItem: (k: string) => (guard(), items.get(k) ?? null),
    setItem: (k: string, v: string) => (guard(), void items.set(k, v)),
    removeItem: (k: string) => (guard(), void items.delete(k)),
  };
}

const NOW = Date.parse("2026-10-15T12:00:00Z");

describe("pending handle storage (sign in, then come back)", () => {
  it("stores a handle with its timestamp and reads it back exactly once", () => {
    const storage = fakeStorage();
    expect(storePendingHandle(storage, HANDLE, NOW)).toBe(true);
    expect(JSON.parse(storage.items.get(PENDING_LINK_STORAGE_KEY) as string)).toEqual({
      h: HANDLE,
      at: NOW,
    });

    expect(hasPendingHandle(storage, NOW + 1000)).toBe(true);
    expect(takePendingHandle(storage, NOW + 1000)).toBe(HANDLE);
    expect(takePendingHandle(storage, NOW + 1000)).toBeNull();
    expect(storage.items.size).toBe(0);
  });

  it("drops a handle older than five minutes, and clears it", () => {
    const storage = fakeStorage();
    storePendingHandle(storage, HANDLE, NOW);
    const later = NOW + PENDING_LINK_MAX_AGE_MS + 1;

    expect(PENDING_LINK_MAX_AGE_MS).toBe(5 * 60 * 1000);
    expect(hasPendingHandle(storage, later)).toBe(false);
    expect(takePendingHandle(storage, later)).toBeNull();
    expect(storage.items.size).toBe(0);
  });

  it("keeps a handle right up to five minutes", () => {
    const storage = fakeStorage();
    storePendingHandle(storage, HANDLE, NOW);
    expect(takePendingHandle(storage, NOW + PENDING_LINK_MAX_AGE_MS)).toBe(HANDLE);
  });

  it("clear removes it", () => {
    const storage = fakeStorage();
    storePendingHandle(storage, HANDLE, NOW);
    clearPendingHandle(storage);
    expect(hasPendingHandle(storage, NOW)).toBe(false);
    expect(storage.items.size).toBe(0);
  });

  it.each([
    ["a malformed handle", "not-a-handle"],
    ["an upper-case handle", HANDLE.toUpperCase()],
  ])("refuses to store %s", (_label, handle) => {
    const storage = fakeStorage();
    expect(storePendingHandle(storage, handle, NOW)).toBe(false);
    expect(storage.items.size).toBe(0);
  });

  it.each([
    ["junk", "{not json"],
    ["a wrong shape", JSON.stringify({ handle: HANDLE })],
    ["a bad handle", JSON.stringify({ h: "x", at: NOW })],
    ["a future timestamp", JSON.stringify({ h: HANDLE, at: NOW + 60_000 })],
  ])("treats %s as nothing stored, and clears it", (_label, raw) => {
    const storage = fakeStorage();
    storage.items.set(PENDING_LINK_STORAGE_KEY, raw);
    expect(hasPendingHandle(storage, NOW)).toBe(false);
    expect(takePendingHandle(storage, NOW)).toBeNull();
    expect(storage.items.size).toBe(0);
  });

  it("survives storage that throws or is missing", () => {
    expect(storePendingHandle(fakeStorage(true), HANDLE, NOW)).toBe(false);
    expect(takePendingHandle(fakeStorage(true), NOW)).toBeNull();
    expect(hasPendingHandle(fakeStorage(true), NOW)).toBe(false);
    expect(() => clearPendingHandle(fakeStorage(true))).not.toThrow();
    expect(takePendingHandle(null, NOW)).toBeNull();
    expect(storePendingHandle(null, HANDLE, NOW)).toBe(false);
  });

  it("has no browser storage outside a browser", () => {
    expect(browserSessionStorage()).toBeNull();
  });
});

describe("sign in to continue", () => {
  it("goes through the web sign-in and returns to /link/complete, never carrying the handle", () => {
    const url = new URL(LINK_COMPLETE_SIGN_IN_HREF, "https://app.example.com");
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("next")).toBe("/link/complete");
    expect([...url.searchParams.keys()]).toEqual(["next"]);
    expect(LINK_COMPLETE_SIGN_IN_HREF).not.toMatch(/[0-9a-f]{64}/);
  });
});
