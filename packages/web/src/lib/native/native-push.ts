// Native push for the Capacitor shell (FCM on Android, raw APNs on iOS) —
// parity with apps/mobile/src/platform/push.ts.
//
// On the native app the browser Web Push APIs are unreliable (iOS WKWebView
// has none), so instead of pushManager.subscribe() we register with the OS for
// a token and send it to the backend (POST /api/notifications/push/
// device-token/register). The OS prompt is asked only from the priming screen
// (native-push-layer.tsx), never on launch. The token and the "primed" answer
// live in Capacitor Preferences under the old app's keys, so an upgrade from
// that app neither re-asks nor loses the token to unregister on sign-out.
// Guarded by the caller; on the web this file is never loaded.

import { API_BASE, authHeaders } from "../api";
import { captureClientError } from "../sentry";
import { nativePlatform } from "./capacitor";
import { actionFromTap } from "./push-intent";

const TOKEN_REGISTER_TIMEOUT_MS = 30_000;
const TOKEN_KEY = "klorn-push-token";
const PRIMED_KEY = "klorn-push-primed";

export type PushPermission = "granted" | "denied" | "prompt" | "unsupported";

export interface IncomingPush {
  title: string;
  body: string;
  data: Record<string, unknown>;
  /** The FCM / APNs message id, when the plugin reports one. */
  id?: string;
  /** No notification block (FCM data-only): nothing was shown by the OS. */
  dataOnly?: boolean;
}

async function plugin() {
  const { PushNotifications } = await import("@capacitor/push-notifications");
  return PushNotifications;
}

/** Non-secret native key/value (Capacitor Preferences, the old app's store). */
export const prefs = {
  async get(key: string): Promise<string | null> {
    const { Preferences } = await import("@capacitor/preferences");
    return (await Preferences.get({ key })).value;
  },
  async set(key: string, value: string): Promise<void> {
    const { Preferences } = await import("@capacitor/preferences");
    await Preferences.set({ key, value });
  },
  async remove(key: string): Promise<void> {
    const { Preferences } = await import("@capacitor/preferences");
    await Preferences.remove({ key });
  },
};

export async function pushPermission(): Promise<PushPermission> {
  if (!nativePlatform()) return "unsupported";
  try {
    const { receive } = await (await plugin()).checkPermissions();
    if (receive === "granted") return "granted";
    if (receive === "denied") return "denied";
    return "prompt";
  } catch (err) {
    console.warn("[PUSH-DEVICE] checkPermissions failed:", err);
    return "unsupported";
  }
}

/**
 * Ask the OS (only when `prompt` — the priming screen's Enable), then register
 * and hand the token to the server. Resolves with what the OS answered.
 * Tokens rotate, so a granted device re-registers silently on every launch.
 */
export async function enableNativePush({ prompt }: { prompt: boolean }): Promise<PushPermission> {
  const platform = nativePlatform();
  if (!platform) return "unsupported";
  try {
    const push = await plugin();
    let state = (await push.checkPermissions()).receive;
    if (state !== "granted" && prompt) state = (await push.requestPermissions()).receive;
    if (state !== "granted") return state === "denied" ? "denied" : "prompt";
    // One-shot listeners, both removed whichever way registration ends.
    const handles: Array<{ remove: () => Promise<void> }> = [];
    const done = () => {
      for (const h of handles.splice(0)) void h.remove();
    };
    handles.push(
      await push.addListener("registration", (token) => {
        done();
        void prefs
          .set(TOKEN_KEY, token.value)
          .catch((err) => console.warn("[PUSH-DEVICE] token not saved:", err));
        void sendTokenToServer(token.value, platform);
      }),
      await push.addListener("registrationError", (err) => {
        done();
        console.error("[PUSH-DEVICE] Native push registration error:", err);
      }),
    );
    try {
      await push.register();
    } catch (err) {
      done();
      throw err;
    }
    return "granted";
  } catch (err) {
    // requestPermissions()/register() can throw on some OS versions; the
    // caller fires this as `void`, so log it instead of losing it.
    console.error("[PUSH-DEVICE] enableNativePush failed:", err);
    return "unsupported";
  }
}

/** Sign-out: tell the server to stop pushing to this device (best effort). */
export async function forgetNativePushToken(sessionToken: string | null): Promise<void> {
  try {
    const token = await prefs.get(TOKEN_KEY);
    if (!token || !sessionToken) return;
    const res = await fetch(`${API_BASE}/api/notifications/push/device-token`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({ token }),
      keepalive: true,
    });
    // Kept on a failure: the next sign-out tries again, and the next sign-in
    // re-registers the device to whoever signs in.
    if (!res.ok) throw new Error(`unregister failed: ${res.status}`);
    await prefs.remove(TOKEN_KEY);
  } catch (err) {
    console.warn("[PUSH-DEVICE] forgetNativePushToken failed:", err);
  }
}

export async function wasPrimed(): Promise<boolean> {
  try {
    return (await prefs.get(PRIMED_KEY)) !== null;
  } catch {
    // Unknown: do not nag.
    return true;
  }
}

export async function markPrimed(answer: "enabled" | "later"): Promise<void> {
  await prefs.set(PRIMED_KEY, answer).catch(() => {});
}

/** Taps (and iOS action buttons) and foreground deliveries. Returns the unsubscribe. */
export function installPushListeners(handlers: {
  onAction: (actionId: string, push: IncomingPush) => void;
  onForeground: (push: IncomingPush) => void;
}): () => void {
  if (!nativePlatform()) return () => {};
  let alive = true;
  const removers: Array<() => void> = [];
  void plugin()
    .then(async (push) => {
      const action = await push.addListener("pushNotificationActionPerformed", (event) => {
        const n = event.notification;
        const data = (n.data ?? {}) as Record<string, unknown>;
        // Android: a button on a notification the native service posted arrives as a "tap".
        handlers.onAction(actionFromTap(event.actionId, data), {
          title: n.title ?? "",
          body: n.body ?? "",
          data,
        });
      });
      // Android: notification messages in the foreground, and data-only
      // messages whenever the process is alive. iOS: foreground deliveries.
      const received = await push.addListener("pushNotificationReceived", (n) => {
        handlers.onForeground({
          title: n.title ?? "",
          body: n.body ?? "",
          data: (n.data ?? {}) as Record<string, unknown>,
          id: n.id || undefined,
          dataOnly: n.title == null && n.body == null,
        });
      });
      removers.push(
        () => void action.remove(),
        () => void received.remove(),
      );
      if (!alive) for (const r of removers) r();
    })
    .catch((err) => console.error("[PUSH-DEVICE] listeners failed:", err));
  return () => {
    alive = false;
    for (const r of removers) r();
  };
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
      // Android posts data-only mail pushes itself, with buttons
      // (local-notify.ts / KlornMessagingService.java), so the server may send them.
      body: JSON.stringify({
        token,
        platform,
        ...(platform === "android" ? { dataMessages: true } : {}),
      }),
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
