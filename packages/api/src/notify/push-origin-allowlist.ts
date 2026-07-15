/**
 * Allowlist of web origins permitted to register a push subscription.
 *
 * Each PushSubscription row stores the origin where its service worker is
 * registered. We refuse to register — and refuse to push to — subscriptions
 * whose origin is not in this list. This prevents the 2026-05-22 incident
 * where the retired hire-eve-web.vercel.app SW kept receiving daily briefing
 * pushes and opening a now-404 deployment on click.
 *
 * Configure with PUSH_ALLOWED_ORIGINS as a comma-separated list. Falls back
 * to WEB_URL (single origin) and then to localhost for dev.
 */

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

function normalize(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    // URL drops trailing path/query — origin is protocol + host[+port].
    return url.origin;
  } catch {
    return null;
  }
}

function loadAllowlist(): Set<string> {
  const explicit = parseList(process.env.PUSH_ALLOWED_ORIGINS);
  const webUrl = process.env.WEB_URL ? [process.env.WEB_URL] : [];
  const devFallback =
    process.env.NODE_ENV === "production" ? [] : ["http://localhost:8001", "http://127.0.0.1:8001"];

  const raw = explicit.length > 0 ? explicit : [...webUrl, ...devFallback];
  const normalized = new Set<string>();
  for (const o of raw) {
    const n = normalize(o);
    if (n) normalized.add(n);
  }
  return normalized;
}

// Cached at module load. Tests that need to override should re-import via
// vi.resetModules() after mutating process.env.
const ALLOWED_ORIGINS = loadAllowlist();

export function isAllowedPushOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  const normalized = normalize(origin);
  if (!normalized) return false;
  return ALLOWED_ORIGINS.has(normalized);
}

export function getAllowedPushOrigins(): string[] {
  return Array.from(ALLOWED_ORIGINS);
}
