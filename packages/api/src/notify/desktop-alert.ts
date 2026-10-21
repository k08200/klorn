/**
 * The `alert` tag on a real-time `notification` frame.
 *
 * The Windows desktop shell (apps/desktop-win) cannot rely on Web Push inside
 * WebView2, so it turns real-time frames into OS banners — but only frames the
 * server tags here: PUSH-lane mail ("push") and a meeting starting soon
 * ("meeting"). The tag follows the same gate Web Push uses (category opt-out +
 * quiet hours, notification-prefs.ts), so a desktop banner never fires where a
 * web push would have been suppressed. The bell row itself is unaffected.
 */

import type { DesktopAlertKind } from "@klorn/contract";
import { evaluateNotificationGate, type NotifCategory } from "./notification-prefs.js";

const CATEGORY: Record<DesktopAlertKind, NotifCategory> = {
  push: "email_urgent",
  meeting: "meeting",
};

/** `{ alert: kind }` when the user's gate allows the category, else `{}`.
 *  Fails closed: a gate lookup error means no OS banner (the bell row and Web
 *  Push paths are independent and still run). */
export async function desktopAlertTag(
  userId: string,
  kind: DesktopAlertKind,
): Promise<{ alert?: DesktopAlertKind }> {
  try {
    const gate = await evaluateNotificationGate(userId, CATEGORY[kind]);
    return gate.allowed ? { alert: kind } : {};
  } catch (err) {
    console.warn(`[NOTIFY] desktop alert gate failed (${kind}) for user ${userId}:`, err);
    return {};
  }
}
