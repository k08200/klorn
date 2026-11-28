/**
 * Browser Sentry wiring: the REAL @sentry/browser with the web app's options
 * (packages/web/src/lib/sentry-options.ts `buildSentryBrowserOptions`), every envelope
 * it would put on the wire captured by a fake transport.
 *
 * Browser Sentry only runs when NEXT_PUBLIC_SENTRY_DSN is set at build time. The
 * day it is, nothing that names the user or their mail may leave the browser:
 * no email address, no URL query or fragment (OAuth codes, search terms,
 * message ids), no auth header or bearer token, no cookie, no console text,
 * and no IP inference. @sentry/browser 11 turned on IP inference and raw header
 * collection by default (`dataCollection`), so this runs the SDK itself rather
 * than the scrub functions alone, and asserts that an event WAS sent, so an
 * envelope that never left cannot pass as a clean one. Mirrors the server's
 * sentry-wiring.test.ts.
 *
 * The SDK is a web dependency, so it is imported from the web package.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const MAIL_ADDRESS = "wiring.person+tag@example.com";
const OTHER_ADDRESS = "bob.recipient@example.org";
const OAUTH_CODE = "4/0AbOauthCodeThatMustNotLeak";
const SEARCH_TERM = "quarterly-numbers-search";
const MESSAGE_ID = "msg-7f3c9a";
const BEARER = "opaque-bearer-token-51ab";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LTEifQ.c2lnbmF0dXJl";
const COOKIE = "opaque-session-cookie-77d2";
const MAIL_TEXT = "Dear Bob, the merger closes on Friday";
const SECRETS = [
  MAIL_ADDRESS,
  encodeURIComponent(MAIL_ADDRESS),
  OTHER_ADDRESS,
  OAUTH_CODE,
  encodeURIComponent(OAUTH_CODE),
  SEARCH_TERM,
  MESSAGE_ID,
  BEARER,
  JWT,
  COOKIE,
  MAIL_TEXT,
];

const EMAIL_ROW_ID = "cm9wiringrow01";
const PAGE_URL = `https://app.klorn.ai/email/${EMAIL_ROW_ID}?thread=${MESSAGE_ID}&q=${encodeURIComponent(MAIL_ADDRESS)}#${SEARCH_TERM}`;
const REFERRER = `https://accounts.google.com/o/oauth2/auth?code=${encodeURIComponent(OAUTH_CODE)}`;
const API_URL = `https://api.klorn.ai/api/email/search?q=${SEARCH_TERM}&token=${BEARER}`;
const TEST_DSN = "https://public@o0.ingest.sentry.io/0";
const FLUSH_MS = 2_000;

const wire: string[] = [];
type BrowserSdk = typeof import("../../../web/node_modules/@sentry/browser");
let Sentry: BrowserSdk;

function sent(): string {
  return wire.join("\n");
}

function expectNothingIdentifying(payload: string): void {
  for (const secret of SECRETS) {
    expect(payload).not.toContain(secret);
  }
}

beforeAll(async () => {
  vi.stubGlobal("location", new URL(PAGE_URL));
  vi.stubGlobal("document", {
    location: new URL(PAGE_URL),
    referrer: REFERRER,
    cookie: `klorn_session=${COOKIE}`,
    visibilityState: "visible",
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("removeEventListener", () => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 })),
  );
  Sentry = await import("../../../web/node_modules/@sentry/browser");
  const { buildSentryBrowserOptions } = await import("../../../web/src/lib/sentry-options");
  const decoder = new TextDecoder();
  Sentry.init({
    ...buildSentryBrowserOptions(TEST_DSN, "production"),
    transport: (options) =>
      Sentry.createTransport(options, async (request) => {
        wire.push(typeof request.body === "string" ? request.body : decoder.decode(request.body));
        return { statusCode: 200 };
      }),
  });
});

beforeEach(async () => {
  await Sentry.flush(FLUSH_MS);
  wire.length = 0;
  Sentry.getIsolationScope().clearBreadcrumbs();
  Sentry.getCurrentScope().clearBreadcrumbs();
});

afterAll(async () => {
  await Sentry.close(FLUSH_MS);
  vi.unstubAllGlobals();
});

/** Capture as captureClientError does: scope extras, then the exception. */
async function captureLikeTheApp(error: Error, context: Record<string, unknown>): Promise<string> {
  Sentry.withScope((scope) => {
    for (const [key, value] of Object.entries(context)) scope.setExtra(key, value);
    Sentry.captureException(error);
  });
  await Sentry.flush(FLUSH_MS);
  return sent();
}

describe("browser Sentry on the wire", () => {
  it("sends the error, with the page path but no query, fragment, referrer code or cookie", async () => {
    const payload = await captureLikeTheApp(new Error("inbox load failed"), {
      scope: "inbox.load",
    });

    expect(payload).toContain("inbox load failed");
    expect(payload).toContain("inbox.load");
    // The path's opaque row id is kept on purpose (sentry-scrub.ts header).
    expect(payload).toContain(`https://app.klorn.ai/email/${EMAIL_ROW_ID}"`);
    expectNothingIdentifying(payload);
  });

  it("redacts addresses, bearer tokens and URL queries in the error and its context", async () => {
    const payload = await captureLikeTheApp(
      new Error(
        `Could not send to ${MAIL_ADDRESS}: GET ${API_URL} (Authorization: Bearer ${BEARER})`,
      ),
      { scope: "compose.send", to: OTHER_ADDRESS, token: JWT, nested: { cc: [MAIL_ADDRESS] } },
    );

    expect(payload).toContain("Could not send to");
    expect(payload).toContain("compose.send");
    expectNothingIdentifying(payload);
  });

  it("keeps request breadcrumbs as paths, and drops console text", async () => {
    await fetch(API_URL, { headers: { Authorization: `Bearer ${BEARER}` } });
    // biome-ignore lint/suspicious/noConsole: the console breadcrumb under test
    console.log(`${MAIL_TEXT} — from ${MAIL_ADDRESS}`);

    const payload = await captureLikeTheApp(new Error("after a request"), { scope: "crumbs" });

    expect(payload).toContain("after a request");
    expect(payload).toContain("https://api.klorn.ai/api/email/search");
    expectNothingIdentifying(payload);
  });

  it("redacts the query of an API error body (a dark route's 404 quotes the raw URL)", async () => {
    const body = JSON.stringify({
      message: `Route GET:/api/email/search?q=${SEARCH_TERM},${MESSAGE_ID} not found`,
      error: "Not Found",
      statusCode: 404,
    });
    const payload = await captureLikeTheApp(new Error(`API 404: ${body}`), { scope: "search" });

    expect(payload).toContain("Route GET:/api/email/search");
    expectNothingIdentifying(payload);
  });

  it("does not let Sentry infer the user's IP, and sends no timezone", async () => {
    const payload = await captureLikeTheApp(new Error("ip probe"), { scope: "ip" });

    expect(payload).toContain("ip probe");
    expect(payload).toContain('"infer_ip":"never"');
    expect(payload).not.toContain("ip_address");
    expect(payload).not.toContain('"culture"');
    expect(payload).not.toContain("timezone");
  });
});
