// Native Google sign-in for the Capacitor shell.
//
// Google blocks OAuth inside embedded WebViews (RFC 8252 "disallowed_useragent"),
// so we cannot run the normal inline web flow. Instead we reuse the server's
// existing nonce-poll flow (built for the desktop app):
//   1. GET /api/auth/desktop-nonce  → server-issued nonce
//   2. open the SYSTEM browser at /google/login?source=desktop&nonce=…
//   3. poll /api/auth/desktop-token/:nonce until the JWT is issued
//   4. write the JWT straight to localStorage and hard-navigate to /inbox so
//      AuthProvider bootstraps from the stored token.
//
// The JWT lands in WebView JS (not native code). We store it directly rather
// than passing it via a URL query — a URL token would persist in WebView
// history and any request logs.

import { API_BASE, setStoredAuthToken } from "../api";

const POLL_INTERVAL_MS = 1500;
const MAX_POLLS = 120; // 3 min, well within the server's 10-min nonce window

export async function startNativeGoogleLogin(): Promise<void> {
  const { Browser } = await import("@capacitor/browser");

  const nonce = await fetchNonce();
  const loginUrl = `${API_BASE}/api/auth/google/login?source=desktop&nonce=${encodeURIComponent(nonce)}`;
  await Browser.open({ url: loginUrl });

  try {
    const token = await pollForToken(nonce);
    setStoredAuthToken(token);
    // Hard navigation (not a router push) so AuthProvider re-bootstraps from the
    // freshly stored token.
    window.location.href = "/inbox";
  } finally {
    // Close the system browser on EVERY path (success, timeout, 404/410) so the
    // user is never left on a hung custom tab. Auto-closed on some platforms, so
    // a failed close is harmless — but log a signal rather than swallow silently.
    await Browser.close().catch((err) => {
      console.warn("[AUTH] Browser.close() failed (harmless):", err);
    });
  }
}

async function fetchNonce(): Promise<string> {
  const res = await fetch(`${API_BASE}/api/auth/desktop-nonce`);
  if (!res.ok) throw new Error(`desktop-nonce failed: ${res.status}`);
  const { nonce } = (await res.json()) as { nonce?: string };
  if (!nonce) throw new Error("desktop-nonce returned no nonce");
  return nonce;
}

async function pollForToken(nonce: string): Promise<string> {
  const url = `${API_BASE}/api/auth/desktop-token/${encodeURIComponent(nonce)}`;
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);
    const res = await fetch(url);
    if (res.status === 202) continue; // pending — user hasn't finished login
    if (res.status === 404) throw new Error("Sign-in session not found");
    if (res.status === 410) throw new Error("Sign-in session expired");
    if (!res.ok) throw new Error(`desktop-token failed: ${res.status}`);
    const data = (await res.json()) as { status?: string; token?: string };
    if (data.status === "ok" && data.token) return data.token;
  }
  throw new Error("Timed out waiting for Google sign-in");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
