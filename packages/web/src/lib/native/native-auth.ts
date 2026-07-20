// Native Google sign-in for the Capacitor shell.
//
// Google blocks OAuth inside embedded WebViews (RFC 8252 "disallowed_useragent"),
// so we open the SYSTEM browser. Two flows deliver the resulting session:
//
//   • RELAY (preferred — closes login-CSRF) — the server redirects the browser to
//     a custom app scheme `<scheme>://oauth-callback?code=…`; the OS routes that
//     deep link to THIS app on THIS device, and we exchange the one-time code for
//     the JWT. The token can only reach the app on the device that completed
//     OAuth, so an attacker who parks a login against a nonce they chose never
//     receives it. Enabled once the native scheme is registered (AndroidManifest
//     / iOS Info.plist CFBundleURLTypes) and NEXT_PUBLIC_NATIVE_OAUTH_SCHEME is set.
//
//   • POLL (fallback — PKCE) — the original nonce-poll flow. The verifier stays
//     on-device and gates token retrieval, so a passive observer of the nonce
//     cannot pull the JWT — but this flow cannot stop an ACTIVE login-CSRF, which
//     is why RELAY is preferred once the app scheme is registered.
//
// The JWT lands in WebView JS (not native code) and is stored directly, never
// passed through a URL query.

import { API_BASE, setStoredAuthToken } from "../api";

const POLL_INTERVAL_MS = 1500;
const MAX_POLLS = 120; // 3 min, well within the server's 10-min nonce window
const RELAY_TIMEOUT_MS = 3 * 60_000; // match the poll window
const NATIVE_OAUTH_SCHEME = process.env.NEXT_PUBLIC_NATIVE_OAUTH_SCHEME;

// Re-entrancy guard: a double-tap must not start two flows (and, on the relay
// path, register two appUrlOpen listeners racing for the same code).
let loginInFlight = false;

export async function startNativeGoogleLogin(): Promise<void> {
  if (loginInFlight) return;
  loginInFlight = true;
  try {
    if (NATIVE_OAUTH_SCHEME) {
      await startRelayLogin(NATIVE_OAUTH_SCHEME);
    } else {
      await startPollLogin();
    }
  } finally {
    loginInFlight = false;
  }
}

// ─── RELAY (deep-link) ───────────────────────────────────────────────────────

async function startRelayLogin(scheme: string): Promise<void> {
  const { Browser } = await import("@capacitor/browser");
  const { App } = await import("@capacitor/app");

  // A nonce is still required to enter the desktop flow. The relay never polls
  // it (the JWT arrives via the deep link), so the verifier is unused here — but
  // /desktop-nonce now requires a PKCE challenge on every mint (security audit
  // 2026-07-20, G4), so we send one anyway. It costs nothing and keeps a single
  // server contract for both relay and poll paths.
  const relayVerifier = generateVerifier();
  const relayChallenge = await sha256Base64Url(relayVerifier);
  const nonce = await fetchNonce(relayChallenge);

  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const timer = setTimeout(
    () => rejectCode(new Error("Timed out waiting for Google sign-in")),
    RELAY_TIMEOUT_MS,
  );
  const handle = await App.addListener("appUrlOpen", (event) => {
    try {
      const code = new URL(event.url).searchParams.get("code");
      if (code) resolveCode(code);
    } catch {
      // Not our deep link — ignore.
    }
  });

  const loginUrl =
    `${API_BASE}/api/auth/google/login?source=desktop` +
    `&nonce=${encodeURIComponent(nonce)}&appScheme=${encodeURIComponent(scheme)}`;
  await Browser.open({ url: loginUrl });

  try {
    const code = await codePromise;
    const token = await exchangeCode(code);
    setStoredAuthToken(token);
    // Hard navigation so AuthProvider re-bootstraps from the stored token.
    window.location.href = "/inbox";
  } finally {
    clearTimeout(timer);
    await handle.remove().catch(() => {});
    await Browser.close().catch((err) => {
      console.warn("[AUTH] Browser.close() failed (harmless):", err);
    });
  }
}

async function exchangeCode(code: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/auth/exchange-code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error(`exchange-code failed: ${res.status}`);
  const { token } = (await res.json()) as { token?: string };
  if (!token) throw new Error("exchange-code returned no token");
  return token;
}

// ─── POLL (PKCE fallback) ────────────────────────────────────────────────────

async function startPollLogin(): Promise<void> {
  const { Browser } = await import("@capacitor/browser");

  // PKCE: the verifier stays on-device and is presented (as a header) only when
  // polling for the token. The nonce leaks into the system browser's URL/history,
  // but without the verifier an observer of the nonce cannot retrieve the JWT.
  const verifier = generateVerifier();
  const challenge = await sha256Base64Url(verifier);
  const nonce = await fetchNonce(challenge);
  const loginUrl = `${API_BASE}/api/auth/google/login?source=desktop&nonce=${encodeURIComponent(nonce)}`;
  await Browser.open({ url: loginUrl });

  try {
    const token = await pollForToken(nonce, verifier);
    setStoredAuthToken(token);
    window.location.href = "/inbox";
  } finally {
    await Browser.close().catch((err) => {
      console.warn("[AUTH] Browser.close() failed (harmless):", err);
    });
  }
}

async function fetchNonce(challenge?: string): Promise<string> {
  const url = challenge
    ? `${API_BASE}/api/auth/desktop-nonce?challenge=${encodeURIComponent(challenge)}`
    : `${API_BASE}/api/auth/desktop-nonce`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`desktop-nonce failed: ${res.status}`);
  const { nonce } = (await res.json()) as { nonce?: string };
  if (!nonce) throw new Error("desktop-nonce returned no nonce");
  return nonce;
}

async function pollForToken(nonce: string, verifier: string): Promise<string> {
  const url = `${API_BASE}/api/auth/desktop-token/${encodeURIComponent(nonce)}`;
  // Verifier goes in a header, not the URL, so it never lands in a request log.
  const init: RequestInit = { headers: { "x-desktop-verifier": verifier } };
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);
    const res = await fetch(url, init);
    if (res.status === 202) continue; // pending — user hasn't finished login
    if (res.status === 404) throw new Error("Sign-in session not found");
    if (res.status === 410) throw new Error("Sign-in session expired");
    if (res.status === 403) throw new Error("Sign-in verification failed");
    if (!res.ok) throw new Error(`desktop-token failed: ${res.status}`);
    const data = (await res.json()) as { status?: string; token?: string };
    if (data.status === "ok" && data.token) return data.token;
  }
  throw new Error("Timed out waiting for Google sign-in");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 32-byte random PKCE verifier as a hex string, kept on-device. */
function generateVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of the input as unpadded base64url — matches Node's digest("base64url"). */
async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  let binary = "";
  for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
