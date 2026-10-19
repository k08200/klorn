/**
 * Android only: Klorn's own notifications with action buttons
 * (@capacitor/local-notifications), for data-only FCM messages (push/android.ts).
 * iOS keeps its UNNotificationCategory actions (AppDelegate.swift) and never
 * comes here; on the web nothing runs.
 *
 * On Android every action button opens the app (the plugin's actions are
 * activity PendingIntents — a secure lock screen asks to unlock first), and
 * the action then runs in the app: the same snooze / dismiss / deep link as
 * an iOS action (push/PushLayer.tsx).
 */
import { App } from "@capacitor/app";
import {
  type ActionLabels,
  ANDROID_CHANNELS,
  androidActionTypes,
  type DataPush,
} from "../push/android";
import { kv } from "./kv";
import { platformName } from "./native";
import type { IncomingPush } from "./push";

async function plugin() {
  const { LocalNotifications } = await import("@capacitor/local-notifications");
  return LocalNotifications;
}

export function isAndroid(): boolean {
  return platformName() === "android";
}

export interface ChannelLabels extends ActionLabels {
  pushChannel: string;
  pushChannelBody: string;
  otherChannel: string;
}

/**
 * Where the native service (android/.../push/KlornMessagingService.java) reads
 * its button and channel names, so a notification it posts while the app is
 * closed speaks the app language, not only the device's. Same key, same
 * Capacitor Preferences file ("CapacitorStorage") on both sides.
 */
export const NATIVE_LABELS_KEY = "klorn-android-push-labels";

/**
 * Channels (PUSH = importance high) and the action sets, in the app language.
 * Safe to repeat: Android updates a channel's name and description in place
 * and keeps the importance the user chose.
 */
export async function setupAndroidNotifications(labels: ChannelLabels): Promise<void> {
  if (!isAndroid()) return;
  try {
    const ln = await plugin();
    await ln.createChannel({
      id: ANDROID_CHANNELS.push.id,
      name: labels.pushChannel,
      description: labels.pushChannelBody,
      importance: ANDROID_CHANNELS.push.importance,
      visibility: 0, // VISIBILITY_PRIVATE: the lock screen follows the user's "sensitive content" setting
      vibration: true,
    });
    await ln.createChannel({
      id: ANDROID_CHANNELS.other.id,
      name: labels.otherChannel,
      importance: ANDROID_CHANNELS.other.importance,
      visibility: 0,
    });
    await ln.registerActionTypes({ types: androidActionTypes(labels) });
  } catch {
    // Plugin not linked (an old build) — FCM notification messages still show, without actions.
  }
  try {
    await kv.setItem(
      NATIVE_LABELS_KEY,
      JSON.stringify({
        later: labels.later,
        done: labels.done,
        review: labels.review,
        pushChannel: labels.pushChannel,
        otherChannel: labels.otherChannel,
      }),
    );
  } catch {
    // The native side falls back to the device language.
  }
}

export async function appIsActive(): Promise<boolean> {
  try {
    return (await App.getState()).isActive;
  } catch {
    return true;
  }
}

/** Post the notification. Resolves false when notifications are off or the plugin is missing. */
export async function showDataPush(push: DataPush): Promise<boolean> {
  if (!isAndroid()) return false;
  try {
    const ln = await plugin();
    // Never prompt from a background message: the push priming screen asks.
    if ((await ln.checkPermissions()).display !== "granted") return false;
    await ln.schedule({
      notifications: [
        {
          id: push.notificationId,
          title: push.title,
          body: push.body,
          largeBody: push.body,
          channelId: push.channelId,
          actionTypeId: push.category ?? undefined,
          extra: push.data,
          autoCancel: true,
          group: "klorn",
          foreground: push.channelId === ANDROID_CHANNELS.push.id,
        },
      ],
    });
    return true;
  } catch {
    return false;
  }
}

/** Taps and action buttons on the notifications posted above. Returns the unsubscribe. */
export function installLocalNotificationListeners(
  onAction: (actionId: string, push: IncomingPush) => void,
): () => void {
  if (!isAndroid()) return () => {};
  let alive = true;
  let remove: (() => void) | null = null;
  void plugin()
    .then((ln) =>
      ln.addListener("localNotificationActionPerformed", (event) => {
        const n = event.notification;
        onAction(event.actionId, {
          title: n.title ?? "",
          body: n.body ?? "",
          data: (n.extra ?? {}) as Record<string, unknown>,
        });
      }),
    )
    .then((handle) => {
      if (!alive) void handle.remove();
      else remove = () => void handle.remove();
    })
    .catch(() => {});
  return () => {
    alive = false;
    remove?.();
  };
}
