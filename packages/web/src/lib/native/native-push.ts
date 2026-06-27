// Native push registration for the Capacitor shell (FCM).
//
// On the native app the browser Web Push APIs are unreliable (iOS WKWebView has
// none), so instead of pushManager.subscribe() we register with the OS for an
// FCM token and send it to the backend (DevicePushToken). The backend delivers
// via firebase-admin → FCM → APNs/Android. Guarded by the caller; on the web
// this file is never reached.

import { API_BASE, authHeaders } from "../api";
import { captureClientError } from "../sentry";
import { nativePlatform } from "./capacitor";

const TOKEN_REGISTER_TIMEOUT_MS = 30_000;

export async function registerNativePush(): Promise<void> {
  const platform = nativePlatform();
  if (!platform) return; // not native — nothing to do

  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");

    const perm = await PushNotifications.requestPermissions();
    if (perm.receive !== "granted") {
      console.warn("[PUSH-DEVICE] Native push permission not granted");
      return;
    }

    // Clear any listeners from a prior mount so the token isn't re-sent once per
    // accumulated listener on the next 'registration' event.
    await PushNotifications.removeAllListeners();

    // The FCM token arrives asynchronously on the 'registration' event.
    await PushNotifications.addListener("registration", (tokenData) => {
      void sendTokenToServer(tokenData.value, platform);
    });
    await PushNotifications.addListener("registrationError", (err) => {
      console.error("[PUSH-DEVICE] Native push registration error:", err);
    });

    await PushNotifications.register();
  } catch (err) {
    // requestPermissions()/register() can throw on some OS versions. The caller
    // fires this as `void`, so an uncaught throw would vanish — log it instead,
    // or native push silently never works with no trace.
    console.error("[PUSH-DEVICE] registerNativePush failed:", err);
  }
}

async function sendTokenToServer(token: string, platform: "ios" | "android"): Promise<void> {
  // Bound the request — on mobile a stalled network can hang this fire-and-forget
  // call forever, leaving the device silently unregistered.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_REGISTER_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/api/notifications/push/device-token/register`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ token, platform }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`register failed: ${res.status}`);
  } catch (err) {
    // Don't swallow: a token that never reaches the server means silent
    // "notifications don't work". console (always-on) + Sentry (alerting).
    console.error("[PUSH-DEVICE] Failed to register device token with server:", err);
    captureClientError(err, { context: "native-push.sendTokenToServer", platform });
  } finally {
    clearTimeout(timer);
  }
}
