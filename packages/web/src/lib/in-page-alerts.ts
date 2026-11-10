// OS notifications an open browser tab shows itself (not the Tauri shell).
//
// The tab receives every real-time `notification` frame, but only frames the
// server tagged `alert: "push" | "meeting"` are interrupts. The server sets
// that tag only when the user's category opt-out and quiet hours allow it
// (packages/api notify/desktop-alert.ts, the gate Web Push uses). Every other
// frame (QUEUE mail, agent notes, briefings) only updates the bell.
//
// When this browser holds a push subscription, the service worker shows the
// same interrupt from Web Push, so the tab stays quiet; that skip is the
// dedupe. Both also use notificationTag(id) as the OS tag: open tabs without a
// subscription collapse to one notification per row, and a failed
// subscription lookup (the tab shows too) gets the same tag as the service
// worker's. public/sw.js builds the same tag; the shared shape is pinned by
// packages/api/src/__tests__/web-sw-notification-tag.test.ts.
//
// Pure functions over plain inputs, unit-tested without a browser
// (packages/api/src/__tests__/web-in-page-alerts.test.ts).

import { parseDesktopAlert } from "./native/desktop-alerts";

/** Prefix of the OS tag for one bell notification. public/sw.js repeats it. */
export const NOTIFICATION_TAG_PREFIX = "klorn-notification:";

const ICON = "/icon-192.png";

export type NotificationPermissionState = "granted" | "denied" | "default" | "unsupported";

export interface InPageAlertContext {
  /** Inside the Windows shell, which banners tagged frames itself. */
  isTauri: boolean;
  permission: NotificationPermissionState;
  /** This browser holds a Web Push subscription, so the service worker
   *  shows the interrupt. */
  hasPushSubscription: boolean;
}

export interface InPageAlertPlan {
  title: string;
  options: { body: string; icon: string; tag: string; requireInteraction: boolean };
}

/** The OS tag for a bell notification, shared by the tab and the service worker. */
export function notificationTag(notificationId: string): string {
  return `${NOTIFICATION_TAG_PREFIX}${notificationId}`;
}

/** The in-page notification for one real-time frame, or null when the tab
 *  must stay quiet. Never throws on malformed input. */
export function planInPageNotification(
  payload: unknown,
  ctx: InPageAlertContext,
): InPageAlertPlan | null {
  // The Windows shell banners tagged frames itself (native/tauri-notify.ts),
  // and its notification plugin replaces window.Notification.
  if (ctx.isTauri) return null;
  if (ctx.permission !== "granted") return null;
  // Validates the server's tag and shapes the text the same way the shell does.
  const alert = parseDesktopAlert(payload);
  if (!alert) return null;
  if (ctx.hasPushSubscription) return null;
  return {
    title: alert.title,
    options: {
      body: alert.body,
      icon: ICON,
      tag: notificationTag(alert.id),
      requireInteraction: true,
    },
  };
}
