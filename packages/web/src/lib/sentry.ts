"use client";

/**
 * Sentry Client Error Tracking — Lightweight browser-side error capture.
 *
 * Initializes only when NEXT_PUBLIC_SENTRY_DSN is set.
 * Captures unhandled errors and provides manual captureError() helper.
 */

const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN || "";

type SentryModule = Awaited<typeof import("@sentry/browser")>;

let initialized = false;
let sentryPromise: Promise<SentryModule | null> | null = null;

/** The SDK, initialised once with Klorn's options (sentry-options.ts); null without a DSN or a window. */
function ensureSentry(): Promise<SentryModule | null> {
  if (!DSN || typeof window === "undefined") return Promise.resolve(null);
  sentryPromise ??= Promise.all([import("@sentry/browser"), import("./sentry-options")]).then(
    ([Sentry, { buildSentryBrowserOptions }]) => {
      if (!initialized) {
        Sentry.init(buildSentryBrowserOptions(DSN, process.env.NODE_ENV || "development"));
        initialized = true;
      }
      return Sentry;
    },
  );
  return sentryPromise;
}

export function initSentryClient(): void {
  if (!DSN || initialized) return;
  ensureSentry().catch(() => {});
}

export function captureClientError(error: unknown, context?: Record<string, unknown>): void {
  const err = error instanceof Error ? error : new Error(String(error));
  // Always emit a console signal first — Sentry is a no-op when the DSN is
  // unset (the live default: no NEXT_PUBLIC_SENTRY_DSN), so without this every
  // captured client error is fully invisible. Matches the repo rule "log a
  // signal even on non-fatal paths".
  // biome-ignore lint/suspicious/noConsole: deliberate visibility signal when Sentry is off
  console.error("[client error]", err, context ?? "");
  ensureSentry()
    .then((Sentry) => {
      if (!Sentry) return;
      Sentry.withScope((scope) => {
        if (context) {
          for (const [k, v] of Object.entries(context)) {
            scope.setExtra(k, v);
          }
        }
        Sentry.captureException(err);
      });
    })
    .catch(() => {
      if (process.env.NODE_ENV !== "production") {
        // biome-ignore lint/suspicious/noConsole: dev-only fallback when Sentry fails
        console.error(err);
      }
    });
}
