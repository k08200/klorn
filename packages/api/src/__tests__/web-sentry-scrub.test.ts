/**
 * The browser Sentry scrub functions (packages/web/src/lib/sentry-scrub.ts) on
 * their own: what is redacted, what is kept, and that every pass is bounded.
 * web-sentry-browser-wiring.test.ts proves the SDK runs them.
 */

import { describe, expect, it } from "vitest";
import {
  REDACTED_ADDRESS,
  REDACTED_SECRET,
  scrubBreadcrumb,
  scrubDeep,
  scrubEvent,
  scrubText,
  stripUrlQuery,
} from "../../../web/src/lib/sentry-scrub";

describe("stripUrlQuery", () => {
  it.each([
    ["https://app.klorn.ai/email?id=1#x", "https://app.klorn.ai/email"],
    ["/api/email/search?q=a", "/api/email/search"],
    ["https://app.klorn.ai/today#frag", "https://app.klorn.ai/today"],
    ["https://app.klorn.ai/today", "https://app.klorn.ai/today"],
  ])("%s -> %s", (input, output) => {
    expect(stripUrlQuery(input)).toBe(output);
  });
});

describe("scrubText", () => {
  it("redacts plain and percent-encoded addresses, keeps the words around them", () => {
    expect(scrubText("Could not send to a.b+c@example.com now")).toBe(
      `Could not send to ${REDACTED_ADDRESS} now`,
    );
    expect(scrubText("q=a.b%40example.com")).toBe(REDACTED_ADDRESS);
  });

  it("keeps an @ that is not an address", () => {
    expect(scrubText("@mention and user@localhost")).toBe("@mention and user@localhost");
  });

  it("redacts bearer tokens and JWTs, cuts URL queries", () => {
    expect(scrubText("Authorization: Bearer abc.def")).toBe(
      `Authorization: Bearer ${REDACTED_SECRET}`,
    );
    expect(scrubText("token eyJa.eyJb.sig")).toBe(`token ${REDACTED_SECRET}`);
    expect(scrubText("GET https://api.klorn.ai/x?code=123 failed")).toBe(
      "GET https://api.klorn.ai/x failed",
    );
  });

  it("cuts long text before scanning it", () => {
    const scrubbed = scrubText(`${"a".repeat(100_000)}@example.com`);
    expect(scrubbed.length).toBeLessThan(2_100);
    expect(scrubbed).not.toContain("example.com");
  });
});

describe("scrubDeep", () => {
  it("scrubs nested strings and leaves other values alone", () => {
    expect(scrubDeep({ to: ["x@y.io"], n: 3, ok: true, none: null })).toEqual({
      to: [REDACTED_ADDRESS],
      n: 3,
      ok: true,
      none: null,
    });
  });

  it("stops at its depth and node budget instead of walking everything", () => {
    let deep: Record<string, unknown> = { leaf: "x@y.io" };
    for (let i = 0; i < 20; i += 1) deep = { child: deep };
    expect(JSON.stringify(scrubDeep(deep))).not.toContain("x@y.io");

    const wide = Array.from({ length: 50_000 }, () => "x@y.io");
    const walked = scrubDeep(wide) as string[];
    expect(walked.length).toBeLessThanOrEqual(2_001);
    expect(walked.every((value) => value === REDACTED_ADDRESS || value === "[truncated]")).toBe(
      true,
    );

    const keyed = Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`k${i}`, "x@y.io"]));
    expect(Object.keys(scrubDeep(keyed) as object).length).toBeLessThanOrEqual(2_001);
  });
});

describe("scrubBreadcrumb", () => {
  it("keeps a fetch breadcrumb with its URL cut to the path", () => {
    expect(
      scrubBreadcrumb({
        category: "fetch",
        type: "http",
        data: { method: "GET", url: "https://api.klorn.ai/api/email?q=secret", status_code: 200 },
      }),
    ).toEqual({
      category: "fetch",
      type: "http",
      data: { method: "GET", url: "https://api.klorn.ai/api/email", status_code: 200 },
    });
  });

  it("cuts both ends of a navigation", () => {
    expect(
      scrubBreadcrumb({ category: "navigation", data: { from: "/a?x=1", to: "/b#y" } })?.data,
    ).toEqual({ from: "/a", to: "/b" });
  });

  it.each([
    "console",
    "ui.click",
    "ui.input",
    "sentry.event",
    undefined,
  ])("drops %s", (category) => {
    expect(scrubBreadcrumb({ category, message: "Dear Bob" })).toBeNull();
  });
});

describe("scrubEvent", () => {
  it("drops the user, request headers, cookies and query; scrubs the rest", () => {
    const event = scrubEvent({
      type: undefined,
      message: "for a@b.co",
      user: { ip_address: "203.0.113.9", email: "a@b.co" },
      request: {
        url: "https://app.klorn.ai/email?id=9",
        headers: { Referer: "https://x/?code=1" },
        cookies: { s: "1" },
        query_string: "id=9",
      },
      breadcrumbs: [
        { category: "console", message: "text" },
        { category: "xhr", data: { url: "/a?b" } },
      ],
      extra: { scope: "inbox.load" },
    });

    expect(event).toEqual({
      type: undefined,
      message: `for ${REDACTED_ADDRESS}`,
      request: { url: "https://app.klorn.ai/email" },
      breadcrumbs: [{ category: "xhr", data: { url: "/a" } }],
      extra: { scope: "inbox.load" },
    });
  });
});
