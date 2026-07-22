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

/**
 * A stable per-browser id so the backend can prune THIS browser's previous
 * push-subscription row when its endpoint rotates — otherwise the old row
 * lingers and a single notification is delivered twice. Persisted in
 * localStorage (per-origin, shared across SW scopes), regenerated only if
 * cleared. Returns undefined when storage is unavailable (private mode); the
 * server then falls back to legacy, no-prune behavior.
 */
function getPushDeviceId(): string | undefined {
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
      deviceId: getPushDeviceId(),
    }),
  });
  if (!res.ok) throw new Error(`Server registration failed: ${res.status}`);
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
