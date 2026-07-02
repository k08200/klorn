"use client";

import { useEffect } from "react";
import { authHeaders, getStoredAuthToken } from "../lib/api";
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
    // just be a redundant channel. (The on-device calendar probe was removed:
    // requesting calendar permission with no user-facing feature is an App
    // Store 5.1.1 risk. It returns with the native calendar feature.)
    if (isNativePlatform()) {
      void registerNativePush();
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
