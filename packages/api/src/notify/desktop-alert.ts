/**
 * The `alert` tag on a real-time `notification` frame.
 *
 * The Windows desktop shell (apps/desktop-win) cannot rely on Web Push inside
 * WebView2, so it turns real-time frames into OS banners — but only frames
 * the server tags here: PUSH-lane mail ("push") and a meeting starting soon
 * ("meeting"). An open browser tab without a Web Push subscription does the
 * same (packages/web lib/in-page-alerts.ts). The tag follows the same gate Web
 * Push uses (category opt-out + quiet hours, notification-prefs.ts), so a
 * desktop banner never fires where a web push would have been suppressed. The
 * bell row itself is unaffected.
 *
 * "push" covers MEETING-lane mail too: judge/firewall-push.ts rings PUSH and
 * MEETING mail through the same deliverFirewallPush, under "email_urgent".
 *
 * The native Mac app polls instead of reading these frames, so it asks for the
 * same verdict directly: `desktopAlertState`, served as
 * GET /api/notifications/alert-state.
 */

import type { DesktopAlertKind } from "@klorn/contract";
import {
  evaluateNotificationGate,
  type NotifCategory,
  type NotificationGateResult,
} from "./notification-prefs.js";

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

/** Whether each desktop banner kind may interrupt the user right now. */
export type DesktopAlertState = Record<DesktopAlertKind, NotificationGateResult>;

/** The gate `desktopAlertTag` applies, for every kind at one instant, with the
 *  reason when held. Unlike the tag it does not swallow a lookup error: the
 *  caller picks the fallback (the Mac posts anyway — fail-open). */
export async function desktopAlertState(
  userId: string,
  now: Date = new Date(),
): Promise<DesktopAlertState> {
  const [push, meeting] = await Promise.all([
    evaluateNotificationGate(userId, CATEGORY.push, now),
    evaluateNotificationGate(userId, CATEGORY.meeting, now),
  ]);
  return { push, meeting };
}
