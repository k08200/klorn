/**
 * Native desktop Google sign-in orchestration (pure — no Electron imports).
 *
 * Drives the server's existing browser-bounce + nonce-poll flow
 * (api/src/routes/auth.ts: GET /desktop-nonce, /google/login?source=desktop,
 * /desktop-token/:nonce). Kept Electron-free so it is unit-testable; main.ts
 * supplies the real fetch, OS-browser opener, sleep, clock, and cancel check.
 *
 * Flow:
 *   1. GET /api/auth/desktop-nonce                        → server-issued nonce
 *   2. open /api/auth/google/login?source=desktop&nonce=  in the OS browser —
 *      the user consents there; the callback saves Gmail+Calendar tokens AND
 *      parks the minted JWT under the nonce.
 *   3. poll /api/auth/desktop-token/:nonce                → 202 pending → 200 { token }
 *
 * The single consent in step 2 grants Gmail/Calendar scopes (getLoginAuthUrl),
 * so a successful sign-in leaves the account already connected — there is no
 * second in-window OAuth, and nothing depends on a localhost redirect URI.
 */

export type DesktopLoginFailureReason =
  | "nonce_failed"
  | "invalid_nonce"
  | "expired"
  | "timeout"
  | "cancelled";

export type DesktopLoginResult =
  | { ok: true; token: string }
  | { ok: false; reason: DesktopLoginFailureReason; detail: string };

export interface DesktopLoginDeps {
  /** API origin, e.g. http://localhost:3001 or https://api.klorn.ai. */
  apiBase: string;
  /** Network fetch (injected so tests need no real server). */
  fetchFn: typeof fetch;
  /** Hand the Google login URL to the OS browser. */
  openExternal: (url: string) => void | Promise<void>;
  /** Resolve after `ms` (injected so tests advance time without waiting). */
  sleep: (ms: number) => Promise<void>;
  /** Clock in ms (injected for deterministic timeout tests). */
  now: () => number;
  /** Emit a console signal — even on non-fatal paths (CLAUDE.md: never swallow). */
  log: (message: string) => void;
  /** Cooperative cancel check, polled each loop (e.g. window closed). */
  isCancelled?: () => boolean;
}

// 3 s → 20 polls/min, comfortably under the server's 30/min rate limit on
// /desktop-token (auth.ts) so a long browser flow never trips it.
const POLL_INTERVAL_MS = 3_000;
/** Matches the server nonce TTL (auth.ts: a 10-minute window). */
const MAX_WAIT_MS = 10 * 60 * 1_000;

/** Run the full sign-in flow. Resolves to a discriminated result, never throws. */
export async function runDesktopGoogleLogin(deps: DesktopLoginDeps): Promise<DesktopLoginResult> {
  const nonce = await requestNonce(deps);
  if (!nonce.ok) return nonce.result;

  const loginUrl = `${deps.apiBase}/api/auth/google/login?source=desktop&nonce=${encodeURIComponent(
    nonce.value,
  )}`;
  await deps.openExternal(loginUrl);
  deps.log("[desktop] opened Google sign-in in the browser — waiting for completion");

  return pollForToken(deps, nonce.value);
}

type NonceOutcome = { ok: true; value: string } | { ok: false; result: DesktopLoginResult };

/** Step 1 — obtain a server-issued nonce. Any failure is terminal (no browser opens). */
async function requestNonce(deps: DesktopLoginDeps): Promise<NonceOutcome> {
  try {
    const res = await deps.fetchFn(`${deps.apiBase}/api/auth/desktop-nonce`);
    if (!res.ok) return nonceFailed(deps, `desktop-nonce returned ${res.status}`);
    const body = (await res.json()) as { nonce?: unknown };
    if (typeof body.nonce !== "string" || body.nonce.length === 0) {
      return nonceFailed(deps, "desktop-nonce response had no nonce");
    }
    return { ok: true, value: body.nonce };
  } catch (err) {
    return nonceFailed(deps, err instanceof Error ? err.message : String(err));
  }
}

function nonceFailed(deps: DesktopLoginDeps, detail: string): NonceOutcome {
  deps.log(`[desktop] sign-in could not start — ${detail}`);
  return { ok: false, result: { ok: false, reason: "nonce_failed", detail } };
}

/** Step 3 — poll for the parked JWT until it lands, a terminal status arrives, or we time out. */
async function pollForToken(deps: DesktopLoginDeps, nonce: string): Promise<DesktopLoginResult> {
  const deadline = deps.now() + MAX_WAIT_MS;
  const tokenUrl = `${deps.apiBase}/api/auth/desktop-token/${encodeURIComponent(nonce)}`;

  while (deps.now() < deadline) {
    if (deps.isCancelled?.()) {
      deps.log("[desktop] sign-in cancelled before completion");
      return { ok: false, reason: "cancelled", detail: "cancelled by caller" };
    }

    const step = await pollOnce(deps, tokenUrl);
    if (step.done) return step.result;

    // Re-check before sleeping: the poll can take seconds, and the window may
    // have closed during it — observe cancellation promptly.
    if (deps.isCancelled?.()) {
      deps.log("[desktop] sign-in cancelled before completion");
      return { ok: false, reason: "cancelled", detail: "cancelled by caller" };
    }
    await deps.sleep(POLL_INTERVAL_MS);
  }

  deps.log("[desktop] sign-in timed out waiting for browser completion");
  return { ok: false, reason: "timeout", detail: `no completion within ${MAX_WAIT_MS} ms` };
}

type PollStep = { done: true; result: DesktopLoginResult } | { done: false };

/** One poll of /desktop-token. Network blips and odd statuses are non-fatal (keep waiting). */
async function pollOnce(deps: DesktopLoginDeps, tokenUrl: string): Promise<PollStep> {
  let res: Response;
  try {
    res = await deps.fetchFn(tokenUrl);
  } catch (err) {
    deps.log(`[desktop] poll failed, will retry: ${err instanceof Error ? err.message : err}`);
    return { done: false };
  }

  if (res.status === 200) {
    // A proxy/CDN can return a non-JSON 200 (HTML error page) — treat a parse
    // failure as a transient blip and keep polling rather than crashing the flow.
    let body: { status?: unknown; token?: unknown };
    try {
      body = (await res.json()) as { status?: unknown; token?: unknown };
    } catch {
      deps.log("[desktop] poll got a non-JSON 200 body — retrying");
      return { done: false };
    }
    if (body.status === "ok" && typeof body.token === "string" && body.token.length > 0) {
      return { done: true, result: { ok: true, token: body.token } };
    }
    deps.log("[desktop] poll got 200 without a token — retrying");
    return { done: false };
  }
  if (res.status === 202) return { done: false }; // pending — keep waiting
  if (res.status === 404) {
    return {
      done: true,
      result: { ok: false, reason: "invalid_nonce", detail: "nonce not recognized (404)" },
    };
  }
  if (res.status === 410) {
    return { done: true, result: { ok: false, reason: "expired", detail: "nonce expired (410)" } };
  }
  deps.log(`[desktop] poll got unexpected ${res.status} — retrying`);
  return { done: false };
}
