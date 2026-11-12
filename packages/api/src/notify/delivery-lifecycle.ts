/**
 * The delivery lifecycle of one notification on one channel — one
 * PushDeliveryLog row per channel attempt.
 *
 *   created          the row exists: Klorn decided to notify on this channel
 *   queued           the attempt was handed to its transport (queuedAt)
 *   sent             the provider accepted it — web push service, FCM, APNs,
 *                    Telegram (acceptedAt)
 *   device_received  the device reported it: the service worker's "received"
 *                    receipt, a desktop app's "shown" (receivedAt)
 *   opened           the person clicked the notification (clickedAt)
 *   actioned         the person used an action button — Reply, Later
 *                    (actionedAt)
 *
 * The state is the furthest stage a timestamp proves. Nothing is inferred
 * forward: a sent push is never counted as received. The one entailment
 * recorded is backward — a click stamps device_received too, because a
 * notification that was clicked was on the device.
 *
 * Which stages a channel can reach:
 *   web              created → … → actioned (service worker receipts)
 *   fcm / apns       created → sent (the mobile app reports no receipt yet)
 *   telegram         created → sent
 *   desktop_*        device_received → … (the app's own receipts; no server
 *                    send is observed, so those rows start at device_received)
 *
 * FAILED / SKIPPED (the row's status) are outcomes beside the stages, not
 * stages: a failed attempt can still have reached queued.
 */

import type { DesktopApp } from "./alert-endpoints.js";

export const DELIVERY_CHANNELS = [
  "web",
  "fcm",
  "apns",
  "telegram",
  "desktop_mac",
  "desktop_windows",
] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

export const DESKTOP_CHANNELS = ["desktop_mac", "desktop_windows"] as const;

export const DELIVERY_STATES = [
  "created",
  "queued",
  "sent",
  "device_received",
  "opened",
  "actioned",
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

/** The notification action buttons Klorn sends (decision N1). */
export const RECEIPT_ACTIONS = ["reply", "later"] as const;
export type ReceiptAction = (typeof RECEIPT_ACTIONS)[number];

/**
 * Status of a desktop row: it exists because the device reported it, not
 * because the server saw a send (there is no provider between the desktop app
 * and Klorn's own sync).
 */
export const REPORTED_STATUS = "REPORTED";

export interface LifecycleTimestamps {
  queuedAt: Date | null;
  acceptedAt: Date | null;
  receivedAt: Date | null;
  clickedAt: Date | null;
  actionedAt: Date | null;
}

export function deliveryState(row: LifecycleTimestamps): DeliveryState {
  if (row.actionedAt) return "actioned";
  if (row.clickedAt) return "opened";
  if (row.receivedAt) return "device_received";
  if (row.acceptedAt) return "sent";
  if (row.queuedAt) return "queued";
  return "created";
}

export function desktopChannel(app: DesktopApp): DeliveryChannel {
  return app === "windows" ? "desktop_windows" : "desktop_mac";
}

export function isReceiptAction(value: unknown): value is ReceiptAction {
  return typeof value === "string" && (RECEIPT_ACTIONS as readonly string[]).includes(value);
}
