/**
 * Native push (@capacitor/push-notifications): FCM token on Android, raw APNs
 * token on iOS, registered with POST /api/notifications/push/device-token/
 * register (routes/notifications.ts). The OS prompt is asked only from the
 * priming screen (push/PushPriming.tsx), never on launch. On the web (dev,
 * Playwright) push is "unsupported" and nothing here runs.
 */
import { actionFromTap } from "../push/route";
import { kv } from "./kv";
import { isNative, platformName } from "./native";

export type PushPermission = "granted" | "denied" | "prompt" | "unsupported";

const TOKEN_KEY = "klorn-push-token";
const PRIMED_KEY = "klorn-push-primed";

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

export async function pushPermission(): Promise<PushPermission> {
  if (!isNative()) return "unsupported";
  try {
    const { receive } = await (await plugin()).checkPermissions();
    if (receive === "granted") return "granted";
    if (receive === "denied") return "denied";
    return "prompt";
  } catch {
    return "unsupported";
  }
}

/**
 * Ask (when `prompt`), then register and hand the token to the server.
 * Resolves with the permission the OS answered.
 */
export async function enablePush(
  sendToken: (token: string, platform: "ios" | "android") => Promise<unknown>,
  { prompt }: { prompt: boolean },
): Promise<PushPermission> {
  const platform = platformName();
  if (platform === "web") return "unsupported";
  try {
    const push = await plugin();
    let state = (await push.checkPermissions()).receive;
    if (state !== "granted" && prompt) state = (await push.requestPermissions()).receive;
    if (state !== "granted") return state === "denied" ? "denied" : "prompt";
    const registration = await push.addListener("registration", (token) => {
      void kv.setItem(TOKEN_KEY, token.value);
      void sendToken(token.value, platform).catch(() => {});
      void registration.remove();
    });
    await push.register();
    return "granted";
  } catch {
    return "unsupported";
  }
}

/** Sign-out: tell the server to stop pushing to this device (best effort). */
export async function forgetPushToken(
  unregister: (token: string) => Promise<unknown>,
): Promise<void> {
  const token = await kv.getItem(TOKEN_KEY);
  if (!token) return;
  await unregister(token).catch(() => {});
  await kv.removeItem(TOKEN_KEY);
}

export async function wasPrimed(): Promise<boolean> {
  return (await kv.getItem(PRIMED_KEY)) !== null;
}

export async function markPrimed(answer: "enabled" | "later"): Promise<void> {
  await kv.setItem(PRIMED_KEY, answer);
}

/** Taps (and iOS action buttons) and deliveries the app sees. Returns the unsubscribe. */
export function installPushListeners(handlers: {
  onAction: (actionId: string, push: IncomingPush) => void;
  onForeground: (push: IncomingPush) => void;
}): () => void {
  if (!isNative()) return () => {};
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
      // Android: fires for notification messages in the foreground and for
      // data-only messages whenever the app's process (and so the WebView) is
      // alive — foreground or background. iOS: foreground deliveries.
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
    .catch(() => {});
  return () => {
    alive = false;
    for (const r of removers) r();
  };
}
