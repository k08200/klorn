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

export async function registerSubscriptionWithServer(sub: PushSubscription): Promise<void> {
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
    }),
  });
  if (!res.ok) throw new Error(`Server registration failed: ${res.status}`);
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
