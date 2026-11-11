/**
 * Sentry Error Tracking — Centralized error capture for Eve API.
 *
 * Initializes Sentry only when SENTRY_DSN is set. In development
 * without a DSN, all capture calls are no-ops.
 *
 * Key operations tracked:
 * - Unhandled API errors (via Fastify error handler)
 * - Tool execution failures
 * - Agent cycle failures
 * - Gmail/Calendar sync failures
 * - LLM API errors
 *
 * Every outbound payload goes through security/sentry-scrub.ts first. That is
 * four hooks, not one: a BYOK provider key travelling in a request URL reaches
 * Sentry on breadcrumbs and spans, which `beforeSend` cannot see.
 */

import * as Sentry from "@sentry/node";
import { isDataWipeFenceError } from "./privacy/data-wipe-fence.js";
import {
  scrubSentryBreadcrumb,
  scrubSentryErrorEvent,
  scrubSentrySpan,
  scrubSentryTransaction,
} from "./security/sentry-scrub.js";

const DSN = process.env.SENTRY_DSN || "";
const ENV = process.env.NODE_ENV || "development";

let initialized = false;

/**
 * What the SDK may collect on its own. @sentry/node 11 collects user IP,
 * cookies, all headers and request/response bodies when `dataCollection` is
 * unset; v10 collected none of those without `sendDefaultPii`. This is the
 * v11 migration guide's "keep the v10 default" baseline, field for field.
 */
const V10_DATA_COLLECTION_BASELINE = {
  userInfo: false,
  cookies: false,
  httpHeaders: {
    request: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
    response: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
  },
  httpBodies: [],
  urlQueryParams: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  graphQL: { document: false, variables: false },
} satisfies Sentry.NodeOptions["dataCollection"];

/**
 * The options `initSentry` passes to `Sentry.init`. Exported so
 * sentry-wiring.test.ts can run the real SDK with exactly these options.
 */
export function buildSentryInitOptions(dsn: string, env: string): Sentry.NodeOptions {
  return {
    dsn,
    environment: env,
    tracesSampleRate: env === "production" ? 0.1 : 1.0,
    // @sentry/node 11 streams spans by default. In that mode
    // `beforeSendTransaction` never runs, and `beforeSendSpan` receives a
    // different shape (`name`/`attributes`), so the span scrub below would
    // copy secrets through untouched. Pin the transaction model these hooks
    // are written for. Set here, not left to the default, so a
    // SENTRY_TRACE_LIFECYCLE env var cannot switch it.
    traceLifecycle: "static",
    dataCollection: V10_DATA_COLLECTION_BASELINE,
    integrations: [
      // v11's Fastify integration (a default) reports route errors by itself.
      // error-handler.ts already reports them through captureError, which
      // skips data-wipe fence rejections and cost-cap refusals; keep that the
      // only path, as in v10.
      Sentry.fastifyIntegration({ shouldHandleError: () => false }),
    ],
    // All four hooks, because a credential reaches Sentry by four routes and
    // scrubbing one of them is what let a BYOK Gemini key ride out on a
    // breadcrumb and a span while `beforeSend` looked clean. The logic lives
    // in security/sentry-scrub.ts so it can be tested without a DSN.
    beforeSend: (event) => scrubSentryErrorEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubSentryBreadcrumb(breadcrumb),
    // A callback not wrapped in withStaticSpan is never invoked under the
    // static lifecycle.
    beforeSendSpan: Sentry.withStaticSpan((span) => scrubSentrySpan(span)),
    beforeSendTransaction: (event) => scrubSentryTransaction(event),
  };
}

export function initSentry(): void {
  if (!DSN || initialized) return;

  Sentry.init(buildSentryInitOptions(DSN, ENV));

  initialized = true;
  console.log(`[SENTRY] Initialized (env=${ENV})`);
}

/** Capture an error with optional context */
export function captureError(
  error: unknown,
  context?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
): void {
  if (!initialized) return;
  // A write the data-wipe fence rejected is the fence working, not a fault:
  // stale work for a wiped account fails every write it tries. The callers
  // still log it.
  if (isDataWipeFenceError(error)) return;

  const err = error instanceof Error ? error : new Error(String(error));

  Sentry.withScope((scope) => {
    if (context?.tags) {
      for (const [k, v] of Object.entries(context.tags)) {
        scope.setTag(k, v);
      }
    }
    if (context?.extra) {
      for (const [k, v] of Object.entries(context.extra)) {
        scope.setExtra(k, v);
      }
    }
    Sentry.captureException(err);
  });
}

/** Track a breadcrumb for debugging context */
export function addBreadcrumb(
  category: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (!initialized) return;
  Sentry.addBreadcrumb({ category, message, data, level: "info" });
}

/** Flush pending events (call before process exit) */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!initialized) return;
  await Sentry.flush(timeoutMs);
}

export { Sentry };
