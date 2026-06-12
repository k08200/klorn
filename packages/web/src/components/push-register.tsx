"use client";

import { useEffect } from "react";
import { authHeaders, getStoredAuthToken } from "../lib/api";
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
