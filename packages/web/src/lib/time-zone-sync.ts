"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { apiFetch } from "./api";
import { captureClientError } from "./sentry";
import { autoSyncTarget, deviceTimeZone, type TimeZoneMode } from "./time-zone";

/**
 * Re-read the device zone whenever the tab regains focus, so Automatic
 * follows a laptop that changed zones (travel) without a reload.
 */
function subscribeDeviceZone(onChange: () => void): () => void {
  window.addEventListener("focus", onChange);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    window.removeEventListener("focus", onChange);
    document.removeEventListener("visibilitychange", onChange);
  };
}

/** The browser's zone; null during server render and hydration. */
export function useDeviceTimeZone(): string | null {
  return useSyncExternalStore(subscribeDeviceZone, deviceTimeZone, () => null);
}

interface ZoneUser {
  timezone?: string;
  timezoneMode?: TimeZoneMode;
}

/**
 * With no saved choice (Automatic), write the device zone to the account so
 * server-side features — briefings, quiet hours, meeting-soon alerts, digest
 * scheduling — use it too. One attempt per zone per page load; a failure is
 * reported, never retried in a loop. `apply` mirrors the write into the
 * signed-in user held by the auth context.
 */
export function useTimeZoneAutoSync(
  user: ZoneUser | null,
  apply: (zone: string, mode: TimeZoneMode) => void,
): void {
  const deviceZone = useDeviceTimeZone();
  const attempted = useRef<string | null>(null);
  const savedZone = user?.timezone ?? null;
  const mode = user?.timezoneMode;
  const signedIn = user !== null;

  useEffect(() => {
    if (!signedIn) return;
    const target = autoSyncTarget({ mode, savedZone, deviceZone });
    if (!target || attempted.current === target) return;
    attempted.current = target;
    apiFetch("/api/automations", {
      method: "PATCH",
      body: JSON.stringify({ timezone: target, timezoneMode: "AUTO" }),
    })
      .then(() => apply(target, "AUTO"))
      .catch((err) => captureClientError(err, { scope: "timezone.auto-sync" }));
  }, [signedIn, mode, savedZone, deviceZone, apply]);
}
