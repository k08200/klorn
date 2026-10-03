"use client";

import { useEffect, useState } from "react";
import { useToast } from "../../../components/toast";
import Button from "../../../components/ui/button";
import Switch from "../../../components/ui/switch";
import { apiFetch } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import { track } from "../../../lib/track";
import { NotificationLanguageRow } from "./notification-language-row";
import { PANEL, SECTION_TITLE } from "./shared";
import { useAutomationConfig } from "./use-automation-config";
import { useProfile } from "./use-profile";
import { usePush } from "./use-push";

export function NotificationsSection() {
  const config = useAutomationConfig();
  const { profile } = useProfile(config);
  const { pushStatus, enablePush, disablePush } = usePush();
  const [dailyBriefingEnabled, setDailyBriefingEnabled] = useState(true);
  const [briefingTime, setBriefingTime] = useState("06:00");
  const [phoneEscalationEnabled, setPhoneEscalationEnabled] = useState(false);
  const [notifPrefs, setNotifPrefs] = useState({
    notifyEmailUrgent: true,
    notifyMeeting: true,
    notifyTaskDue: true,
    notifyAgentProposal: true,
    notifyDailyBriefing: true,
    notifyEmailCandidate: true,
    quietHoursStart: "" as string | null,
    quietHoursEnd: "" as string | null,
  });
  const { toast } = useToast();
  const { t } = useT();

  useEffect(() => {
    if (!config) return;
    const d = config;
    setPhoneEscalationEnabled(d.phoneEscalationEnabled ?? false);
    setDailyBriefingEnabled(d.dailyBriefing ?? true);
    setBriefingTime(d.briefingTime ?? "06:00");
    setNotifPrefs({
      notifyEmailUrgent: d.notifyEmailUrgent ?? true,
      notifyMeeting: d.notifyMeeting ?? true,
      notifyTaskDue: d.notifyTaskDue ?? true,
      notifyAgentProposal: d.notifyAgentProposal ?? true,
      notifyDailyBriefing: d.notifyDailyBriefing ?? true,
      notifyEmailCandidate: d.notifyEmailCandidate ?? true,
      quietHoursStart: d.quietHoursStart ?? null,
      quietHoursEnd: d.quietHoursEnd ?? null,
    });
  }, [config]);

  const updatePhoneEscalation = async (value: boolean) => {
    setPhoneEscalationEnabled(value);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ phoneEscalationEnabled: value }),
      });
      toast(
        value
          ? t("settings.toast.phoneEscalationEnabled")
          : t("settings.toast.phoneEscalationDisabled"),
        "success",
      );
    } catch {
      setPhoneEscalationEnabled(!value);
      toast(t("settings.toast.settingSaveFailed"), "error");
    }
  };

  const updateNotifPref = async (key: keyof typeof notifPrefs, value: boolean | string | null) => {
    const next = { ...notifPrefs, [key]: value };
    setNotifPrefs(next);
    // Retention analytics: a category toggled OFF is a partial mute signal.
    if (value === false) track("notif_muted", { scope: key });
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ [key]: value }),
      });
    } catch {
      toast(t("settings.toast.settingSaveFailed"), "error");
    }
  };

  /** One click for "only the things that actually need me": urgent mail and
   *  calendar. Matches the desktop app's Essentials-only preset — reaching the
   *  same state on the web meant toggling five checkboxes in the right order. */
  const applyEssentialsOnly = async () => {
    const next = {
      ...notifPrefs,
      notifyEmailUrgent: true,
      notifyMeeting: true,
      notifyTaskDue: false,
      notifyAgentProposal: false,
      notifyDailyBriefing: false,
      notifyEmailCandidate: false,
    };
    const previous = notifPrefs;
    setNotifPrefs(next);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({
          notifyEmailUrgent: true,
          notifyMeeting: true,
          notifyTaskDue: false,
          notifyAgentProposal: false,
          notifyDailyBriefing: false,
          notifyEmailCandidate: false,
        }),
      });
    } catch {
      setNotifPrefs(previous);
      toast(t("settings.toast.presetFailed"), "error");
    }
  };

  const updateDailyBriefing = async (enabled: boolean) => {
    setDailyBriefingEnabled(enabled);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ dailyBriefing: enabled }),
      });
      toast(
        enabled ? t("settings.toast.briefingEnabled") : t("settings.toast.briefingDisabled"),
        "success",
      );
    } catch {
      setDailyBriefingEnabled(!enabled);
      toast(t("settings.toast.briefingSaveFailed"), "error");
    }
  };

  const updateBriefingTime = async (value: string) => {
    setBriefingTime(value);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ briefingTime: value, timezone: profile.timezone }),
      });
      toast(t("settings.toast.briefingTimeSaved"), "success");
    } catch {
      toast(t("settings.toast.briefingTimeSaveFailed"), "error");
    }
  };

  return (
    <section className="mb-8">
      <h2 className={SECTION_TITLE}>{t("settings.section.signalRhythm")}</h2>
      <div className={`${PANEL} divide-y divide-line-soft`}>
        <div className="p-5 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="font-medium">{t("settings.morningBriefing.title")}</h3>
              <p className="text-sm text-ink-mid">{t("settings.morningBriefing.desc")}</p>
              <p className="mt-1 text-xs text-ink-dim">
                {t("settings.morningBriefing.timezoneNote", { timezone: profile.timezone })}
              </p>
            </div>
            <Switch
              checked={dailyBriefingEnabled}
              onChange={(next) => updateDailyBriefing(next)}
              label={t("settings.morningBriefing.title")}
              hideLabel
              className="shrink-0"
            />
          </div>
          <div className="flex items-center gap-3 border-t border-line-soft pt-3">
            <label htmlFor="briefing-time" className="text-sm font-medium text-ink">
              {t("settings.field.deliveryTime")}
            </label>
            <input
              id="briefing-time"
              type="time"
              value={briefingTime}
              disabled={!dailyBriefingEnabled}
              onChange={(e) => updateBriefingTime(e.target.value)}
              className="min-h-11 rounded border border-line bg-surface-raised px-3 py-2 text-sm text-ink disabled:opacity-50"
            />
            <span className="text-xs text-ink-dim">{t("settings.deliveryTime.defaultNote")}</span>
          </div>
        </div>
        <div className="p-5 flex items-center justify-between gap-4">
          <div>
            <h3 className="font-medium">{t("settings.pushNotifications.title")}</h3>
            <p className="text-sm text-ink-mid">
              {pushStatus === "unsupported"
                ? t("settings.pushNotifications.unsupported")
                : pushStatus === "granted"
                  ? t("settings.pushNotifications.on")
                  : pushStatus === "denied"
                    ? t("settings.pushNotifications.blocked")
                    : t("settings.pushNotifications.off")}
            </p>
          </div>
          {pushStatus === "unsupported" || pushStatus === "denied" ? (
            <span className="text-sm text-ink-dim bg-surface-raised px-3 py-1.5 rounded-lg border border-line">
              {pushStatus === "denied"
                ? t("settings.pushNotifications.blockedChip")
                : t("settings.pushNotifications.unsupportedChip")}
            </span>
          ) : pushStatus === "granted" ? (
            <Button variant="secondary" onClick={disablePush}>
              {t("settings.turnOff")}
            </Button>
          ) : (
            <Button onClick={enablePush}>{t("settings.turnOn")}</Button>
          )}
        </div>

        {/* Granular Notification Preferences */}
        <div className="p-5 space-y-3">
          <fieldset className="space-y-2">
            <legend className="w-full">
              <span className="block font-medium text-ink">{t("settings.notifPrefs.legend")}</span>
              <span className="mt-0.5 block text-xs text-ink-mid">
                {t("settings.notifPrefs.legendDesc")}
              </span>
            </legend>
            <div className="flex flex-wrap items-center gap-2 pb-2">
              <button
                type="button"
                onClick={applyEssentialsOnly}
                aria-pressed={
                  notifPrefs.notifyEmailUrgent &&
                  notifPrefs.notifyMeeting &&
                  !notifPrefs.notifyTaskDue &&
                  !notifPrefs.notifyAgentProposal &&
                  !notifPrefs.notifyDailyBriefing &&
                  !notifPrefs.notifyEmailCandidate
                }
                className="ease-strong min-h-11 rounded-lg border border-line-strong px-3 py-2 text-sm text-ink-soft transition duration-150 hover:bg-surface-hover active:scale-[0.97] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 aria-pressed:border-accent aria-pressed:text-accent-deep"
              >
                {t("settings.notifPrefs.essentialsOnly")}
              </button>
              <span className="text-xs text-ink-mid">
                {t("settings.notifPrefs.essentialsOnlyDesc")}
              </span>
            </div>
            {[
              {
                key: "notifyEmailUrgent" as const,
                label: t("settings.notifPrefs.urgentMail.label"),
                desc: t("settings.notifPrefs.urgentMail.desc"),
              },
              {
                key: "notifyMeeting" as const,
                label: t("settings.notifPrefs.meeting.label"),
                desc: t("settings.notifPrefs.meeting.desc"),
              },
              {
                key: "notifyTaskDue" as const,
                label: t("settings.notifPrefs.taskDue.label"),
                desc: t("settings.notifPrefs.taskDue.desc"),
              },
              {
                key: "notifyAgentProposal" as const,
                label: t("settings.notifPrefs.agentProposal.label"),
                desc: t("settings.notifPrefs.agentProposal.desc"),
              },
              {
                key: "notifyDailyBriefing" as const,
                label: t("settings.notifPrefs.dailyBriefing.label"),
                desc: t("settings.notifPrefs.dailyBriefing.desc"),
              },
            ].map((row) => (
              <label
                key={row.key}
                className="flex items-start gap-3 py-2 cursor-pointer hover:bg-surface-hover rounded-lg px-2 transition"
              >
                <input
                  type="checkbox"
                  checked={notifPrefs[row.key]}
                  onChange={(e) => updateNotifPref(row.key, e.target.checked)}
                  className="mt-0.5 w-4 h-4 rounded border-line-strong bg-surface-raised text-accent-deep focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 focus-visible:ring-offset-1 focus-visible:ring-offset-white"
                />
                <div className="flex-1">
                  <p className="text-sm font-medium text-ink">{row.label}</p>
                  <p className="text-xs text-ink-mid">{row.desc}</p>
                </div>
              </label>
            ))}
          </fieldset>
          <div className="pt-3 border-t border-line-soft">
            <p className="text-sm font-medium text-ink mb-1">{t("settings.quietHours.title")}</p>
            <p className="text-xs text-ink-mid mb-3">{t("settings.quietHours.desc")}</p>
            <div className="flex items-center gap-3">
              <label htmlFor="quiet-hours-start" className="sr-only">
                {t("settings.quietHours.startSrLabel")}
              </label>
              <input
                id="quiet-hours-start"
                type="time"
                aria-label={t("settings.quietHours.startAriaLabel")}
                value={notifPrefs.quietHoursStart || ""}
                onChange={(e) => updateNotifPref("quietHoursStart", e.target.value || null)}
                className="min-h-11 rounded border border-line bg-surface-raised px-2 py-1 text-sm text-ink focus:outline-none focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent/25"
              />
              <span className="text-ink-mid text-sm">{t("settings.quietHours.to")}</span>
              <label htmlFor="quiet-hours-end" className="sr-only">
                {t("settings.quietHours.endSrLabel")}
              </label>
              <input
                id="quiet-hours-end"
                type="time"
                aria-label={t("settings.quietHours.endAriaLabel")}
                value={notifPrefs.quietHoursEnd || ""}
                onChange={(e) => updateNotifPref("quietHoursEnd", e.target.value || null)}
                className="min-h-11 rounded border border-line bg-surface-raised px-2 py-1 text-sm text-ink focus:outline-none focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent/25"
              />
            </div>
          </div>
          <div className="pt-3 border-t border-line-soft">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-ink">
                  {t("settings.phoneEscalation.title")}
                </p>
                <p className="text-xs text-ink-dim mt-1">{t("settings.phoneEscalation.desc")}</p>
              </div>
              <Switch
                checked={phoneEscalationEnabled}
                onChange={(next) => updatePhoneEscalation(next)}
                label={t("settings.phoneEscalation.title")}
                hideLabel
                className="shrink-0"
              />
            </div>
          </div>
        </div>
        <NotificationLanguageRow config={config} />
      </div>
    </section>
  );
}
