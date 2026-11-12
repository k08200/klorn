import { API_BASE, authHeaders } from "./api";

export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

/** Get the /sw.js registration, registering it if absent. Prefers the explicit
 *  /sw.js registration over navigator.serviceWorker.ready because .ready can
 *  resolve to a Next.js SW that has no push event handler. */
export async function getSwRegistration(): Promise<ServiceWorkerRegistration> {
  let reg = await navigator.serviceWorker.getRegistration("/");
  if (!reg) {
    reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
  }
  return reg;
}

/** True when this browser holds a push subscription on the /sw.js
 *  registration: the service worker then shows each Web Push itself. Never
 *  registers or subscribes. A failed lookup reads as false, so the tab shows
 *  the interrupt rather than risk showing nothing; it carries the same OS tag
 *  as the service worker's notification for that row. */
export async function hasPushSubscription(): Promise<boolean> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return false;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    if (!reg?.pushManager) return false;
    return (await reg.pushManager.getSubscription()) !== null;
  } catch (err) {
    console.warn("[PUSH] subscription lookup failed:", err);
    return false;
  }
}

export async function fetchVapidKey(): Promise<string | null> {
  const res = await fetch(`${API_BASE}/api/notifications/vapid-key`, { headers: authHeaders() });
  if (!res.ok) return null;
  const { publicKey } = (await res.json()) as { publicKey?: string };
  return publicKey ?? null;
}

export async function getOrCreatePushSubscription(
  reg: ServiceWorkerRegistration,
  vapidKey: string,
): Promise<PushSubscription> {
  const existing = await reg.pushManager.getSubscription();
  if (existing) return existing;
  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidKey).buffer as ArrayBuffer,
  });
}

/**
 * A stable per-browser id so the backend can prune THIS browser's previous
 * push-subscription row when its endpoint rotates — otherwise the old row
 * lingers and a single notification is delivered twice. Persisted in
 * localStorage (per-origin, shared across SW scopes), regenerated only if
 * cleared. Returns undefined when storage is unavailable (private mode); the
 * server then falls back to legacy, no-prune behavior.
 */
export function getPushDeviceId(): string | undefined {
  try {
    const KEY = "klorn_push_device_id";
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return undefined;
  }
}

export async function registerSubscriptionWithServer(
  sub: PushSubscription,
  opts: { resubscribed?: boolean } = {},
): Promise<void> {
  const subJson = sub.toJSON();
  // window.location.origin tells the backend which SW owns this sub so it can
  // refuse to push to subs from retired origins (see api/push-origin-allowlist).
  const res = await fetch(`${API_BASE}/api/notifications/push/subscribe`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      endpoint: subJson.endpoint,
      keys: subJson.keys,
      origin: window.location.origin,
      deviceId: getPushDeviceId(),
      ...(opts.resubscribed ? { resubscribed: true } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Server registration failed: ${res.status}`);
}

export type ResubscribeResult = "ok" | "permission" | "unsupported" | "failed";

/**
 * "Turn alerts back on" for a subscription the server flagged as a zombie
 * (pushes accepted, none confirmed by this browser). Drops this browser's
 * subscription and makes a fresh one — subscribe() alone would hand back the
 * same endpoint — and tells the server it was deliberate (`resubscribed`),
 * which lifts the flag. Run from a click. It never asks for permission
 * (#1716): with no granted permission it returns "permission" and changes
 * nothing. Everything that can fail before the old subscription is dropped
 * runs first; a failed subscribe after it is retried once, and is otherwise
 * repaired by the next app load (PushRegister) — the old endpoint was dead.
 */
export async function resubscribeThisBrowser(): Promise<ResubscribeResult> {
  if (typeof Notification === "undefined" || !("serviceWorker" in navigator)) {
    return "unsupported";
  }
  if (Notification.permission !== "granted") return "permission";
  const reg = await getSwRegistration();
  const vapidKey = await fetchVapidKey();
  if (!vapidKey || !reg.pushManager) return "unsupported";
  const options: PushSubscriptionOptionsInit = {
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidKey).buffer as ArrayBuffer,
  };
  const old = await reg.pushManager.getSubscription();
  if (old) await old.unsubscribe();
  let sub: PushSubscription;
  try {
    sub = await reg.pushManager.subscribe(options);
  } catch (first) {
    console.warn("[PUSH] re-subscribe failed once, retrying:", first);
    try {
      sub = await reg.pushManager.subscribe(options);
    } catch (err) {
      console.error("[PUSH] re-subscribe failed:", err);
      return "failed";
    }
  }
  try {
    await registerSubscriptionWithServer(sub, { resubscribed: true });
  } catch (err) {
    console.error("[PUSH] re-subscribe registration failed:", err);
    return "failed";
  }
  sendSwConfig(reg);
  return "ok";
}

/**
 * Hand the SW the rotate-endpoint URL so its `pushsubscriptionchange`
 * handler can re-register a swapped subscription while the app is closed.
 * No tokens cross this boundary — the old endpoint is the capability.
 */
export function sendSwConfig(reg: ServiceWorkerRegistration): void {
  const target = reg.active ?? reg.waiting ?? reg.installing;
  target?.postMessage({
    type: "klorn-config",
    rotateUrl: `${API_BASE}/api/notifications/push/rotate`,
  });
}

export async function unregisterPushSubscription(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const { endpoint } = sub;
  await sub.unsubscribe();
  await fetch(`${API_BASE}/api/notifications/push/unsubscribe`, {
    method: "DELETE",
    headers: authHeaders(),
    body: JSON.stringify({ endpoint }),
  });
}
