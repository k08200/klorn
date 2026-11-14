"use client";

/**
 * Footer of the bell panel: "Where you get alerts" in one line — a dot and a
 * status word per channel, read from the existing endpoint list
 * (GET /api/notifications/alert-endpoints, the same call Settings makes).
 * The dot repeats the words; colour is never the only signal. On a failed
 * load the strip keeps only the title and the settings link.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  type AlertEndpointList,
  type AlertStripItem,
  type AlertTone,
  alertStripItems,
} from "../../lib/alert-devices";
import { apiFetch } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { getPushDeviceId } from "../../lib/push";

const ENDPOINTS_PATH = "/api/notifications/alert-endpoints";
const SETTINGS_HREF = "/settings/notifications";

const DOT: Record<AlertTone, string> = {
  ok: "bg-state-ok-ink",
  warn: "bg-state-warn-ink",
  neutral: "bg-ink-dim",
  off: "border border-ink-dim bg-transparent",
};

export function AlertStrip({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useT();
  const [items, setItems] = useState<AlertStripItem[] | null>(null);

  useEffect(() => {
    let live = true;
    const deviceId = getPushDeviceId();
    apiFetch<AlertEndpointList>(ENDPOINTS_PATH, {
      headers: deviceId ? { "X-Push-Device": deviceId } : {},
    })
      .then((list) => {
        if (live) setItems(alertStripItems(list));
      })
      .catch((err: unknown) => {
        console.error("[notification-center] alert endpoints load failed:", err);
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="flex items-center gap-3 border-t border-line bg-surface-inset px-4 py-2.5 text-role-caption text-ink-soft">
      <span className="shrink-0 font-semibold">{t("notifCenter.strip.title")}</span>
      <ul className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
        {items?.map((item) => (
          <li key={item.id} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={`size-1.5 shrink-0 rounded-full ${DOT[item.tone]}`}
            />
            <span>{t(item.name.key, item.name.params)}</span>
            <span className="text-ink-muted">{t(item.statusKey)}</span>
          </li>
        ))}
      </ul>
      <Link
        href={SETTINGS_HREF}
        onClick={onNavigate}
        className="focus-ring inline-flex shrink-0 items-center rounded-chip text-accent-deep hover:underline pointer-coarse:min-h-11"
      >
        {t("notifCenter.strip.settings")}
      </Link>
    </div>
  );
}
