/**
 * Run the real Sentry SDK with a transport that records every serialized
 * envelope instead of sending it. One `Sentry.init` per test file: vitest runs
 * each file in its own fork (vitest.config.ts `pool: "forks"`).
 */
import * as Sentry from "@sentry/node";

/** A DSN that only names a project; the capturing transport never dials it. */
export const TEST_SENTRY_DSN = "https://public@o0.ingest.sentry.io/0";

/** Flush budget for one test's envelopes. */
export const SENTRY_FLUSH_MS = 5_000;

export interface SentryCapture {
  /** Every envelope sent since the last `reset`, newline-joined. */
  sent(): string;
  /** Forget captured envelopes and the breadcrumbs queued on the scopes. */
  reset(): void;
}

export function initCapturingSentry(options: Sentry.NodeOptions): SentryCapture {
  const wire: string[] = [];
  const decoder = new TextDecoder();
  Sentry.init({
    ...options,
    transport: (transportOptions) =>
      Sentry.createTransport(transportOptions, async (request) => {
        wire.push(typeof request.body === "string" ? request.body : decoder.decode(request.body));
        return { statusCode: 200 };
      }),
  });
  return {
    sent: () => wire.join("\n"),
    reset: () => {
      wire.length = 0;
      // A breadcrumb from one test would otherwise ride on the next one's event.
      Sentry.getIsolationScope().clearBreadcrumbs();
      Sentry.getCurrentScope().clearBreadcrumbs();
    },
  };
}
