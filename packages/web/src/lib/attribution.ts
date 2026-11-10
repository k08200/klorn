/**
 * First-touch inflow attribution for the early-access funnel.
 *
 * The landing site (klorn.ai) decorates its app.klorn.ai links with utm_*,
 * `ref` (referrer hostname) and `lp` (landing path); this side persists the
 * FIRST set it ever sees so a later direct revisit cannot overwrite the
 * channel that actually brought the person in. Best-effort by design: storage
 * failures or stripped params must never affect the signup itself.
 * No PII — params and hostnames only.
 */

const STORAGE_KEY = "klorn.attr";
const PART_MAX = 60;
const TOTAL_MAX = 300;
const KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "ref", "lp"] as const;

/** Capture the current URL/referrer as attribution — first touch wins. */
export function captureFirstTouchAttribution(): void {
  if (typeof window === "undefined") return;
  try {
    if (window.localStorage.getItem(STORAGE_KEY)) return;
    const params = new URLSearchParams(window.location.search);
    const parts: string[] = [];
    for (const key of KEYS) {
      const value = params.get(key);
      if (value) parts.push(`${key}=${value.slice(0, PART_MAX)}`);
    }
    if (!params.get("ref") && document.referrer) {
      try {
        const host = new URL(document.referrer).hostname;
        if (host && host !== window.location.hostname) parts.push(`ref=${host}`);
      } catch {
        // Malformed referrer — skip, never block.
      }
    }
    if (!params.get("lp")) {
      parts.push(`lp=${window.location.pathname.slice(0, PART_MAX)}`);
    }
    window.localStorage.setItem(STORAGE_KEY, parts.join(" ").slice(0, TOTAL_MAX));
  } catch {
    // Storage disabled (private mode) — attribution is best-effort.
  }
}

/** The stored first-touch attribution, or null when none/unavailable. */
export function storedAttribution(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}
