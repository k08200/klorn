"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useState } from "react";
import { settingsSectionHref } from "../app/settings/sections";
import {
  ALERT_HEALTH_PATH,
  alertHealthBanner,
  type AlertHealthBanner as BannerKind,
  type ChannelHealth,
  NO_CHANNEL_DISMISS_KEY,
  parseChannelHealth,
} from "../lib/alert-health";
import { apiFetch } from "../lib/api";
import { useT } from "../lib/i18n";
import { getPushDeviceId, resubscribeThisBrowser } from "../lib/push";
import { useToast } from "./toast";
import Button from "./ui/button";

function readDismissedAt(): number | null {
  try {
    const raw = localStorage.getItem(NO_CHANNEL_DISMISS_KEY);
    const at = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

function currentPermission(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/**
 * "Can Klorn reach you outside this tab?" (GET …/alert-endpoints/health).
 *
 *   today     the warning with a link to Settings, dismissible for a week, and
 *             this browser's "turn alerts back on" when its subscription is a
 *             zombie (a click; never a permission prompt, #1716)
 *   settings  the warning only: the device list below carries the rest
 *
 * Renders nothing while loading, on any error, or against an API that does not
 * have the endpoint yet.
 */
export function AlertHealthBanner({ place }: { place: "today" | "settings" }) {
  const { t } = useT();
  const { toast } = useToast();
  const titleId = useId();
  const [health, setHealth] = useState<ChannelHealth | null>(null);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    try {
      const deviceId = getPushDeviceId();
      const raw = await apiFetch<unknown>(ALERT_HEALTH_PATH, {
        headers: deviceId ? { "X-Push-Device": deviceId } : {},
      });
      setHealth(parseChannelHealth(raw));
    } catch (err) {
      console.warn("[ALERT-HEALTH] load failed:", err);
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    setDismissedAt(readDismissedAt());
    void load();
  }, [load]);

  const kind: BannerKind = alertHealthBanner(health, {
    permission: currentPermission(),
    dismissedAt,
    now: Date.now(),
    dismissible: place === "today",
    offerResubscribe: place === "today",
  });
  if (!kind) return null;

  const dismiss = () => {
    const now = Date.now();
    try {
      localStorage.setItem(NO_CHANNEL_DISMISS_KEY, String(now));
    } catch {
      // Storage unavailable (private mode): hide it for this visit only.
    }
    setDismissedAt(now);
  };

  const resubscribe = async () => {
    setWorking(true);
    try {
      const result = await resubscribeThisBrowser();
      if (result === "ok") {
        toast(t("alertHealth.resubscribe.done"), "success");
        await load();
      } else {
        toast(t("alertHealth.resubscribe.failed"), "error");
      }
    } catch (err) {
      console.error("[ALERT-HEALTH] re-subscribe failed:", err);
      toast(t("alertHealth.resubscribe.failed"), "error");
    } finally {
      setWorking(false);
    }
  };

  const resub = kind === "resubscribe";
  return (
    <section
      aria-labelledby={titleId}
      className="rounded-card border border-notice-border bg-notice-bg p-4 text-notice-ink"
    >
      <h2 id={titleId} className="text-role-body font-semibold text-notice-ink-strong">
        {resub ? t("alertHealth.resubscribe.title") : t("alertHealth.noChannel.title")}
      </h2>
      <p className="mt-1 text-role-meta">
        {resub ? t("alertHealth.resubscribe.body") : t("alertHealth.noChannel.body")}
      </p>
      {resub && (
        <div className="mt-3">
          <Button size="sm" disabled={working} onClick={() => void resubscribe()}>
            {working ? t("alertHealth.resubscribe.working") : t("alertHealth.resubscribe.action")}
          </Button>
        </div>
      )}
      {!resub && place === "today" && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Link
            href={settingsSectionHref("notifications")}
            className="inline-flex min-h-11 items-center font-semibold text-notice-ink-strong underline underline-offset-2 transition duration-300 ease-fluid hover:no-underline focus-ring"
          >
            {t("alertHealth.noChannel.action")}
          </Link>
          <Button variant="ghost" size="sm" onClick={dismiss}>
            {t("alertHealth.noChannel.dismiss")}
          </Button>
        </div>
      )}
    </section>
  );
}
