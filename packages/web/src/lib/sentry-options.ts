/**
 * The options browser Sentry is initialised with. Loaded with the SDK
 * (sentry.ts imports it lazily), so a page pays nothing for it while
 * NEXT_PUBLIC_SENTRY_DSN is unset.
 */

import type { BrowserOptions } from "@sentry/browser";
import { scrubBreadcrumb, scrubEvent } from "./sentry-scrub";

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
