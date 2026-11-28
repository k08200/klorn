"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { authHeaders, getStoredAuthToken } from "../lib/api";
import { useAuth } from "../lib/auth";
import { isNativePlatform } from "../lib/native/capacitor";
import {
  fetchVapidKey,
  getOrCreatePushSubscription,
  getSwRegistration,
  registerSubscriptionWithServer,
  sendSwConfig,
} from "../lib/push";

// The Capacitor shell's push layer (priming, banner, actions) — its own chunk,
// never loaded on the web.
const NativePushLayer = dynamic(() => import("../lib/native/native-push-layer"), { ssr: false });

export default function PushRegister() {
  const { token } = useAuth();
  // Native shell: FCM/APNs (native push), not Web Push — iOS WKWebView has no
  // usable Web Push and on Android a web subscription would just be a
  // redundant channel. Mounted once signed in; the layer asks for permission
  // only from its priming screen. (The on-device calendar probe was removed:
  // requesting calendar permission with no user-facing feature is an App Store
  // 5.1.1 risk. It returns with the native calendar feature.)
  const [native, setNative] = useState(false);
  useEffect(() => {
    setNative(isNativePlatform());
  }, []);

  useEffect(() => {
    if (isNativePlatform()) return;
    if (!getStoredAuthToken()) return;

    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    // Never prompt on page load: there is no user gesture here, and browsers
    // ignore or auto-deny such a prompt (Chrome then quiets the site's prompts).
    // The prompt comes from a click — the push onboarding banner's Enable or the
    // Settings toggle. This only refreshes a subscription the user granted.
    if (Notification.permission !== "granted") return;
    registerPush();
  }, []);

  return native && token ? <NativePushLayer /> : null;
}

async function registerPush() {
  try {
    const publicKey = await fetchVapidKey();
    if (!publicKey) return;

    const headers = authHeaders();
    if (!headers.Authorization) return;

    const reg = await getSwRegistration();
    const subscription = await getOrCreatePushSubscription(reg, publicKey);
    await registerSubscriptionWithServer(subscription);
    sendSwConfig(reg);
  } catch (err) {
    console.error("[PUSH] Registration failed:", err);
  }
}
