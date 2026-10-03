"use client";

import { useEffect, useState } from "react";
import { useToast } from "../../../components/toast";
import { useT } from "../../../lib/i18n";
import {
  fetchVapidKey,
  getOrCreatePushSubscription,
  getSwRegistration,
  registerSubscriptionWithServer,
  unregisterPushSubscription,
} from "../../../lib/push";
import { track } from "../../../lib/track";

export function usePush() {
  const [pushStatus, setPushStatus] = useState<"unsupported" | "default" | "granted" | "denied">(
    "default",
  );
  const { toast } = useToast();
  const { t } = useT();

  // Check push notification support and permission, auto-repair if granted but no subscription
  useEffect(() => {
    if (!("Notification" in window) || !("PushManager" in window)) {
      setPushStatus("unsupported");
      return;
    }
    const perm = Notification.permission as "default" | "granted" | "denied";
    setPushStatus(perm);

    // If permission is granted, ensure subscription exists (auto-repair)
    if (perm === "granted" && "serviceWorker" in navigator) {
      (async () => {
        try {
          const publicKey = await fetchVapidKey();
          if (!publicKey) return;
          const reg = await getSwRegistration();
          const sub = await getOrCreatePushSubscription(reg, publicKey);
          await registerSubscriptionWithServer(sub).catch(() => {});
        } catch (err) {
          console.error("[PUSH-REPAIR] Error:", err);
        }
      })();
    }
  }, []);

  const enablePush = async () => {
    if (!("Notification" in window)) {
      toast(t("settings.toast.pushUnsupported"), "error");
      return;
    }
    const permission = await Notification.requestPermission();
    setPushStatus(permission as "granted" | "denied" | "default");
    if (permission === "granted") {
      try {
        const publicKey = await fetchVapidKey();
        if (publicKey) {
          const reg = await getSwRegistration();
          const sub = await getOrCreatePushSubscription(reg, publicKey);
          await registerSubscriptionWithServer(sub);
          toast(t("settings.toast.pushEnabled"), "success");
        }
      } catch (err) {
        console.error("[PUSH-SETTINGS] Error:", err);
        toast(t("settings.toast.pushRegistrationFailed"), "error");
      }
    } else if (permission === "denied") {
      toast(t("settings.toast.pushBlocked"), "error");
    }
  };

  const disablePush = async () => {
    await unregisterPushSubscription();
    setPushStatus("default");
    // Retention analytics: turning push off entirely is the strongest churn
    // signal — track it so the dashboard surfaces mute rate.
    track("notif_muted", { scope: "all" });
    toast(t("settings.toast.pushDisabled"), "info");
  };

  return { pushStatus, enablePush, disablePush };
}
