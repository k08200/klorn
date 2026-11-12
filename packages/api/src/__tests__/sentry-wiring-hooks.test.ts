/**
 * Sentry wiring, one hook at a time.
 *
 * The four scrub hooks overlap on purpose: `beforeSendTransaction` re-scrubs
 * the spans `beforeSendSpan` already saw, and `beforeSend` re-scrubs the
 * breadcrumbs `beforeBreadcrumb` already saw. That redundancy also hides a
 * dead hook from sentry-wiring.test.ts. Under @sentry/node 11's static
 * lifecycle, a `beforeSendSpan` not wrapped in `Sentry.withStaticSpan` is
 * silently never called, and every test there still passes.
 *
 * So this file runs the production options with the two event-level hooks
 * removed. What is left on the wire is scrubbed by `beforeSendSpan` and
 * `beforeBreadcrumb` alone, or not at all.
 */
import * as Sentry from "@sentry/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildSentryInitOptions } from "../sentry.js";
import {
  initCapturingSentry,
  SENTRY_FLUSH_MS,
  type SentryCapture,
  TEST_SENTRY_DSN,
} from "./helpers/sentry-capture.js";

const GEMINI_KEY = `AIzaSy${"W".repeat(33)}`;
const VERIFIER = "opaque-desktop-verifier-hooks-3d70";

let capture: SentryCapture;

beforeAll(() => {
  capture = initCapturingSentry({
    ...buildSentryInitOptions(TEST_SENTRY_DSN, "test"),
    beforeSend: undefined,
    beforeSendTransaction: undefined,
  });
});

beforeEach(() => {
  capture.reset();
});

afterAll(async () => {
  await Sentry.close(SENTRY_FLUSH_MS);
});

describe("each scrub hook on its own (event-level hooks removed)", () => {
  it("beforeSendSpan alone scrubs every span of a transaction", async () => {
    Sentry.startSpan(
      { name: "POST /api/playground/run", op: "http.server", forceTransaction: true },
      () => {
        Sentry.startSpan(
          {
            name: `POST https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`,
            op: "http.client",
            attributes: {
              "url.full": `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`,
              "http.request.header.x-desktop-verifier": VERIFIER,
            },
          },
          () => undefined,
        );
      },
    );
    await Sentry.flush(SENTRY_FLUSH_MS);

    const payload = capture.sent();
    expect(payload).toContain('"type":"transaction"');
    expect(payload).toContain("generativelanguage.googleapis.com");
    expect(payload).not.toContain(GEMINI_KEY);
    expect(payload).not.toContain(VERIFIER);
  });

  it("beforeBreadcrumb alone scrubs a breadcrumb before it rides on an error", async () => {
    Sentry.addBreadcrumb({
      category: "fetch",
      message: `GET https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`,
      data: { "http.request.header.x-desktop-verifier": VERIFIER },
    });
    Sentry.captureException(new Error("hooks-file-error-marker"));
    await Sentry.flush(SENTRY_FLUSH_MS);

    const payload = capture.sent();
    expect(payload).toContain("hooks-file-error-marker");
    expect(payload).toContain("generativelanguage.googleapis.com");
    expect(payload).not.toContain(GEMINI_KEY);
    expect(payload).not.toContain(VERIFIER);
  });
});
