function resolveApiBase(): string {
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
  if (typeof window !== "undefined") {
    return `http://${window.location.hostname || "localhost"}:8000`;
  }
  return "http://localhost:8000";
}

export const API_BASE = resolveApiBase();

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("eve-token");
}

// 401 on these endpoints means bad credentials, not session expiry — don't redirect.
const AUTH_ENDPOINTS_NO_REDIRECT = ["/api/auth/login", "/api/auth/register"];

// Module-level flag prevents duplicate redirects when multiple requests fail in parallel.
let isHandling401 = false;

function handleSessionExpired(): void {
  if (isHandling401 || typeof window === "undefined") return;
  isHandling401 = true;
  localStorage.removeItem("eve-token");
  window.location.href = "/login?error=session_expired";
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
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
  const token = getToken();
  const h: Record<string, string> = { "Content-Type": "application/json", ...extra };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}
