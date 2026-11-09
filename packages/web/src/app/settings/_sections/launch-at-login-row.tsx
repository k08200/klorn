"use client";

import { useEffect, useState } from "react";
import { useToast } from "../../../components/toast";
import Switch from "../../../components/ui/switch";
import { useT } from "../../../lib/i18n";
import { shellKind } from "../../../lib/native/shell";
import {
  isAutostartEnabled,
  setAutostart,
  writeAutostartAnswer,
} from "../../../lib/native/tauri-autostart";
import { captureClientError } from "../../../lib/sentry";

/**
 * Windows desktop shell only: start Klorn at sign-in (tauri-plugin-autostart).
 * Opt-in — OFF until the user turns it on here or accepts the one-time prompt
 * (components/autostart-prompt.tsx). Renders nothing outside the shell, or
 * when the shell cannot report the current state.
 */
export function LaunchAtLoginRow() {
  const { t } = useT();
  const { toast } = useToast();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (shellKind() !== "tauri") return;
    let cancelled = false;
    isAutostartEnabled()
      .then((value) => {
        if (!cancelled) setEnabled(value);
      })
      .catch((err) => console.warn("[AUTOSTART] could not read start-at-sign-in:", err));
    return () => {
      cancelled = true;
    };
  }, []);

  if (enabled === null) return null;

  const toggle = async (next: boolean) => {
    setSaving(true);
    try {
      await setAutostart(next);
      // A choice made here also answers the first-run prompt: never ask after.
      writeAutostartAnswer(next ? "accepted" : "declined");
      setEnabled(next);
    } catch (err) {
      console.error("[AUTOSTART] toggle failed:", err);
      captureClientError(err, { context: "launch-at-login-row.toggle", next });
      toast(t("settings.toast.settingSaveFailed"), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-5 flex items-start justify-between gap-4">
      <div>
        <h3 className="font-medium">{t("settings.launchAtLogin.title")}</h3>
        <p className="text-role-body text-ink-mid">{t("settings.launchAtLogin.desc")}</p>
      </div>
      <Switch
        checked={enabled}
        onChange={(next) => void toggle(next)}
        label={t("settings.launchAtLogin.title")}
        hideLabel
        disabled={saving}
        className="shrink-0"
      />
    </div>
  );
}
