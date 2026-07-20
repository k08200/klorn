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
 */

import * as Sentry from "@sentry/node";

const DSN = process.env.SENTRY_DSN || "";
const ENV = process.env.NODE_ENV || "development";

let initialized = false;

export function initSentry(): void {
  if (!DSN || initialized) return;

  Sentry.init({
    dsn: DSN,
    environment: ENV,
    tracesSampleRate: ENV === "production" ? 0.1 : 1.0,
    beforeSend(event) {
      // Strip sensitive data from events
      if (event.request?.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers.cookie;
      }
      // Scrub the URL query string — the OAuth callback's ?code=…&state=…
      // (live Google authorization code + signed state JWT) would otherwise
      // ship to Sentry when the callback throws (security audit 2026-07-20).
      if (event.request?.url) {
        event.request.url = event.request.url.split("?")[0];
      }
      if (event.request?.query_string) {
        event.request.query_string = undefined;
      }
      // Scrub request bodies — a captured error during a POST can otherwise
      // ship submitted credentials (playground apiKey, login password, OAuth
      // token) to Sentry. Redact known fields; drop a raw-string body whole.
      if (event.request?.data) {
        const data = event.request.data;
        if (typeof data === "object" && data !== null) {
          for (const field of ["apiKey", "password", "token", "openRouterApiKey", "geminiApiKey"]) {
            if (field in (data as Record<string, unknown>)) {
              (data as Record<string, unknown>)[field] = "[REDACTED]";
            }
          }
        } else {
          event.request.data = undefined;
        }
      }
      return event;
    },
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
