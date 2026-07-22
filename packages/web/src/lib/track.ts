import { apiFetch } from "./api";

/**
 * Fire a first-party product-analytics event (Phase 1 retention instrumentation).
 * Fire-and-forget: never throws, never blocks UX. The server allowlists the
 * event name; this is our own endpoint, not a third-party tracker, so nothing
 * leaves Klorn's backend. Only coarse event names + tiny primitive meta — never
 * message content.
 *
 * Allowlisted client events: "app_open" | "queue_action" | "notif_muted" | "push_opened".
 */
export function track(
  event: "app_open" | "queue_action" | "notif_muted" | "push_opened",
  meta?: Record<string, string | number | boolean>,
): void {
  void apiFetch("/api/analytics/event", {
    method: "POST",
    body: JSON.stringify({ event, meta }),
  }).catch(() => {
    // Analytics is best-effort — a dropped event must never surface to the user.
  });
}

/**
 * Fire `app_open` at most once per browser session (per tab/app launch), so
 * DAU counts unique daily openers, not every client-side route change.
 */
export function trackAppOpenOnce(): void {
  if (typeof window === "undefined") return;
  try {
    if (window.sessionStorage.getItem("klorn_app_open_fired") === "1") return;
    window.sessionStorage.setItem("klorn_app_open_fired", "1");
  } catch {
    // sessionStorage blocked (private mode) — fire anyway rather than lose the signal.
  }
  track("app_open");
}
