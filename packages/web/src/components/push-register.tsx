"use client";

import { useEffect } from "react";
import { API_BASE, authHeaders, getStoredAuthToken } from "../lib/api";

/**
 * Registers the browser for push notifications using the /sw.js service worker.
 * IMPORTANT: Must use the exact same SW registration that has the push event handler.
 */
export default function PushRegister() {
  useEffect(() => {
    if (!getStoredAuthToken()) return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      console.warn("[PUSH] SW or PushManager not available");
      return;
    }
    console.log("[PUSH] Notification.permission on mount:", Notification.permission);
    if (Notification.permission === "denied") {
      console.warn("[PUSH] Permission denied — skipping registration");
      return;
    }

    registerPush();
  }, []);

  return null;
}

async function registerPush() {
  try {
    console.log("[PUSH] Starting push registration...");

    // Get VAPID public key from server
    const res = await fetch(`${API_BASE}/api/notifications/vapid-key`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      console.warn("[PUSH] Failed to get VAPID key:", res.status);
      return;
    }
    const { publicKey } = await res.json();
    if (!publicKey) {
      console.warn("[PUSH] No VAPID public key from server");
      return;
    }
    console.log("[PUSH] Got VAPID key from server");

    // CRITICAL: Get the specific /sw.js registration, NOT just any ready SW.
    // navigator.serviceWorker.ready might return a Next.js SW that has no push handler.
    let reg = await navigator.serviceWorker.getRegistration("/");
    if (!reg) {
      console.log("[PUSH] No /sw.js registration found, registering...");
      reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
    }
    console.log("[PUSH] Using SW registration:", reg.scope, "active:", !!reg.active);

    // Check existing subscription
    let subscription = await reg.pushManager.getSubscription();
    console.log("[PUSH] Existing subscription:", subscription ? "YES" : "NO");

    if (!subscription) {
      if (Notification.permission === "default") {
        console.log("[PUSH] Requesting notification permission...");
        const permission = await Notification.requestPermission();
        console.log("[PUSH] Permission result:", permission);
        if (permission !== "granted") return;
      } else if (Notification.permission === "denied") {
        console.warn("[PUSH] Notification permission DENIED — cannot subscribe");
        return;
      }

      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });
      console.log("[PUSH] New subscription created");
    }

    // Send subscription to server (requires auth token)
    const headers = authHeaders();
    if (!headers.Authorization) {
      console.warn("[PUSH] No auth token — cannot register subscription with server");
      return;
    }
    const subJson = subscription.toJSON();
    const subRes = await fetch(`${API_BASE}/api/notifications/push/subscribe`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        endpoint: subJson.endpoint,
        keys: subJson.keys,
      }),
    });
    console.log("[PUSH] Subscription sent to server:", subRes.ok ? "OK" : subRes.status);
    if (!subRes.ok) {
      const body = await subRes.text().catch(() => "");
      console.error("[PUSH] Server registration failed:", subRes.status, body);
    }
  } catch (err) {
    console.error("[PUSH] Registration failed:", err);
  }
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    arr[i] = raw.charCodeAt(i);
  }
  return arr;
}
