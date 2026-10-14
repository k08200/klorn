"use client";

import { useEffect, useState } from "react";
import { useToast } from "../../../components/toast";
import { apiFetch } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import type { AutomationConfig } from "./use-automation-config";

/** The language Klorn's own notifications use — not the app or reply language. */
export function NotificationLanguageRow({ config }: { config: AutomationConfig | null }) {
  const [notificationLanguage, setNotificationLanguage] = useState("en");
  const { toast } = useToast();
  const { t } = useT();

  useEffect(() => {
    if (!config) return;
    const d = config;
    setNotificationLanguage(d.notificationLanguage ?? "en");
  }, [config]);

  const updateNotificationLanguage = async (language: string) => {
    const previous = notificationLanguage;
    setNotificationLanguage(language);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ notificationLanguage: language }),
      });
    } catch {
      setNotificationLanguage(previous);
      toast(t("settings.toast.notifLanguageFailed"), "error");
    }
  };

  return (
    <div className="p-5 space-y-3">
      <div>
        <label htmlFor="notification-language" className="font-medium block">
          {t("settings.field.notificationLanguage")}
        </label>
        <p className="text-sm text-ink-mid">{t("settings.field.notificationLanguageDesc")}</p>
      </div>
      <select
        id="notification-language"
        value={notificationLanguage}
        onChange={(e) => updateNotificationLanguage(e.target.value)}
        className="min-h-11 w-full rounded-lg border border-line-strong bg-surface-panel px-3 py-2 text-sm text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
      >
        {/* Language names name themselves, unaffected by UI locale. */}
        <option value="en">English</option>
        <option value="ko">한국어</option>
        <option value="ja">日本語</option>
        <option value="zh">中文（简体）</option>
        <option value="es">Español</option>
        <option value="fr">Français</option>
        <option value="de">Deutsch</option>
      </select>
    </div>
  );
}
