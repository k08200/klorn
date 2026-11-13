// The static export (docs/deploy/cloudflare-pages.md) prerenders ONE shell per
// dynamic route and Cloudflare rewrites every id to it, so the router's param
// on that shell is the placeholder, not the id in the address bar. These pin
// how the page recovers the real id from the URL without opening a path
// traversal into the API calls it is interpolated into. Run from the api suite
// because the web package has no unit-test runner (see web-auth-surfaces.test.ts).
import { describe, expect, it } from "vitest";
import { settingsIndexTarget } from "../../../web/src/app/settings/sections";
import {
  resolveRouteParam,
  STATIC_SHELL_PARAM,
  segmentAfter,
} from "../../../web/src/lib/route-param";

describe("segmentAfter", () => {
  it("reads the one segment after the prefix", () => {
    expect(segmentAfter("/email/0b6f9c1e-5d0e-4a51-9a39-2f0f7e8f1c11", "/email/")).toBe(
      "0b6f9c1e-5d0e-4a51-9a39-2f0f7e8f1c11",
    );
    expect(segmentAfter("/email/candidates/abc", "/email/candidates/")).toBe("abc");
    expect(segmentAfter("/calendar/evt_1", "/calendar/")).toBe("evt_1");
  });

  it("keeps percent-encoding, as the router's own params do", () => {
    // Decoding would turn %2F into a real slash inside `/api/email/${id}`.
    expect(segmentAfter("/email/abc%2F..%2Fsettings", "/email/")).toBe("abc%2F..%2Fsettings");
  });

  it("rejects anything that is not exactly one segment under the prefix", () => {
    expect(segmentAfter("/email/", "/email/")).toBeNull();
    expect(segmentAfter("/email/a/b", "/email/")).toBeNull();
    expect(segmentAfter("/emailx/a", "/email/")).toBeNull();
    expect(segmentAfter("/inbox", "/email/")).toBeNull();
    expect(segmentAfter(null, "/email/")).toBeNull();
    expect(segmentAfter(undefined, "/email/")).toBeNull();
  });

  it("rejects dot segments and characters a URL path cannot carry", () => {
    for (const segment of [".", "..", "%2e", "%2E%2e", ".%2e"]) {
      expect(segmentAfter(`/email/${segment}`, "/email/")).toBeNull();
    }
    for (const segment of ["a b", "a\\b", "a?b", "a#b", "a\tb"]) {
      expect(segmentAfter(`/email/${segment}`, "/email/")).toBeNull();
    }
  });
});

describe("resolveRouteParam", () => {
  it("uses the router's param whenever it is a real id (the Next server build)", () => {
    expect(resolveRouteParam("abc", "/email/abc", "/email/", false)).toBe("abc");
    expect(resolveRouteParam("abc", "/email/zzz", "/email/", true)).toBe("abc");
  });

  it("reads the URL instead when the router holds the static shell's placeholder", () => {
    expect(resolveRouteParam(STATIC_SHELL_PARAM, "/email/abc", "/email/", true)).toBe("abc");
  });

  it("stays unknown until hydrated, so the prerendered shell and first client render agree", () => {
    expect(resolveRouteParam(STATIC_SHELL_PARAM, "/email/abc", "/email/", false)).toBeUndefined();
  });

  it("is unknown when the router has nothing and the URL has no valid segment", () => {
    expect(resolveRouteParam(undefined, "/email/a/b", "/email/", true)).toBeUndefined();
    expect(resolveRouteParam(STATIC_SHELL_PARAM, "/email/..", "/email/", true)).toBeUndefined();
    expect(resolveRouteParam(["a", "b"], "/email/abc", "/email/", true)).toBe("abc");
  });
});

describe("settingsIndexTarget", () => {
  it("forwards /settings to the first section with the query and fragment intact", () => {
    expect(settingsIndexTarget("", "")).toBe("/settings/accounts");
    expect(settingsIndexTarget("?google=ok&inbox=2", "")).toBe(
      "/settings/accounts?google=ok&inbox=2",
    );
    expect(settingsIndexTarget("?google=ok", "#notifications")).toBe(
      "/settings/accounts?google=ok#notifications",
    );
  });

  it("never lets the query or fragment change the origin", () => {
    // location.search always starts with "?" and location.hash with "#"; a value
    // that does not is dropped rather than glued onto the path.
    expect(settingsIndexTarget("//evil.example", "")).toBe("/settings/accounts");
    expect(settingsIndexTarget("", "evil")).toBe("/settings/accounts");
    expect(settingsIndexTarget("?next=//evil.example", "")).toBe(
      "/settings/accounts?next=//evil.example",
    );
  });
});
