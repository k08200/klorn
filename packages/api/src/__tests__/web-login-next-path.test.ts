// The sign-in page's `?next=`: after login/register the app navigates there,
// so anything a URL parser could read as another origin must fall back to the
// default. Run from the api suite because the web package has no unit-test
// runner (see web-auth-surfaces.test.ts).
import { describe, expect, it } from "vitest";
import { loginNextPath, safeRelativePath } from "../../../web/src/lib/safe-path";

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
