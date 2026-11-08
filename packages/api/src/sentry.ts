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

export function initSentry(): void {
  if (!DSN || initialized) return;

  Sentry.init({
    dsn: DSN,
    environment: ENV,
    tracesSampleRate: ENV === "production" ? 0.1 : 1.0,
    // All four hooks, because a credential reaches Sentry by four routes and
    // scrubbing one of them is what let a BYOK Gemini key ride out on a
    // breadcrumb and a span while `beforeSend` looked clean. The logic lives
    // in security/sentry-scrub.ts so it can be tested without a DSN.
    beforeSend: (event) => scrubSentryErrorEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubSentryBreadcrumb(breadcrumb),
    beforeSendSpan: (span) => scrubSentrySpan(span),
    beforeSendTransaction: (event) => scrubSentryTransaction(event),
  });

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
