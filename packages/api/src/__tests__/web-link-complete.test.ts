// Pins packages/web/src/lib/link-complete.ts, the pure half of the
// /link/complete page. The web package has no unit-test runner (Playwright e2e
// only), so its import-free helper is exercised from here.
import { describe, expect, it } from "vitest";
import {
  linkCompleteOutcome,
  readLinkHandle,
  safeNextPath,
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
    expect(linkCompleteOutcome(409, { next: "/settings?inbox=mismatch" })).toEqual({
      kind: "mismatch",
      path: "/settings?inbox=mismatch",
    });
    expect(linkCompleteOutcome(409, { next: "https://evil.example" })).toEqual({
      kind: "mismatch",
      path: null,
    });
  });

  it.each([
    [404, "expired"],
    [401, "signIn"],
    [500, "failed"],
    [503, "failed"],
    [400, "failed"],
  ] as const)("a %d is %s", (status, kind) => {
    expect(linkCompleteOutcome(status, { error: "x" })).toEqual({ kind });
  });

  it("a 200 without a body is a failure, not a redirect", () => {
    expect(linkCompleteOutcome(200, null)).toEqual({ kind: "failed" });
  });
});
