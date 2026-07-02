import { isNativePlatform } from "./native/capacitor";

// Keep SSR and client in sync: both must resolve to the same string so React
// hydration does not mismatch (e.g. an <a href> rendered on the server must
// equal the one rendered on the client). The previous SSR fallback was
// http://localhost:8000 while the client used :3001, which produced visible
// hydration warnings and broken Google OAuth links in local dev.
function resolveApiBase(): string {
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
  if (typeof window !== "undefined") {
    return `http://${window.location.hostname || "localhost"}:3001`;
  }
  return "http://localhost:3001";
}

export const API_BASE = resolveApiBase();

export const AUTH_TOKEN_KEY = "klorn-token";
const LEGACY_KEY_PREFIX = "ev" + "e";
const LEGACY_AUTH_TOKEN_KEY = `${LEGACY_KEY_PREFIX}-token`;

export function getStoredAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (token) return token;
  const legacyToken = localStorage.getItem(LEGACY_AUTH_TOKEN_KEY);
  if (legacyToken) {
    localStorage.setItem(AUTH_TOKEN_KEY, legacyToken);
    localStorage.removeItem(LEGACY_AUTH_TOKEN_KEY);
  }
  return legacyToken;
}

export function setStoredAuthToken(token: string): void {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
  localStorage.removeItem(LEGACY_AUTH_TOKEN_KEY);
  // A fresh session means any in-flight expiry handling is stale. Without this
  // reset, a 401 race during login (or a bfcache restore) leaves the flag stuck
  // at true and every future session expiry is silently ignored.
  isHandling401 = false;
}

export function clearStoredAuthToken(): void {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(LEGACY_AUTH_TOKEN_KEY);
}

// 401 on these endpoints means bad credentials, not session expiry — don't redirect.
const AUTH_ENDPOINTS_NO_REDIRECT = ["/api/auth/login", "/api/auth/register"];

// Module-level flag prevents duplicate redirects when multiple requests fail in parallel.
let isHandling401 = false;

function handleSessionExpired(): void {
  if (isHandling401 || typeof window === "undefined") return;
  isHandling401 = true;
  clearStoredAuthToken();
  const next = `${window.location.pathname}${window.location.search}`;
  const nextParam = next && next !== "/login" ? `&next=${encodeURIComponent(next)}` : "";
  window.location.href = `/login?error=session_expired${nextParam}`;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getStoredAuthToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string>),
  };
  if (token && !headers.Authorization) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });

  if (res.status === 401 && token && !AUTH_ENDPOINTS_NO_REDIRECT.some((p) => path.startsWith(p))) {
    handleSessionExpired();
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

/** Raw fetch with auth token — for SSE streaming endpoints */
export function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = getStoredAuthToken();
  const h: Record<string, string> = { "Content-Type": "application/json", ...extra };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

// Start the Gmail/Calendar OAuth flow without leaking the user's JWT into the
// URL. Calls the header-authed start endpoint, then navigates to the returned
// Google URL. Throws if there is no session or the API rejects.
export async function startGoogleConnect(): Promise<void> {
  const { url } = await apiFetch<{ url: string }>("/api/auth/google/start", {
    method: "POST",
  });
  if (typeof window !== "undefined") {
    window.location.href = url;
  }
}

// Open a Google OAuth URL the right way for the platform. The authenticated POST
// that mints this URL already ran in the WebView (carrying the JWT) and baked the
// userId into a signed state, so the URL itself needs no app session — we just
// have to open it where Google ALLOWS OAuth. In the native shell that means the
// SYSTEM browser: Google blocks OAuth inside embedded WebViews (RFC 8252
// "disallowed_useragent"), which is why an in-WebView window.location bounced the
// user back to the app login. On the web, a normal navigation is correct.
async function openOAuthUrl(url: string): Promise<void> {
  if (isNativePlatform()) {
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url });
    return;
  }
  if (typeof window !== "undefined") {
    window.location.href = url;
  }
}

// Start the OAuth flow to link a SECONDARY Google account for calendar
// free/busy only (Pro-gated on the server). Throws (e.g. 403) if the API rejects.
export async function startLinkCalendar(): Promise<void> {
  const { url } = await apiFetch<{ url: string }>("/api/auth/google/link-calendar", {
    method: "POST",
  });
  await openOAuthUrl(url);
}

/** Kick off the OAuth flow to link a secondary Google inbox (Pro feature). */
export async function startLinkInbox(): Promise<void> {
  const { url } = await apiFetch<{ url: string }>("/api/auth/google/link-inbox", {
    method: "POST",
  });
  await openOAuthUrl(url);
}
