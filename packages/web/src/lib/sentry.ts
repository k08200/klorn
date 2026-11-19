"use client";

/**
 * Sentry Client Error Tracking — Lightweight browser-side error capture.
 *
 * Initializes only when NEXT_PUBLIC_SENTRY_DSN is set.
 * Captures unhandled errors and provides manual captureError() helper.
 */

import { scrubBreadcrumb, scrubEvent } from "./sentry-scrub";

const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN || "";

type SentryModule = Awaited<typeof import("@sentry/browser")>;
type BrowserOptions = NonNullable<Parameters<SentryModule["init"]>[0]>;

/** Default integrations Klorn turns off: console arguments are app text (a mail's among it); the culture context is the user's timezone. */
const DROPPED_INTEGRATIONS = new Set(["Console", "CultureContext"]);

/**
 * The options `Sentry.init` gets, built in one place so a test can run the real
 * SDK with them (api/src/__tests__/web-sentry-browser-wiring.test.ts).
 *
 * @sentry/browser 11 collects everything unless told otherwise: `dataCollection`
 * defaults turn on `userInfo` (Sentry then infers the IP from the request), raw
 * headers and URL queries. Each is turned off here, and the scrub hooks
 * (sentry-scrub.ts) run on every event and breadcrumb whatever the SDK collects.
 */
export function buildSentryBrowserOptions(dsn: string, environment: string): BrowserOptions {
  return {
    dsn,
    environment,
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    // v10 behaviour: no synthetic stack trace on captureMessage or a non-Error value.
    attachStacktrace: false,
    integrations: (defaults) =>
      defaults.filter((integration) => !DROPPED_INTEGRATIONS.has(integration.name)),
    beforeBreadcrumb: scrubBreadcrumb,
    beforeSend: scrubEvent,
    // Nothing in the app sends logs or metrics, and spans are off (tracesSampleRate 0).
    // These bypass beforeSend, so they are dropped outright should a call appear.
    beforeSendLog: () => null,
    beforeSendMetric: () => null,
  };
}

let initialized = false;
let sentryPromise: Promise<SentryModule | null> | null = null;

function loadSentry(): Promise<SentryModule | null> {
  if (!DSN || typeof window === "undefined") return Promise.resolve(null);
  sentryPromise ??= import("@sentry/browser");
  return sentryPromise;
}

async function ensureSentry(): Promise<SentryModule | null> {
  const Sentry = await loadSentry();
  if (!Sentry) return null;
  if (!initialized) {
    Sentry.init(buildSentryBrowserOptions(DSN, process.env.NODE_ENV || "development"));
    initialized = true;
  }
  return Sentry;
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
