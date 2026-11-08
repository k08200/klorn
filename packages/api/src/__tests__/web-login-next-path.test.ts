// The sign-in page's `?next=`: after login/register the app navigates there,
// so anything a URL parser could read as another origin must fall back to the
// default. Run from the api suite because the web package has no unit-test
// runner (see web-auth-surfaces.test.ts).
import { describe, expect, it } from "vitest";
import {
  loginNextPath,
  registerRedirectTarget,
  safeHttpsUrl,
  safeRelativePath,
} from "../../../web/src/lib/safe-path";

describe("safeRelativePath", () => {
  it.each([
    ["backslash after the slash (read as //)", "/\\evil.com"],
    ["tab inside the slashes (stripped, rebuilding //)", "/\t/evil.com"],
    ["newline inside the slashes", "/\n/evil.com"],
    ["carriage return inside the slashes", "/\r/evil.com"],
    ["protocol-relative", "//evil.com"],
    ["absolute URL", "https://evil.com"],
    ["scheme without slashes", "javascript:alert(1)"],
    ["no leading slash", "evil.com"],
    ["empty", ""],
  ])("rejects %s", (_label, value) => {
    expect(safeRelativePath(value)).toBeNull();
  });

  it("rejects anything that is not a string", () => {
    expect(safeRelativePath(null)).toBeNull();
    expect(safeRelativePath(undefined)).toBeNull();
    expect(safeRelativePath(42)).toBeNull();
  });

  it("keeps same-origin paths with a query", () => {
    expect(safeRelativePath("/billing")).toBe("/billing");
    expect(safeRelativePath("/email/abc?x=1")).toBe("/email/abc?x=1");
    expect(safeRelativePath("/link/complete")).toBe("/link/complete");
  });
});

describe("loginNextPath", () => {
  it.each([
    "/\\evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "//evil.com",
    "https://evil.com",
  ])("sends %j to the default instead of off-origin", (value) => {
    expect(loginNextPath(value)).toBe("/inbox");
  });

  it("never returns to the sign-in page itself", () => {
    expect(loginNextPath("/login")).toBe("/inbox");
    expect(loginNextPath("/login?x")).toBe("/inbox");
  });

  it("defaults to /inbox without a next", () => {
    expect(loginNextPath(null)).toBe("/inbox");
    expect(loginNextPath("")).toBe("/inbox");
  });

  it("passes a same-origin path through", () => {
    expect(loginNextPath("/billing")).toBe("/billing");
    expect(loginNextPath("/email/abc?x=1")).toBe("/email/abc?x=1");
    expect(loginNextPath("/link/complete")).toBe("/link/complete");
  });
});

describe("safeRelativePath: paths that normalise to another origin", () => {
  it.each([
    ["a dot segment before //", "/.//evil.com"],
    ["a double-dot segment before //", "/..//evil.com"],
    ["encoded dot segments before //", "/%2e%2e//evil.com"],
    ["mixed-case encoded dots", "/%2E%2e//evil.com"],
    ["a dot-dot climbing back to //", "/a/..//evil.com"],
    ["// inside the path", "/a//evil.com"],
    ["a lone dot-dot segment", "/a/../b"],
    ["a trailing dot segment", "/a/."],
    ["an encoded single dot segment", "/%2e/b"],
  ])("rejects %s", (_label, value) => {
    expect(safeRelativePath(value)).toBeNull();
    expect(loginNextPath(value)).toBe("/inbox");
  });

  it("keeps names that only start with a dot", () => {
    expect(safeRelativePath("/.well-known/x")).toBe("/.well-known/x");
    expect(safeRelativePath("/files/a..b")).toBe("/files/a..b");
  });

  it("allows the query characters browsers leave unencoded in location.search", () => {
    expect(safeRelativePath("/email?q=[a]|{b}^c")).toBe("/email?q=[a]|{b}^c");
  });

  it("does not let those characters into the path", () => {
    expect(safeRelativePath("/a[b]")).toBeNull();
    expect(safeRelativePath("/a|b")).toBeNull();
  });

  it("allows // and dots inside the query, which never change the origin", () => {
    expect(safeRelativePath("/link?u=https://x.example/a/../b")).toBe(
      "/link?u=https://x.example/a/../b",
    );
  });
});

describe("safeHttpsUrl", () => {
  it("accepts an absolute https URL", () => {
    expect(safeHttpsUrl("https://accounts.google.com/o/oauth2/v2/auth?x=1")).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth?x=1",
    );
  });

  it.each([
    "http://accounts.google.com/",
    "javascript:alert(1)",
    "data:text/html,hi",
    "//evil.com",
    "/relative",
    "https://user:pw@evil.com/",
    " https://accounts.google.com/",
    "",
  ])("rejects %j", (value) => {
    expect(safeHttpsUrl(value)).toBeNull();
  });

  it("rejects anything that is not a string", () => {
    expect(safeHttpsUrl(null)).toBeNull();
    expect(safeHttpsUrl(undefined)).toBeNull();
  });
});

describe("registerRedirectTarget (/early-access)", () => {
  it("carries a strict same-origin next to the sign-up tab", () => {
    expect(registerRedirectTarget("/briefing")).toBe("/login?mode=register&next=%2Fbriefing");
  });

  it.each([
    null,
    "",
    "https://evil.example",
    "//evil.com",
    "/\\evil.com",
    "/.//evil.com",
  ])("drops %j", (value) => {
    expect(registerRedirectTarget(value)).toBe("/login?mode=register");
  });

  it("never loops back to /early-access", () => {
    expect(registerRedirectTarget("/early-access?x=1")).toBe("/login?mode=register");
  });
});
