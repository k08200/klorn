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

  it.each([
    "mailto:a.b@example.com?subject=hi",
    "'a.b@example.com'",
    "o'brien@example.com",
    "a.b%2540example.com",
    "a.b&#64;example.com",
    "a.b&#x40;example.com",
    "a.b&commat;example.com",
    "a.b＠example.com",
    "bob@gmail.com.",
  ])("redacts the address in %s", (text) => {
    expect(scrubText(text)).toBe(REDACTED_ADDRESS);
  });

  it("redacts only the address part of a bracketed address or a URL path", () => {
    expect(scrubText("To: Bob <a.b@example.com>")).toBe(`To: Bob <${REDACTED_ADDRESS}>`);
    expect(scrubText("/email/thread/bob@example.com")).toBe(`/email/thread/${REDACTED_ADDRESS}`);
    expect(scrubText("https://user:pw@app.klorn.ai/x")).toBe(`https://${REDACTED_ADDRESS}/x`);
  });

  it.each([
    "@mention and user@localhost",
    "/./node_modules/@tanstack/react-query/build/modern/useQuery.js",
    "https://cdn.jsdelivr.net/npm/@sentry/browser@8/bundle.js",
    "klorn-web@1.2.3",
    "Token refresh failed",
    "The token is invalid",
    "Basic validation failed",
    "error code: ECONNREFUSED",
  ])("keeps %s", (text) => {
    expect(scrubText(text)).toBe(text);
  });

  it("redacts bearer tokens, JWTs, key=value secrets and provider keys", () => {
    expect(scrubText("Authorization: Bearer abc123def456")).toBe(
      `Authorization: Bearer ${REDACTED_SECRET}`,
    );
    expect(scrubText("token eyJa.eyJb.sig")).toBe(`token ${REDACTED_SECRET}`);
    expect(scrubText("#id_token=eyJhbGci.eyJzdWIi.c2ln&x=1")).not.toContain("eyJ");
    expect(scrubText("access_token=opaque-value-123 end")).toBe(
      `access_token=${REDACTED_SECRET} end`,
    );
    expect(scrubText("form code=4/0AbOauthCode done")).toBe(`form code=${REDACTED_SECRET} done`);
    expect(scrubText("key sk-ant-api03-abcdefghij and AIzaSyQQQQQQQQQQQQQQQQQQQQQQQ")).toBe(
      `key ${REDACTED_SECRET} and ${REDACTED_SECRET}`,
    );
  });

  it.each([
    ["GET https://api.klorn.ai/x?code=123 failed", "GET https://api.klorn.ai/x failed"],
    ["Route GET:/api/email/search?q=secret not found", "Route GET:/api/email/search not found"],
    ["https://api.klorn.ai/x?ids=1,2,3&q=bob,smith", "https://api.klorn.ai/x"],
    ["/api/search?filter[subject]=merger", "/api/search"],
    ["/api/search?fields=(a)&q=quarterly", "/api/search"],
    ["api.klorn.ai/api/email?q=secret", "api.klorn.ai/api/email"],
    ["/email?q='x'&code=secret", "/email"],
    ["What? Nothing to cut.", "What? Nothing to cut."],
  ])("cuts the URL query in %s", (input, output) => {
    expect(scrubText(input)).toBe(output);
  });

  it("scrubs before cutting, so an address across the cut leaves no fragment", () => {
    const filler = "word ".repeat(399);
    const scrubbed = scrubText(`${filler}jane.doe@example.com and more text`);
    expect(scrubbed).not.toContain("jane");
    expect(scrubbed.length).toBeLessThanOrEqual(2_001);
  });

  it("bounds what it scans: one huge token is dropped, long text is cut at a space", () => {
    expect(scrubText(`${"a".repeat(100_000)}@example.com`)).not.toContain("example.com");
    expect(scrubText(`${"word ".repeat(10_000)}bob@example.com`)).not.toContain("bob@");
  });

  it("stays fast on adversarial input", () => {
    const started = performance.now();
    scrubText("/".repeat(19_000));
    scrubText(`x@${"a.".repeat(9_000)}1`);
    scrubText("%25".repeat(6_000));
    scrubText(`${"a@".repeat(9_000)}`);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("scrubDeep", () => {
  it("scrubs keys too, and keeps an own __proto__ key as a key", () => {
    expect(scrubDeep({ "bob@example.com": 1 })).toEqual({ [REDACTED_ADDRESS]: 1 });
    const parsed = JSON.parse('{"__proto__": "x@y.io"}') as object;
    expect(Object.getOwnPropertyDescriptor(scrubDeep(parsed), "__proto__")?.value).toBe(
      REDACTED_ADDRESS,
    );
  });

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
  it("strips credentials and addresses from the request URL, keeps the SDK's own fields", () => {
    const event = scrubEvent({
      type: undefined,
      release: "klorn-web@1.2.3",
      request: { url: "https://user:pw@app.klorn.ai/email/thread/bob@example.com?x=1" },
    });
    expect(event.request).toEqual({ url: `https://app.klorn.ai/email/thread/${REDACTED_ADDRESS}` });
    expect(event.release).toBe("klorn-web@1.2.3");
  });

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
