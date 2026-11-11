// Shows an open browser tab's OS notification for one real-time frame. Which
// frames notify is decided by the pure rules in ./in-page-alerts.ts; this file
// is only the side-effecting edge: browser state and the Notification call.

import { type NotificationPermissionState, planInPageNotification } from "./in-page-alerts";
import { shellKind } from "./native/shell";
import { hasPushSubscription } from "./push";

function currentPermission(): NotificationPermissionState {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return window.Notification.permission;
}

/** Notify for a server-tagged PUSH / meeting frame, unless the service worker
 *  will show it from Web Push. No-op inside the Tauri shell. */
export async function deliverInPageAlert(payload: unknown): Promise<void> {
  const base = { isTauri: shellKind() === "tauri", permission: currentPermission() };
  // Most frames are untagged: rule them out before the service-worker lookup.
  if (!planInPageNotification(payload, { ...base, hasPushSubscription: false })) return;
  const plan = planInPageNotification(payload, {
    ...base,
    hasPushSubscription: await hasPushSubscription(),
  });
  if (!plan) return;
  try {
    new window.Notification(plan.title, plan.options);
  } catch (err) {
    // Android Chrome has no page-level Notification constructor.
    console.warn("[IN-PAGE-ALERT] notification failed:", err);
  }
}
