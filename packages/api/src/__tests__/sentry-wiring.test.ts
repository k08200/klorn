/**
 * Sentry wiring: the scrub hooks run inside the REAL SDK.
 *
 * sentry-scrub.test.ts proves the pure functions. It cannot prove the SDK
 * calls them, and @sentry/node 11 is where that silently broke. Its default
 * span streaming never runs `beforeSendTransaction`, and a `beforeSendSpan`
 * written for the static span shape is never invoked. The Dependabot bump
 * (#1697) kept every pure test green while two of the four hooks were dead.
 *
 * So these tests start a real `Sentry.init` with the production options,
 * capture the serialized envelopes it would put on the wire, and assert that
 * no secret appears anywhere in them. They also assert that something WAS
 * sent, so an envelope that never left cannot pass as a clean one.
 */
import * as Sentry from "@sentry/node";
import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildSentryInitOptions } from "../sentry.js";

const GEMINI_KEY = `AIzaSy${"Q".repeat(33)}`;
const OAUTH_CODE = "4/0AbOauthCodeThatMustNotLeak";
const VERIFIER = "opaque-desktop-verifier-9c1e";
const SESSION_COOKIE = "opaque-session-cookie-51ab";
const AUTH_EXTRA = "opaque-authorization-extra-77d2";
const SECRETS = [GEMINI_KEY, OAUTH_CODE, VERIFIER, SESSION_COOKIE, AUTH_EXTRA];

const FLUSH_MS = 5_000;
const wire: string[] = [];
const decoder = new TextDecoder();

function sent(): string {
  return wire.join("\n");
}

function expectNoSecret(payload: string): void {
  for (const secret of SECRETS) {
    expect(payload).not.toContain(secret);
  }
}

beforeAll(() => {
  Sentry.init({
    ...buildSentryInitOptions("https://public@o0.ingest.sentry.io/0", "test"),
    transport: (options) =>
      Sentry.createTransport(options, async (request) => {
        wire.push(typeof request.body === "string" ? request.body : decoder.decode(request.body));
        return { statusCode: 200 };
      }),
  });
});

beforeEach(() => {
  wire.length = 0;
});

afterAll(async () => {
  await Sentry.close(FLUSH_MS);
});

describe("Sentry init options", () => {
  it("pins the static trace lifecycle the transaction and span hooks are written for", () => {
    const options = buildSentryInitOptions("https://public@o0.ingest.sentry.io/0", "production");
    // Explicit, so SENTRY_TRACE_LIFECYCLE in the environment cannot switch it.
    expect(options.traceLifecycle).toBe("static");
    expect(options.beforeSendTransaction).toBeTypeOf("function");
    expect(options.beforeSendSpan).toBeTypeOf("function");
  });

  it("keeps the v10 data-collection baseline instead of v11's permissive default", () => {
    const options = buildSentryInitOptions("https://public@o0.ingest.sentry.io/0", "production");
    expect(options.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpBodies: [],
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      graphQL: { document: false, variables: false },
    });
  });
});

describe("Sentry wiring (real SDK, captured envelopes)", () => {
  it("an error event carries no credential from its message, extra, tags or breadcrumbs", async () => {
    Sentry.addBreadcrumb({
      category: "fetch",
      message: `GET https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`,
      data: {
        "url.query": `?key=${GEMINI_KEY}`,
        "http.request.header.x-desktop-verifier": VERIFIER,
      },
    });
    Sentry.withScope((scope) => {
      scope.setExtra("authorization", AUTH_EXTRA);
      scope.setTag("route", `/api/auth/google/callback?code=${OAUTH_CODE}`);
      Sentry.captureException(new Error(`provider echoed ?key=${GEMINI_KEY}`));
    });
    await Sentry.flush(FLUSH_MS);

    const payload = sent();
    expect(payload).toContain("provider echoed");
    expectNoSecret(payload);
  });

  it("a transaction and its child spans carry no credential", async () => {
    // The root span is named like the SDK's own server spans: by route, with
    // no query string. Its name is also copied into the envelope HEADER
    // (dynamic sampling context, `trace.transaction`), which no `before*`
    // hook can reach, so a span must never be hand-named after a raw URL.
    // Nothing in this codebase creates spans; the real-request test below
    // covers the SDK's own server span.
    Sentry.startSpan(
      {
        name: "GET /api/auth/google/callback",
        op: "http.server",
        forceTransaction: true,
        attributes: { "url.full": `https://api.klorn.ai/api/auth/google/callback?code=${OAUTH_CODE}` },
      },
      () => {
        Sentry.startSpan(
          {
            name: `GET https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`,
            op: "http.client",
            attributes: {
              "url.full": `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`,
              "url.query": `?key=${GEMINI_KEY}`,
              "http.request.header.x-desktop-verifier": VERIFIER,
            },
          },
          () => undefined,
        );
      },
    );
    await Sentry.flush(FLUSH_MS);

    const payload = sent();
    expect(payload).toContain('"type":"transaction"');
    expect(payload).toContain("generativelanguage.googleapis.com");
    expectNoSecret(payload);
  });

  it("a real HTTP request to Fastify leaves no credential and no SDK auto-captured error", async () => {
    const app = Fastify();
    app.get("/boom", async () => {
      throw new Error("route-failure-marker");
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const response = await fetch(`${address}/boom?code=${OAUTH_CODE}&key=${GEMINI_KEY}`, {
        headers: { "x-desktop-verifier": VERIFIER, cookie: `sid=${SESSION_COOKIE}` },
      });
      expect(response.status).toBe(500);
    } finally {
      await app.close();
    }
    await Sentry.flush(FLUSH_MS);

    const payload = sent();
    // error-handler.ts is the one place API errors are reported, through
    // captureError and its filters (the data-wipe fence, 4xx). v11's Fastify
    // integration would also report them on its own, unfiltered.
    expect(payload).not.toContain("route-failure-marker");
    expectNoSecret(payload);
  });
});
