/**
 * What goes on the wire to POST /api/playground/classify, and what comes back
 * when it refuses. Pure and framework-free so the rules are unit-tested
 * (packages/api/src/__tests__/web-playground-key-free.test.ts) rather than
 * inferred from the hook that uses them.
 *
 * Two modes, because the server has two paths (routes/playground.ts):
 *
 *   demo  No `apiKey` at all. The server answers on its own account, with the
 *         model pinned to JUDGE_MODEL and the visitor's provider/model fields
 *         ignored — so this mode must not send them. Guarded by a per-IP cap
 *         (3/min, 10/UTC-day), a global daily budget, and the
 *         PLAYGROUND_NO_KEY_DEMO_ENABLED flag, each of which refuses with a
 *         code this module maps.
 *   byok  The visitor's own key, used in-memory for one call and never stored
 *         server-side. Unchanged by #1686.
 */

import type { PlaygroundProvider } from "./models";

export interface ClassifyDraft {
  from: string;
  subject: string;
  body: string;
}

export interface ByokChoice {
  provider: PlaygroundProvider;
  apiKey: string;
  model: string;
}

/**
 * Making the key part of the `byok` arm — rather than an optional field — is
 * what keeps #1686 from coming back: a demo request cannot carry a key, and a
 * BYOK request cannot forget one, because neither shape typechecks.
 */
export type ClassifyRequest = ClassifyDraft & ({ mode: "demo" } | ({ mode: "byok" } & ByokChoice));

/** Exactly the fields the route's schema accepts (`additionalProperties: false`). */
export interface ClassifyWireBody {
  from: string;
  subject: string;
  snippet?: string;
  provider?: PlaygroundProvider;
  apiKey?: string;
  model?: string;
}

export function classifyRequestBody(request: ClassifyRequest): ClassifyWireBody {
  const body: ClassifyWireBody = {
    from: request.from.trim(),
    subject: request.subject.trim(),
    snippet: request.body.trim() || undefined,
  };
  if (request.mode === "demo") return body;
  return {
    ...body,
    provider: request.provider,
    apiKey: request.apiKey.trim(),
    model: request.model.trim() || undefined,
  };
}

export interface WireError {
  /** An i18n key — the server's own English message is never shown. */
  key: string;
  /** Upstream provider detail, already key-scrubbed server-side. */
  detail?: string;
  /**
   * The free path cannot answer this one today, so a key is the only way
   * through and the page opens the BYOK fields. Deliberately NOT set on the
   * refusals whose own copy says "try again in a minute": switching the form
   * to BYOK would make that advice impossible to follow, because the next
   * click would ask for a key instead of retrying.
   */
  revealByok?: true;
}

/** Upstream detail is shown verbatim; cap it. */
const DETAIL_MAX = 300;

/** The route's schema sets `apiKey` minLength 8; mirror it rather than guess. */
export const API_KEY_MIN_LENGTH = 8;

/**
 * The demo path's refusal codes, each with the copy that tells the truth about
 * it, and whether the free path can still answer a retry.
 */
const DEMO_REFUSALS: Record<string, { key: string; terminal: boolean }> = {
  key_required: { key: "playground.error.demoOff", terminal: true },
  demo_budget_exhausted: { key: "playground.error.demoBudget", terminal: true },
  demo_rate_limited: { key: "playground.error.demoRateLimited", terminal: false },
};

export function classifyErrorFor(
  status: number,
  data: unknown,
  mode: ClassifyRequest["mode"],
): WireError {
  const payload = (data && typeof data === "object" ? data : {}) as {
    error?: unknown;
    detail?: unknown;
    byokAvailable?: unknown;
  };
  const code = typeof payload.error === "string" ? payload.error : undefined;

  // hasOwn, not a bare index: `error` is a server-supplied string, and a plain
  // object answers "constructor" with a function that would render as the key.
  if (code && Object.hasOwn(DEMO_REFUSALS, code)) {
    const refusal = DEMO_REFUSALS[code];
    return refusal.terminal ? { key: refusal.key, revealByok: true } : { key: refusal.key };
  }

  // The route limiter (8/min) answers through the error handler as
  // `{ error: "Rate limit exceeded, retry in …" }` — none of our codes. It is a
  // wait, in either mode, and a key is not what gets you past it.
  if (status === 429) return { key: "playground.error.rateLimited" };
  if (status === 400) return { key: "playground.error.invalid" };

  const detail =
    typeof payload.detail === "string" ? payload.detail.slice(0, DETAIL_MAX) : undefined;
  // Everything left is a failure, and in demo mode it is never the visitor's
  // key: they have not given one. That covers the demo path's own 502s (marked
  // with byokAvailable) and the failures that never reach it — a Fastify 500
  // (`{ error: "Internal server error" }`), a gateway 5xx with an HTML body, a
  // malformed 200. The BYOK copy blames a key, so it must not be shown here.
  if (mode === "demo" || payload.byokAvailable === true) {
    return { key: "playground.error.demoFailed" };
  }
  return { key: "playground.error.failed", detail };
}
