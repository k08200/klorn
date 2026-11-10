/**
 * Google / Apple sign-in through the SYSTEM browser (RFC 8252 — Google refuses
 * OAuth inside a WebView). Reuses the server's desktop flow unchanged:
 *
 *   1. GET /api/auth/desktop-nonce?challenge=<PKCE S256>   → nonce
 *   2. open /api/auth/<provider>/login?source=desktop&nonce=…&appScheme=ai.klorn.app
 *   3a. NATIVE — RELAY: the callback hands the browser to
 *       ai.klorn.app://oauth-callback?code=<one-time>; the OS delivers that
 *       only to this app on this device (closes login-CSRF, OAUTH_RELAY.md);
 *       POST /api/auth/exchange-code → JWT.
 *   3b. BROWSER (dev only) — POLL: GET /api/auth/desktop-token/:nonce with the
 *       PKCE verifier header until the JWT is parked.
 *
 * Apple uses the same desktop leg (routes/social-auth.ts), so no native
 * Sign in with Apple plugin is needed; the button appears only when
 * GET /api/auth/providers lists "apple" (APPLE_LOGIN_ENABLED on the API).
 * The JWT is returned to the caller, which stores it in the Keychain/Keystore.
 */
import { App } from "@capacitor/app";
import type { Endpoints } from "../api/endpoints";
import { NATIVE_OAUTH_SCHEME } from "../config";
import { isNative } from "../platform/native";
import { generateVerifier, sha256Base64Url } from "./pkce";

export type SocialProvider = "google" | "apple";

export class OAuthError extends Error {
  readonly reason: "timeout" | "cancelled" | "failed";
  constructor(reason: "timeout" | "cancelled" | "failed", message: string) {
    super(message);
    this.name = "OAuthError";
    this.reason = reason;
  }
}

const TIMEOUT_MS = 3 * 60_000; // matches the server's nonce window (10 min) with margin
const POLL_INTERVAL_MS = 1500;
/** After the user closes the browser, how long a late deep link may still arrive. */
const CLOSE_GRACE_MS = 2500;

/** The one-time code from `ai.klorn.app://oauth-callback?code=…`, or null for any other URL. */
export function parseOAuthCallback(url: string, scheme = NATIVE_OAUTH_SCHEME): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${scheme}:`) return null;
  // Non-special schemes keep "oauth-callback" as host; be lenient about a path form too.
  const target = parsed.host || parsed.pathname.replace(/^\/+/, "");
  if (target !== "oauth-callback") return null;
  const code = parsed.searchParams.get("code");
  return code && /^[A-Za-z0-9_-]{8,256}$/.test(code) ? code : null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new OAuthError("cancelled", "Sign-in cancelled"));
      },
      { once: true },
    );
  });
}

let inFlight = false;

export async function startSocialLogin(
  provider: SocialProvider,
  ep: Endpoints,
  signal?: AbortSignal,
): Promise<string> {
  if (inFlight) throw new OAuthError("failed", "A sign-in is already in progress");
  inFlight = true;
  try {
    const verifier = generateVerifier();
    const challenge = await sha256Base64Url(verifier);
    const { nonce } = await ep.auth.desktopNonce(challenge);
    return isNative()
      ? await relayLogin(provider, ep, nonce, signal)
      : await pollLogin(provider, ep, nonce, verifier, signal);
  } finally {
    inFlight = false;
  }
}

async function relayLogin(
  provider: SocialProvider,
  ep: Endpoints,
  nonce: string,
  signal?: AbortSignal,
): Promise<string> {
  const { Browser } = await import("@capacitor/browser");
  let settle: { resolve(code: string): void; reject(err: Error): void } | null = null;
  const codePromise = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const timer = setTimeout(
    () => settle?.reject(new OAuthError("timeout", "Timed out waiting for sign-in")),
    TIMEOUT_MS,
  );
  const onAbort = () => settle?.reject(new OAuthError("cancelled", "Sign-in cancelled"));
  signal?.addEventListener("abort", onAbort, { once: true });

  const urlHandle = await App.addListener("appUrlOpen", (event) => {
    const code = parseOAuthCallback(event.url);
    if (code) settle?.resolve(code);
  });
  const closeHandle = await Browser.addListener("browserFinished", () => {
    setTimeout(
      () => settle?.reject(new OAuthError("cancelled", "Browser closed before sign-in finished")),
      CLOSE_GRACE_MS,
    );
  });

  try {
    await Browser.open({ url: ep.auth.socialLoginUrl(provider, nonce, NATIVE_OAUTH_SCHEME) });
    const code = await codePromise;
    const { token } = await ep.auth.exchangeCode(code);
    if (!token) throw new OAuthError("failed", "exchange-code returned no token");
    return token;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    await urlHandle.remove().catch(() => {});
    await closeHandle.remove().catch(() => {});
    await Browser.close().catch(() => {});
  }
}

async function pollLogin(
  provider: SocialProvider,
  ep: Endpoints,
  nonce: string,
  verifier: string,
  signal?: AbortSignal,
): Promise<string> {
  const popup = window.open(ep.auth.socialLoginUrl(provider, nonce), "_blank", "noopener");
  const deadline = Date.now() + TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS, signal);
      const result = await ep.auth.desktopToken(nonce, verifier);
      if (result.status === "ok") return result.token;
    }
    throw new OAuthError("timeout", "Timed out waiting for sign-in");
  } finally {
    popup?.close();
  }
}
