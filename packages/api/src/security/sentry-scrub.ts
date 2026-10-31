/**
 * Sentry boundary scrubbing — pure functions, wired up by ../sentry.ts.
 *
 * `beforeSend` scrubs `event.request.*`, which is enough for a credential that
 * arrives in a request BODY (the playground's `apiKey`). A credential in a
 * request URL is a different problem: it reaches Sentry through two channels
 * `beforeSend` never touches, both enabled by default.
 *
 *   BREADCRUMB — the outgoing-fetch breadcrumb sanitizes `data.url` but then
 *   stores the raw query string alongside it:
 *     @sentry/node-core build/cjs/utils/outgoingFetchRequest.js
 *       data["http.query"] = parsedUrl.search;
 *   Breadcrumbs ride along on the next captured error, so any later
 *   `captureError` ships them — judge/poc-judge.ts is the realistic caller.
 *
 *   SPAN — the fetch span records the WHOLE url plus its query:
 *     @sentry/node-core build/cjs/integrations/node-fetch/undici-instrumentation.js
 *       [attributes.URL_FULL]: requestUrl.toString(),
 *       [attributes.URL_QUERY]: requestUrl.search,
 *
 * So the scrub has to happen at all four hooks, not just one. The functions
 * below are generic over the payload type so they can be handed straight to
 * `beforeBreadcrumb` / `beforeSendSpan` / `beforeSendTransaction` /
 * `beforeSend` without importing Sentry's types here — this module stays pure
 * and testable against synthetic events, with no DSN and no network.
 *
 * Everything returns a NEW object; a hook that mutated its input would also
 * mutate the live breadcrumb buffer the next event reads from.
 */

import { isCredentialName, redactCredentials } from "./credential-redaction.js";

/**
 * Nesting depth beyond which a value is replaced rather than walked.
 *
 * Sentry normalizes its own payloads to depth 3, so this is unreachable for
 * anything the SDK produces; it exists so a hand-built `extra` bag cannot turn
 * a hook into a stack overflow. Hitting it replaces the value instead of
 * passing it through un-scrubbed — a depth cap must not become a leak.
 */
const MAX_SCRUB_DEPTH = 12;

/**
 * Hard ceiling on nodes visited per scrub.
 *
 * This walk is not rare: the console integration stores a breadcrumb's raw
 * call arguments (@sentry/core integrations/console.js), so it runs over
 * whatever anyone passed to `console.warn`. Two things made that dangerous —
 * `Object.entries` on a 2 MB Buffer built a two-million-key object and burned
 * ~860ms of CPU in a test, and because `seen` holds only the ancestor chain, a
 * shared-child graph gets re-walked once per path into it. A node budget
 * bounds both without needing to reason about either shape.
 */
const MAX_SCRUB_NODES = 5000;

/** Fields a credential can hide in. Loose on purpose — see the module note. */
interface ScrubbableBreadcrumb {
  message?: string;
  data?: Record<string, unknown>;
}

interface ScrubbableSpan {
  description?: string;
  data?: Record<string, unknown>;
}

interface ScrubbableTransaction extends ScrubbableEventCommon {
  spans?: ScrubbableSpan[];
}

interface ScrubbableRequest {
  url?: string;
  query_string?: unknown;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  data?: unknown;
}

/**
 * Fields that ride on BOTH event types and so must be scrubbed by both hooks.
 *
 * @sentry/core runs `beforeSend` only for error events and
 * `beforeSendTransaction` only for transactions (build/cjs/client.js:734),
 * while `requestDataIntegration()` — a node-core default
 * (build/cjs/sdk/index.js:33) — attaches `request` to both. Scrubbing these in
 * one hook only is how a transaction event shipped the whole playground
 * request body past a `beforeSend` that looked airtight.
 */
interface ScrubbableEventCommon {
  message?: string;
  request?: ScrubbableRequest;
  breadcrumbs?: ScrubbableBreadcrumb[];
  extra?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  contexts?: Record<string, Record<string, unknown> | undefined>;
}

interface ScrubbableErrorEvent extends ScrubbableEventCommon {
  exception?: { values?: Array<{ value?: string }> };
}

/**
 * Headers dropped outright rather than redacted.
 *
 * Beyond the obvious two, these are this API's own shared secrets:
 * `x-cron-secret` (routes/cron.ts), `x-telegram-bot-api-secret-token`
 * (routes/telegram.ts), `x-desktop-verifier` (routes/auth.ts) and the token
 * carried in `sec-websocket-protocol` (websocket.ts). `isCredentialName`
 * matches all of them by substring, so the list below only names what it
 * cannot infer.
 */
const EXTRA_CREDENTIAL_HEADERS = ["sec-websocket-protocol"] as const;

function isCredentialHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return isCredentialName(lower) || EXTRA_CREDENTIAL_HEADERS.includes(lower as never);
}

/** Mutable per-call budget, so one hostile breadcrumb cannot stall the hook. */
interface ScrubBudget {
  remaining: number;
  seen: WeakSet<object>;
}

/**
 * Walk any value, redacting strings and rebuilding containers.
 *
 * `seen` breaks cycles: Sentry's own payloads are JSON-serializable, but an
 * `extra` bag or a console argument need not be, and a cycle here would hang
 * the hook on every event. Anything the walk declines to enter is REPLACED, not
 * passed through — a limit that let a value escape un-scrubbed would be a leak
 * wearing a safety hat.
 */
function scrubValue(value: unknown, depth: number, budget: ScrubBudget): unknown {
  if (typeof value === "string") return redactCredentials(value);
  if (value === null || typeof value !== "object") return value;
  if (budget.seen.has(value)) return "[CIRCULAR]";
  if (depth >= MAX_SCRUB_DEPTH) return "[DEPTH-CAPPED]";
  if (budget.remaining <= 0) return "[SCRUB-BUDGET-EXCEEDED]";
  // Binary payloads hold no credential text and enumerate one key per byte.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return "[BINARY]";

  budget.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const entry of value) {
        if (budget.remaining <= 0) {
          out.push("[SCRUB-BUDGET-EXCEEDED]");
          break;
        }
        budget.remaining -= 1;
        out.push(scrubValue(entry, depth + 1, budget));
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (budget.remaining <= 0) {
        out["[SCRUB-BUDGET-EXCEEDED]"] = true;
        break;
      }
      budget.remaining -= 1;
      // A credential-named field is redacted whatever its value's shape — the
      // patterns cannot recognise an opaque token, but the name gives it away.
      out[key] =
        isCredentialName(key) && entry !== undefined && entry !== null
          ? "[REDACTED]"
          : scrubValue(entry, depth + 1, budget);
    }
    return out;
  } finally {
    // Siblings are not a cycle: only an ancestor chain is.
    budget.seen.delete(value);
  }
}

/** Scrub a bag of key/value data (breadcrumb data, span attributes, extra). */
function scrubBag(bag: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!bag) return bag;
  return scrubValue(bag, 0, { remaining: MAX_SCRUB_NODES, seen: new WeakSet() }) as Record<
    string,
    unknown
  >;
}

/** `beforeBreadcrumb` — the outgoing-fetch breadcrumb's `http.query`. */
export function scrubSentryBreadcrumb<T extends ScrubbableBreadcrumb>(breadcrumb: T): T {
  return {
    ...breadcrumb,
    ...(breadcrumb.message !== undefined ? { message: redactCredentials(breadcrumb.message) } : {}),
    ...(breadcrumb.data !== undefined ? { data: scrubBag(breadcrumb.data) } : {}),
  } as T;
}

/** `beforeSendSpan` — the fetch span's `url.full` and `url.query`. */
export function scrubSentrySpan<T extends ScrubbableSpan>(span: T): T {
  return {
    ...span,
    ...(span.description !== undefined ? { description: redactCredentials(span.description) } : {}),
    ...(span.data !== undefined ? { data: scrubBag(span.data) } : {}),
  } as T;
}

/** Strip the credential-bearing parts of a captured request. */
function scrubRequest(request: ScrubbableRequest): ScrubbableRequest {
  const headers = request.headers
    ? Object.fromEntries(
        Object.entries(request.headers)
          .filter(([name]) => !isCredentialHeader(name))
          // A header that is not itself a credential can still CARRY one:
          // `Referer: …?gk=AIza…` reached the wire before this pass existed.
          .map(([name, value]) => [
            name,
            typeof value === "string" ? redactCredentials(value) : value,
          ]),
      )
    : request.headers;

  // An object body gets walked (scrubValue redacts credential-named fields
  // whatever their shape); a raw-string body is dropped whole, because we
  // cannot tell what is in it.
  let data = request.data;
  if (typeof data === "object" && data !== null) {
    data = scrubBag(data as Record<string, unknown>);
  } else if (data !== undefined) {
    data = undefined;
  }

  return {
    ...request,
    // The OAuth callback's ?code=…&state=… is a live authorization code and a
    // signed state JWT; drop the query entirely rather than per-parameter
    // (security audit 2026-07-20).
    ...(request.url !== undefined ? { url: request.url.split("?")[0] } : {}),
    ...(request.query_string !== undefined ? { query_string: undefined } : {}),
    ...(headers !== undefined ? { headers } : {}),
    // requestDataIntegration stores a PARSED cookie object beside the header.
    // Dropping only the header left `cookies.sid` on the wire.
    ...(request.cookies !== undefined ? { cookies: undefined } : {}),
    data,
  };
}

/** The fields both event types carry — see ScrubbableEventCommon. */
function scrubEventCommon<T extends ScrubbableEventCommon>(event: T): T {
  return {
    ...event,
    ...(event.message !== undefined ? { message: redactCredentials(event.message) } : {}),
    ...(event.request !== undefined ? { request: scrubRequest(event.request) } : {}),
    ...(event.breadcrumbs !== undefined
      ? { breadcrumbs: event.breadcrumbs.map(scrubSentryBreadcrumb) }
      : {}),
    ...(event.extra !== undefined ? { extra: scrubBag(event.extra) } : {}),
    // perf-monitor.ts tags a span with `request.routeOptions?.url || request.url`,
    // so a raw URL with its query can land in a tag when no route template
    // matched.
    ...(event.tags !== undefined ? { tags: scrubBag(event.tags) } : {}),
    ...(event.contexts !== undefined
      ? { contexts: scrubBag(event.contexts as Record<string, unknown>) }
      : {}),
  } as T;
}

/**
 * `beforeSendTransaction` — the trace context, every child span, and the
 * shared fields `beforeSend` never sees on this event type.
 */
export function scrubSentryTransaction<T extends ScrubbableTransaction>(event: T): T {
  return {
    ...scrubEventCommon(event),
    ...(event.spans !== undefined ? { spans: event.spans.map(scrubSentrySpan) } : {}),
  } as T;
}

/**
 * `beforeSend` — the shared fields, plus the exception text a provider echoed
 * the request URL into.
 */
export function scrubSentryErrorEvent<T extends ScrubbableErrorEvent>(event: T): T {
  return {
    ...scrubEventCommon(event),
    ...(event.exception?.values !== undefined
      ? {
          exception: {
            ...event.exception,
            values: event.exception.values.map((entry) =>
              entry.value !== undefined
                ? { ...entry, value: redactCredentials(entry.value) }
                : entry,
            ),
          },
        }
      : {}),
  } as T;
}
