"use client";

import { useEffect } from "react";
import { authHeaders, getStoredAuthToken } from "../lib/api";
import { probeDeviceCalendars } from "../lib/native/calendar-probe";
import { isNativePlatform } from "../lib/native/capacitor";
import { registerNativePush } from "../lib/native/native-push";
import {
  fetchVapidKey,
  getOrCreatePushSubscription,
  getSwRegistration,
  registerSubscriptionWithServer,
  sendSwConfig,
} from "../lib/push";

export default function PushRegister() {
  useEffect(() => {
    if (!getStoredAuthToken()) return;

    // Native shell: register for FCM/APNs (native push), not Web Push — iOS
    // WKWebView has no usable Web Push and on Android a web subscription would
    // just be a redundant channel.
    if (isNativePlatform()) {
      void registerNativePush();

      // Phase 0 Samsung-calendar probe is a throwaway diagnostic that fires a
      // SECOND OS permission prompt (calendar) alongside push on first launch.
      // Gate it out of production so shipping users don't get a permission
      // prompt for a feature that isn't built yet. Enable with
      // NEXT_PUBLIC_CALENDAR_PROBE=1 (or any non-production build) to run it.
      if (
        process.env.NODE_ENV !== "production" ||
        process.env.NEXT_PUBLIC_CALENDAR_PROBE === "1"
      ) {
        void probeDeviceCalendars();
      } else {
        // Log a signal so the skip is never silent (project reliability rule).
        console.info(
          "[CALENDAR-PROBE] Skipped on production launch (set NEXT_PUBLIC_CALENDAR_PROBE=1 to run).",
        );
      }
      return;
    }

    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    if (Notification.permission === "denied") return;
    registerPush();
  }, []);

  return null;
}

async function registerPush() {
  try {
    const publicKey = await fetchVapidKey();
    if (!publicKey) return;

    const headers = authHeaders();
    if (!headers.Authorization) return;

    const reg = await getSwRegistration();
    const existing = await reg.pushManager.getSubscription();
    if (!existing && Notification.permission === "default") {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return;
    }

    const subscription = await getOrCreatePushSubscription(reg, publicKey);
    await registerSubscriptionWithServer(subscription);
    sendSwConfig(reg);
  } catch (err) {
    console.error("[PUSH] Registration failed:", err);
  }
}
