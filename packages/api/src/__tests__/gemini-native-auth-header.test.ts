/**
 * Gemini native API auth — the key goes in a header, never in the URL.
 *
 * A credential in a query string leaks by default: Sentry's fetch breadcrumb
 * records the raw query (`http.query`) and the fetch span records both
 * `url.full` and `url.query`. The Sentry boundary now scrubs all three
 * (see sentry-scrub.test.ts), but the first line of defence is not putting the
 * key there at all — `x-goog-api-key` is Google's documented header for
 * generativelanguage.googleapis.com, and unlike the OpenAI-compatible
 * endpoint's `Authorization: Bearer` it accepts the newer `AQ.`-prefix keys.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCompletionNonStreaming,
  createCompletionStreaming,
} from "../providers/gemini-native.js";

const KEY = "AQ.Ab8RN6J0123456789secretkey";

function okResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }),
    text: async () => "",
    body: null,
  } as unknown as Response;
}

function captureFetch() {
  const fetchMock = vi.fn(async () => okResponse());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function callArgs(fetchMock: ReturnType<typeof captureFetch>) {
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return { url, headers: (init.headers ?? {}) as Record<string, string> };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gemini-native request auth", () => {
  it("sends the key as x-goog-api-key and keeps it out of the URL", async () => {
    const fetchMock = captureFetch();

    await createCompletionNonStreaming(
      { model: "gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] },
      KEY,
    );

    const { url, headers } = callArgs(fetchMock);
    expect(url).not.toContain(KEY);
    expect(url).not.toContain("key=");
    expect(headers["x-goog-api-key"]).toBe(KEY);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("keeps the key out of the URL on the streaming path, and keeps alt=sse", async () => {
    const fetchMock = captureFetch();

    const stream = createCompletionStreaming(
      { model: "gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] },
      KEY,
    );
    // The generator does not issue the request until it is pulled.
    await stream[Symbol.asyncIterator]().next();

    const { url, headers } = callArgs(fetchMock);
    // Exact, not toContain: `alt=sse` must be the ONLY query parameter, so a
    // credential re-appearing beside it cannot slip past this assertion.
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
    );
    expect(url).not.toContain(KEY);
    expect(headers["x-goog-api-key"]).toBe(KEY);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("still targets the model endpoint it always did", async () => {
    const fetchMock = captureFetch();

    await createCompletionNonStreaming(
      { model: "gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] },
      KEY,
    );

    expect(callArgs(fetchMock).url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
  });
});
