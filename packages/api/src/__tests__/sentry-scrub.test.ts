/**
 * Sentry boundary scrubbing — the BYOK key must not leave the process.
 *
 * `beforeSend` alone was not enough. It scrubs `event.request.*`, but a
 * user-supplied provider key travelling in a REQUEST URL reaches Sentry by two
 * other routes that `beforeSend` never sees:
 *
 *   - the outgoing-fetch BREADCRUMB, which stores the raw query string in
 *     `data["http.query"]` (@sentry/node-core
 *     build/cjs/utils/outgoingFetchRequest.js:152 — `data.url` is sanitized,
 *     `http.query` is not), and rides along on the next captured error;
 *   - the fetch SPAN, whose attributes include both `url.full` (the whole URL)
 *     and `url.query` (@sentry/node-core
 *     build/cjs/integrations/node-fetch/undici-instrumentation.js:108-110).
 *
 * These are synthetic events on purpose: no DSN, no network. They assert the
 * shape of what the hooks hand back, so the guard holds even if the only
 * producer of a `?key=` URL goes away.
 */

import { describe, expect, it } from "vitest";
import {
  scrubSentryBreadcrumb,
  scrubSentryErrorEvent,
  scrubSentrySpan,
  scrubSentryTransaction,
} from "../security/sentry-scrub.js";

const KEY = "AQ.Ab8RN6J0123456789secretkey";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${KEY}&alt=sse`;

describe("scrubSentryBreadcrumb", () => {
  it("redacts the key out of http.query on an outgoing-fetch breadcrumb", () => {
    const scrubbed = scrubSentryBreadcrumb({
      category: "http",
      type: "http",
      level: "info",
      data: {
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        "http.method": "POST",
        "http.query": `?key=${KEY}&alt=sse`,
        status_code: 429,
      },
    });
    expect(JSON.stringify(scrubbed)).not.toContain(KEY);
    // Everything that is NOT the credential survives — a scrubbed breadcrumb
    // still has to be worth reading.
    expect(scrubbed.data?.["http.query"]).toContain("alt=sse");
    expect(scrubbed.data?.status_code).toBe(429);
    expect(scrubbed.data?.["http.method"]).toBe("POST");
  });

  it("redacts a key that arrives in the breadcrumb url itself", () => {
    const scrubbed = scrubSentryBreadcrumb({
      category: "http",
      data: { url: GEMINI_URL },
    });
    expect(JSON.stringify(scrubbed)).not.toContain(KEY);
  });

  it("redacts a key in the breadcrumb message", () => {
    const scrubbed = scrubSentryBreadcrumb({
      category: "llm",
      message: `POST ${GEMINI_URL} -> 429`,
    });
    expect(JSON.stringify(scrubbed)).not.toContain(KEY);
  });

  it("reaches a key nested inside breadcrumb data", () => {
    const scrubbed = scrubSentryBreadcrumb({
      category: "llm",
      data: { attempt: 3, request: { urls: [GEMINI_URL] } },
    });
    expect(JSON.stringify(scrubbed)).not.toContain(KEY);
    expect(scrubbed.data?.attempt).toBe(3);
  });

  it("does not mutate the breadcrumb it was given", () => {
    const data = { "http.query": `?key=${KEY}` };
    const breadcrumb = { category: "http", data };
    scrubSentryBreadcrumb(breadcrumb);
    expect(data["http.query"]).toBe(`?key=${KEY}`);
  });

  it("passes a clean breadcrumb through unchanged", () => {
    const scrubbed = scrubSentryBreadcrumb({
      category: "http",
      data: { url: "https://api.openai.com/v1/chat/completions", "http.method": "POST" },
    });
    expect(scrubbed.data?.url).toBe("https://api.openai.com/v1/chat/completions");
  });
});

describe("scrubSentrySpan", () => {
  it("redacts url.full and url.query on a fetch span", () => {
    const scrubbed = scrubSentrySpan({
      span_id: "a1",
      trace_id: "b2",
      start_timestamp: 1,
      op: "http.client",
      description: `POST ${GEMINI_URL}`,
      data: {
        "http.request.method": "POST",
        "url.full": GEMINI_URL,
        "url.query": `?key=${KEY}&alt=sse`,
        "server.address": "generativelanguage.googleapis.com",
      },
    });
    expect(JSON.stringify(scrubbed)).not.toContain(KEY);
    expect(scrubbed.data?.["server.address"]).toBe("generativelanguage.googleapis.com");
    expect(scrubbed.data?.["http.request.method"]).toBe("POST");
  });

  it("redacts the key out of the span description", () => {
    const scrubbed = scrubSentrySpan({
      span_id: "a1",
      trace_id: "b2",
      start_timestamp: 1,
      description: `POST ${GEMINI_URL}`,
      data: {},
    });
    expect(scrubbed.description).not.toContain(KEY);
  });

  it("does not mutate the span it was given", () => {
    const data: Record<string, unknown> = { "url.full": GEMINI_URL };
    scrubSentrySpan({ span_id: "a1", trace_id: "b2", start_timestamp: 1, data });
    expect(data["url.full"]).toBe(GEMINI_URL);
  });
});

describe("scrubSentryTransaction", () => {
  it("redacts the trace context and every child span", () => {
    const scrubbed = scrubSentryTransaction({
      type: "transaction",
      contexts: {
        trace: {
          span_id: "a1",
          trace_id: "b2",
          data: { "url.full": GEMINI_URL },
        },
      },
      spans: [
        {
          span_id: "c3",
          trace_id: "b2",
          start_timestamp: 1,
          description: `POST ${GEMINI_URL}`,
          data: { "url.query": `?key=${KEY}` },
        },
      ],
    });
    expect(JSON.stringify(scrubbed)).not.toContain(KEY);
  });
});

describe("scrubSentryErrorEvent", () => {
  it("still does what beforeSend already did — strips the URL query and known body fields", () => {
    const scrubbed = scrubSentryErrorEvent({
      request: {
        url: "https://api.klorn.ai/auth/google/callback?code=4/live-auth-code&state=signed.jwt",
        query_string: "code=4/live-auth-code&state=signed.jwt",
        headers: { authorization: "Bearer live", cookie: "sid=1", "user-agent": "klorn" },
        data: { apiKey: KEY, password: "hunter2", subject: "hi" },
      },
    });
    expect(scrubbed.request?.url).toBe("https://api.klorn.ai/auth/google/callback");
    expect(scrubbed.request?.query_string).toBeUndefined();
    expect(scrubbed.request?.headers?.authorization).toBeUndefined();
    expect(scrubbed.request?.headers?.cookie).toBeUndefined();
    expect(scrubbed.request?.headers?.["user-agent"]).toBe("klorn");
    const data = scrubbed.request?.data as Record<string, unknown>;
    expect(data.apiKey).toBe("[REDACTED]");
    expect(data.password).toBe("[REDACTED]");
    expect(data.subject).toBe("hi");
    expect(JSON.stringify(scrubbed)).not.toContain(KEY);
  });

  it("drops a raw-string request body whole", () => {
    const scrubbed = scrubSentryErrorEvent({
      request: { data: `{"apiKey":"${KEY}"}` },
    });
    expect(scrubbed.request?.data).toBeUndefined();
  });

  it("scrubs breadcrumbs already attached to the event — the backstop behind beforeBreadcrumb", () => {
    const scrubbed = scrubSentryErrorEvent({
      breadcrumbs: [
        { category: "http", data: { "http.query": `?key=${KEY}&alt=sse` } },
        { category: "http", data: { url: "https://api.openai.com/v1" } },
      ],
    });
    expect(JSON.stringify(scrubbed)).not.toContain(KEY);
    expect(scrubbed.breadcrumbs?.[1]?.data?.url).toBe("https://api.openai.com/v1");
  });

  it("scrubs the exception message — providers echo the request URL back in error bodies", () => {
    const scrubbed = scrubSentryErrorEvent({
      exception: {
        values: [
          { type: "GeminiHttp400Error", value: `Gemini 400: bad request for ${GEMINI_URL}` },
        ],
      },
    });
    expect(JSON.stringify(scrubbed)).not.toContain(KEY);
    expect(scrubbed.exception?.values?.[0]?.type).toBe("GeminiHttp400Error");
  });

  it("scrubs a top-level message and the extra bag", () => {
    const scrubbed = scrubSentryErrorEvent({
      message: `fetch failed: ${GEMINI_URL}`,
      extra: { requestUrl: GEMINI_URL, attempt: 2 },
    });
    expect(JSON.stringify(scrubbed)).not.toContain(KEY);
    expect(scrubbed.extra?.attempt).toBe(2);
  });

  it("does not mutate the event it was given", () => {
    const request = { url: `https://x.test/v1?key=${KEY}` };
    scrubSentryErrorEvent({ request });
    expect(request.url).toBe(`https://x.test/v1?key=${KEY}`);
  });
});

/**
 * Channels the first version of this scrub missed (2026-10-30 security review).
 *
 * The big one is structural: @sentry/core runs `beforeSend` ONLY for error
 * events and `beforeSendTransaction` ONLY for transactions
 * (build/cjs/client.js:734 `isErrorEvent(processedEvent) && beforeSend`), while
 * `requestDataIntegration()` — a node-core default
 * (build/cjs/sdk/index.js:33) — attaches `event.request` to BOTH. So a
 * transaction event carried the whole playground request body, cookies and
 * `Authorization` header straight past a `beforeSend` that looked airtight.
 */
describe("scrubSentryTransaction — the non-span fields", () => {
  it("scrubs request, breadcrumbs, extra and tags, not just contexts and spans", () => {
    const scrubbed = scrubSentryTransaction({
      type: "transaction",
      request: {
        url: `https://api.klorn.ai/playground/classify?key=${KEY}`,
        query_string: `key=${KEY}`,
        headers: { authorization: `Bearer ${KEY}`, "user-agent": "klorn" },
        cookies: { sid: KEY },
        data: { apiKey: KEY, subject: "hi" },
      },
      breadcrumbs: [{ category: "http", data: { "http.query": `?key=${KEY}` } }],
      extra: { requestUrl: GEMINI_URL },
      tags: { route: `/playground/classify?key=${KEY}` },
      contexts: { trace: { span_id: "a1", trace_id: "b2" } },
      spans: [],
    });
    expect(JSON.stringify(scrubbed)).not.toContain(KEY);
    expect(scrubbed.request?.headers?.["user-agent"]).toBe("klorn");
  });
});

describe("scrubSentryErrorEvent — request parts beyond url, headers and data", () => {
  it("drops SDK-parsed cookies, which survived the header filter", () => {
    // The `cookie` HEADER was removed, but requestDataIntegration also stores
    // a parsed `cookies` object, and the spread carried it through untouched.
    const scrubbed = scrubSentryErrorEvent({
      request: { cookies: { sid: KEY, theme: "dark" } },
    });
    expect(JSON.stringify(scrubbed)).not.toContain(KEY);
  });

  it("scrubs the values of headers it does not drop outright", () => {
    const scrubbed = scrubSentryErrorEvent({
      request: { headers: { referer: `https://klorn.ai/p?gk=${KEY}`, "user-agent": "klorn" } },
    });
    expect(JSON.stringify(scrubbed)).not.toContain(KEY);
    expect(scrubbed.request?.headers?.["user-agent"]).toBe("klorn");
  });

  it("drops this API's own secret headers, not only the standard four", () => {
    const scrubbed = scrubSentryErrorEvent({
      request: {
        headers: {
          "x-cron-secret": KEY,
          "x-telegram-bot-api-secret-token": KEY,
          "x-desktop-verifier": KEY,
          "sec-websocket-protocol": KEY,
          "x-api-key": KEY,
        },
      },
    });
    expect(JSON.stringify(scrubbed)).not.toContain(KEY);
  });

  it("scrubs tags — perf-monitor puts a raw request URL in the route tag", () => {
    const scrubbed = scrubSentryErrorEvent({
      tags: { route: `/v1/proxy?key=${KEY}`, userId: "u1" },
    });
    expect(JSON.stringify(scrubbed)).not.toContain(KEY);
    expect(scrubbed.tags?.userId).toBe("u1");
  });
});

describe("scrubValue — bounded work on hostile input", () => {
  it("does not enumerate a Buffer index by index", () => {
    // Console breadcrumbs carry raw call arguments
    // (@sentry/core integrations/console.js), so this walk runs on whatever a
    // caller passed to console.warn. Object.entries on a 2 MB Buffer built a
    // 2-million-key object and blocked the event loop for seconds.
    const started = process.cpuUsage();
    const scrubbed = scrubSentryBreadcrumb({
      category: "console",
      data: { arguments: [Buffer.alloc(2 * 1024 * 1024)] },
    });
    const elapsedMs = (process.cpuUsage(started).user + process.cpuUsage(started).system) / 1000;
    expect(JSON.stringify(scrubbed).length).toBeLessThan(2000);
    expect(elapsedMs).toBeLessThan(500);
  });

  it("stops after a bounded number of nodes instead of walking a wide graph forever", () => {
    // A shared-child DAG: `seen` only holds the ancestor chain, so without a
    // budget every path into a shared node is walked again — exponential in
    // depth. Depth 11 with fan-out 4 took seconds.
    let node: unknown = { leaf: "x" };
    for (let i = 0; i < 12; i++) {
      node = { a: node, b: node, c: node, d: node };
    }
    const started = process.cpuUsage();
    scrubSentryBreadcrumb({ category: "console", data: { arguments: [node] } });
    const elapsedMs = (process.cpuUsage(started).user + process.cpuUsage(started).system) / 1000;
    expect(elapsedMs).toBeLessThan(500);
  });

  it("still scrubs a key that sits inside a bounded structure", () => {
    const scrubbed = scrubSentryBreadcrumb({
      category: "console",
      data: { arguments: ["POST failed", { url: GEMINI_URL }] },
    });
    expect(JSON.stringify(scrubbed)).not.toContain(KEY);
  });
});
